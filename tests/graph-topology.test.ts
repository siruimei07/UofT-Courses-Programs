import { describe, expect, it } from 'vitest'
import { bandOfLevel, buildTopology, collectDescendants } from '../src/graph'
import type { GraphDataset } from '../src/data/schema'
import type { Topology } from '../src/graph'
import { loadGraphDataset, syntheticDataset } from './helpers/dataset'
import { bestOf } from './helpers/graph'

const { dataset, source } = loadGraphDataset()
const { result: topology, ms: topologyMs } = bestOf(3, () => buildTopology(dataset))

const node = (topo: Topology, code: string) => {
  const index = topo.indexById.get(`UTM:${code}`)
  if (index === undefined) throw new Error(`Missing course ${code}`)
  return topo.nodes[index]
}
const edgeCodes = (topo: Topology, edges: ReadonlyArray<{ from: number; to: number }> = topo.edges) =>
  edges.map(edge => `${topo.nodes[edge.from].code}>${topo.nodes[edge.to].code}`)

/** Everything a topology says about each course, keyed by id, so two input orders can be compared. */
function byId(topo: Topology) {
  const id = (v: number) => topo.nodes[v].id
  return {
    nodes: Object.fromEntries(topo.nodes.map(n => [n.id, { band: n.band, col: n.col, lane: n.lane, order: n.order }])),
    edges: topo.edges.map(e => `${id(e.from)}>${id(e.to)}:${e.kind}`).sort(),
    excluded: topo.excludedEdges.map(e => `${id(e.from)}>${id(e.to)}:${e.kind}:${e.reason}`).sort(),
    cells: topo.cells.map(row => row.map(cell => cell.map(id))),
    lanes: topo.lanes.map(lane => ({ ...lane, nodes: lane.nodes.map(id) })),
    bands: topo.bands,
    columnCount: topo.columnCount,
  }
}

/** Deterministic Fisher-Yates (mulberry32). */
function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = items.slice()
  let state = seed >>> 0
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

describe('topology on the real UTM dataset', () => {
  it(`builds within the 150 ms budget (${source} data)`, () => {
    console.log(`[graph] buildTopology: ${topologyMs.toFixed(1)} ms for ${topology.nodes.length} courses / ${topology.edges.length} edges / ${topology.excludedEdges.length} excluded`)
    expect(topologyMs).toBeLessThan(150)
  })

  it('places every course exactly once in nodes, lanes and cells', () => {
    expect(topology.nodes).toHaveLength(dataset.courses.length)
    dataset.courses.forEach((course, index) => {
      expect(topology.indexById.get(course.id)).toBe(index)
      expect(topology.nodes[index]).toMatchObject({ index, id: course.id, code: course.code, subject: course.subject })
    })
    const inCells = topology.cells.flat(2)
    expect(inCells).toHaveLength(dataset.courses.length)
    expect(new Set(inCells).size).toBe(dataset.courses.length)
    expect(topology.lanes.flatMap(lane => lane.nodes).sort((a, b) => a - b)).toEqual(topology.nodes.map(n => n.index))
  })

  it('keeps every course in the band of its own level, with consistent cells and lanes', () => {
    expect(topology.cells).toHaveLength(topology.lanes.length)
    topology.cells.forEach((row, lane) => {
      expect(row).toHaveLength(topology.columnCount)
      row.forEach((cell, col) => cell.forEach((v, order) => {
        expect(topology.nodes[v]).toMatchObject({ lane, col, order })
      }))
    })
    for (const n of topology.nodes) {
      expect(topology.lanes[n.lane].subject).toBe(n.subject)
      expect(n.band).toBe(bandOfLevel(n.level))
      const band = topology.bands[n.band]
      expect(n.col).toBeGreaterThanOrEqual(band.startCol)
      expect(n.col).toBeLessThanOrEqual(band.endCol)
    }
  })

  it('draws every layout edge strictly left to right, never inside one column or towards a lower band', () => {
    expect(topology.edges.length).toBeGreaterThan(4000)
    const bad = topology.edges.filter(({ from, to }) => topology.nodes[from].col >= topology.nodes[to].col)
    expect(edgeCodes(topology, bad)).toEqual([])
    const lower = topology.edges.filter(({ from, to }) => topology.nodes[from].band > topology.nodes[to].band)
    expect(edgeCodes(topology, lower)).toEqual([])
  })

  it('places each course right after its deepest same-band prerequisite (col = max(bandStart, col(p) + 1))', () => {
    for (const n of topology.nodes) {
      let expected = topology.bands[n.band].startCol
      for (const p of topology.preds[n.index]) expected = Math.max(expected, topology.nodes[p].col + 1)
      expect(n.col, n.code).toBe(expected)
    }
  })

  it('has contiguous bands 100–400 with one column per internal chain step', () => {
    expect(topology.bands.map(band => band.level)).toEqual([100, 200, 300, 400])
    topology.bands.forEach((band, index) => {
      expect(band.index).toBe(index)
      expect(band.startCol).toBe(index === 0 ? 0 : topology.bands[index - 1].endCol + 1)
      expect(band.endCol).toBeGreaterThanOrEqual(band.startCol)
      expect(band.courseCount).toBe(topology.nodes.filter(n => n.band === index).length)
      const deepest = Math.max(...topology.nodes.filter(n => n.band === index).map(n => n.col))
      expect(deepest).toBe(band.endCol)
    })
    expect(topology.columnCount).toBe(topology.bands[3].endCol + 1)
  })

  it('splits the CSC108H5 → CSC148H5 chain into sub-columns of band 0', () => {
    const csc108 = node(topology, 'CSC108H5')
    const csc148 = node(topology, 'CSC148H5')
    expect(csc108.band).toBe(0)
    expect(csc148.band).toBe(0)
    expect(csc108.col).toBeLessThan(csc148.col)
    expect(edgeCodes(topology)).toContain('CSC108H5>CSC148H5')
  })

  it('excludes every backward (higher band → lower band) reference instead of displacing courses', () => {
    const expected = new Set<string>()
    dataset.courses.forEach((course, to) => {
      for (const id of [...course.prereq?.ids ?? [], ...course.coreq?.ids ?? []]) {
        const from = topology.indexById.get(id)
        if (from !== undefined && from !== to && bandOfLevel(dataset.courses[from].level) > bandOfLevel(course.level)) {
          expected.add(`${topology.nodes[from].code}>${course.code}`)
        }
      }
    })
    const backward = topology.excludedEdges.filter(edge => edge.reason === 'backward')
    expect(backward.length).toBeGreaterThan(0)
    expect(new Set(edgeCodes(topology, backward))).toEqual(expected)
    for (const edge of backward) expect(topology.nodes[edge.from].band).toBeGreaterThan(topology.nodes[edge.to].band)
    // FRE180H5 lists "… or FSL206H5": it stays in the 100 band and keeps no layout edge from FSL206H5.
    const fre = node(topology, 'FRE180H5')
    expect(fre.band).toBe(0)
    expect(topology.preds[fre.index].map(p => topology.nodes[p].code)).not.toContain('FSL206H5')
    console.log(`[graph] excluded: ${backward.length} backward, ${topology.excludedEdges.length - backward.length} cycle`)
  })

  it('drops self-references and breaks every cycle against (level, code) order', () => {
    const all = [...topology.edges, ...topology.excludedEdges]
    expect(all.some(edge => edge.from === edge.to)).toBe(false)
    for (const code of ['FSC307H5', 'FSC407H5']) {
      const v = node(topology, code).index
      expect(topology.preds[v]).not.toContain(v)
    }
    // The data may or may not contain loops (the parser fixed LIN104H5 ↔ LIN105H5); every breaker
    // must point against (level, code) order and really close a loop: its target still reaches
    // its source through layout edges.
    const cycles = topology.excludedEdges.filter(edge => edge.reason === 'cycle')
    for (const edge of cycles) {
      const [from, to] = [topology.nodes[edge.from], topology.nodes[edge.to]]
      expect(from.band).toBe(to.band)
      expect(from.level > to.level || (from.level === to.level && from.code > to.code), `${from.code}>${to.code}`).toBe(true)
      expect(collectDescendants(topology, edge.to).has(edge.from), `${from.code}>${to.code}`).toBe(true)
    }
    console.log(`[graph] cycle breakers: ${edgeCodes(topology, cycles).join(', ') || 'none'}`)
  })

  it('keeps excluded references out of the layout and adjacency', () => {
    const kept = new Set(topology.edges.map(edge => `${edge.from}>${edge.to}`))
    for (const edge of topology.excludedEdges) expect(kept.has(`${edge.from}>${edge.to}`)).toBe(false)
    const fromPreds = topology.preds.flatMap((list, to) => list.map(from => `${from}>${to}`)).sort()
    const fromSuccs = topology.succs.flatMap((list, from) => list.map(to => `${from}>${to}`)).sort()
    const fromEdges = topology.edges.map(edge => `${edge.from}>${edge.to}`).sort()
    expect(fromPreds).toEqual(fromEdges)
    expect(fromSuccs).toEqual(fromEdges)
    expect(new Set(fromEdges).size).toBe(fromEdges.length)
  })

  it('orders lanes by division then subject code with campus-qualified keys', () => {
    const rank = new Map(dataset.divisions.map((division, index) => [division.id, index]))
    const rankOf = (division: string) => rank.get(division) ?? dataset.divisions.length
    const subjects = new Set(dataset.courses.map(course => course.subject))
    expect(topology.lanes.map(lane => lane.subject).sort()).toEqual([...subjects].sort())
    topology.lanes.forEach((lane, index) => {
      expect(lane.index).toBe(index)
      expect(lane.key).toBe(`${dataset.campus}:${lane.subject}`)
      expect(lane.name.length).toBeGreaterThan(0)
      if (index === 0) return
      const prev = topology.lanes[index - 1]
      const order = rankOf(prev.division) - rankOf(lane.division) || (prev.subject < lane.subject ? -1 : 1)
      expect(order, `${prev.subject} before ${lane.subject}`).toBeLessThan(0)
    })
  })

  it('is deterministic', () => {
    const again = buildTopology(dataset)
    expect(again.nodes).toEqual(topology.nodes)
    expect(again.cells).toEqual(topology.cells)
    expect(again.edges).toEqual(topology.edges)
    expect(again.excludedEdges).toEqual(topology.excludedEdges)
  })

  it('does not depend on the order of the input courses', () => {
    const reference = byId(topology)
    for (const courses of [dataset.courses.slice().reverse(), shuffled(dataset.courses, 7), shuffled(dataset.courses, 2026)]) {
      const permuted: GraphDataset = { ...dataset, courses }
      expect(byId(buildTopology(permuted))).toEqual(reference)
    }
  })
})

describe('topology on synthetic datasets', () => {
  it('breaks a three-course cycle by (level, code) order and drops self-loops silently', () => {
    const topo = buildTopology(syntheticDataset([
      { code: 'AAA101H5', prereq: ['AAA103H5', 'AAA101H5'] },
      { code: 'AAA102H5', prereq: ['AAA101H5'] },
      { code: 'AAA103H5', prereq: ['AAA102H5'] },
    ]))
    expect(edgeCodes(topo)).toEqual(['AAA101H5>AAA102H5', 'AAA102H5>AAA103H5'])
    expect(topo.excludedEdges).toEqual([{ from: 2, to: 0, kind: 'prereq', reason: 'cycle' }])
    expect(['AAA101H5', 'AAA102H5', 'AAA103H5'].map(code => node(topo, code).col)).toEqual([0, 1, 2])
  })

  it('keeps one prerequisite edge when a course is both prerequisite and corequisite, ignores unknown ids', () => {
    const topo = buildTopology(syntheticDataset([
      { code: 'AAA101H5' },
      { code: 'AAA201H5', prereq: ['AAA101H5', 'UTSG:AAA100H1'], coreq: ['AAA101H5', 'UTM:ZZZ999H5'] },
      { code: 'AAA202H5', coreq: ['AAA201H5'] },
    ]))
    expect(topo.edges.map(edge => edge.kind)).toEqual(['prereq', 'coreq'])
    expect(edgeCodes(topo)).toEqual(['AAA101H5>AAA201H5', 'AAA201H5>AAA202H5'])
    expect(topo.excludedEdges).toEqual([])
  })

  it('gives an empty band one column and puts 000-level courses into band 0', () => {
    const topo = buildTopology(syntheticDataset([
      { code: 'AAA010H5', level: 0 },
      { code: 'AAA101H5', prereq: ['AAA010H5'] },
      { code: 'AAA301H5', prereq: ['AAA101H5'] },
      { code: 'AAA302H5', prereq: ['AAA301H5'] },
    ]))
    expect(topo.bands.map(band => [band.startCol, band.endCol, band.courseCount])).toEqual([[0, 1, 2], [2, 2, 0], [3, 4, 2], [5, 5, 0]])
    expect(topo.columnCount).toBe(6)
    expect(node(topo, 'AAA010H5')).toMatchObject({ band: 0, col: 0 })
    expect(node(topo, 'AAA302H5')).toMatchObject({ band: 2, col: 4 })
  })

  it('excludes backward references (prerequisite and corequisite) and keeps every course in its own band', () => {
    const topo = buildTopology(syntheticDataset([
      { code: 'BBB201H5' },
      { code: 'BBB101H5', prereq: ['BBB201H5', 'BBB100H5'] },
      { code: 'BBB100H5' },
      { code: 'BBB102H5', prereq: ['BBB101H5'], coreq: ['BBB301H5'] },
      { code: 'BBB301H5', prereq: ['BBB201H5'] },
    ]))
    expect(edgeCodes(topo)).toEqual(['BBB100H5>BBB101H5', 'BBB101H5>BBB102H5', 'BBB201H5>BBB301H5'])
    expect(topo.excludedEdges.map(edge => `${edgeCodes(topo, [edge])[0]}:${edge.kind}:${edge.reason}`))
      .toEqual(['BBB201H5>BBB101H5:prereq:backward', 'BBB301H5>BBB102H5:coreq:backward'])
    expect(node(topo, 'BBB101H5')).toMatchObject({ band: 0, col: 1 })
    expect(node(topo, 'BBB102H5')).toMatchObject({ band: 0, col: 2 })
    expect(node(topo, 'BBB201H5')).toMatchObject({ band: 1, col: 3 })
    expect(node(topo, 'BBB301H5')).toMatchObject({ band: 2, col: 4 })
  })

  it('orders lanes by declared division, unknown divisions last, then code; falls back to the code as name', () => {
    const topo = buildTopology(syntheticDataset(
      [{ code: 'ZZZ101H5' }, { code: 'AAA101H5' }, { code: 'MMM101H5' }, { code: 'QQQ101H5' }],
      [
        { code: 'ZZZ', division: 'sci', name: 'Zed', department: 'Dept Z' },
        { code: 'AAA', division: 'other' },
        { code: 'MMM', division: 'hum' },
      ],
      [{ id: 'hum', label: 'Humanities' }, { id: 'sci', label: 'Sciences' }],
    ))
    expect(topo.lanes.map(lane => lane.subject)).toEqual(['MMM', 'ZZZ', 'AAA', 'QQQ'])
    expect(topo.lanes[1]).toMatchObject({ key: 'UTM:ZZZ', name: 'Zed', department: 'Dept Z', division: 'sci' })
    expect(topo.lanes[3]).toMatchObject({ name: 'QQQ', department: '', division: '' })
  })

  it('orders a cell by the barycentre of predecessor positions before code', () => {
    // Lanes: AAA (0), BBB (1), CCC (2). In BBB's second column, BBB102 hangs off CCC and BBB103 off AAA.
    const topo = buildTopology(syntheticDataset([
      { code: 'AAA101H5' },
      { code: 'CCC101H5' },
      { code: 'BBB100H5' },
      { code: 'BBB102H5', prereq: ['CCC101H5'] },
      { code: 'BBB103H5', prereq: ['AAA101H5'] },
      { code: 'BBB104H5', prereq: ['BBB100H5'] },
    ]))
    const lane = topo.lanes.find(entry => entry.subject === 'BBB')!
    const cell = topo.cells[lane.index][1].map(v => topo.nodes[v].code)
    expect(cell).toEqual(['BBB103H5', 'BBB104H5', 'BBB102H5'])
  })

  it('second pass: pulls roots towards their successors and sends isolated courses to the end of the cell', () => {
    const topo = buildTopology(syntheticDataset([
      { code: 'AAA101H5' },
      { code: 'BBB101H5' },
      { code: 'BBB102H5' },
      { code: 'BBB103H5' },
      { code: 'CCC101H5' },
      { code: 'AAA102H5', prereq: ['BBB103H5'] },
      { code: 'CCC102H5', prereq: ['BBB102H5'] },
    ]))
    const lane = topo.lanes.find(entry => entry.subject === 'BBB')!
    expect(topo.cells[lane.index][0].map(v => topo.nodes[v].code)).toEqual(['BBB103H5', 'BBB102H5', 'BBB101H5'])
  })

  it('treats barycentres that differ only by float noise as ties and falls back to code', () => {
    // EEE111H5 hangs off AAA101H5 (slot 0 of 3 in lane 0) and DDD101H5 (lane 3): (1/6 + 3.5) / 2.
    // EEE110H5 hangs off BBB103H5 (slot 2 of 3 in lane 1): 1 + 5/6. Equal, but not in floating point.
    expect((1 / 6 + 3.5) / 2).not.toBe(1 + 5 / 6)
    const topo = buildTopology(syntheticDataset([
      { code: 'AAA101H5' }, { code: 'AAA102H5' }, { code: 'AAA103H5' },
      { code: 'BBB101H5' }, { code: 'BBB102H5' }, { code: 'BBB103H5' },
      { code: 'CCC111H5', prereq: ['BBB101H5'] }, { code: 'CCC112H5', prereq: ['BBB102H5'] },
      { code: 'DDD101H5' },
      { code: 'EEE110H5', prereq: ['BBB103H5'] },
      { code: 'EEE111H5', prereq: ['AAA101H5', 'DDD101H5'] },
    ]))
    const cell = (subject: string, col: number) => topo.cells[topo.lanes.find(lane => lane.subject === subject)!.index][col].map(v => topo.nodes[v].code)
    expect(cell('AAA', 0)[0]).toBe('AAA101H5')
    expect(cell('BBB', 0)).toEqual(['BBB101H5', 'BBB102H5', 'BBB103H5'])
    expect(cell('EEE', 1)).toEqual(['EEE110H5', 'EEE111H5'])
  })
})
