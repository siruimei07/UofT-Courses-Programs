import { describe, expect, it } from 'vitest'
import { bandOfLevel, buildTopology } from '../src/graph'
import type { Topology } from '../src/graph'
import { loadGraphDataset, syntheticDataset } from './helpers/dataset'

const { dataset, source } = loadGraphDataset()
const started = performance.now()
const topology = buildTopology(dataset)
const topologyMs = performance.now() - started

const node = (topo: Topology, code: string) => {
  const index = topo.indexById.get(`UTM:${code}`)
  if (index === undefined) throw new Error(`Missing course ${code}`)
  return topo.nodes[index]
}
const edgeCodes = (topo: Topology, edges = topo.edges) =>
  edges.map(edge => `${topo.nodes[edge.from].code}>${topo.nodes[edge.to].code}`)

describe('topology on the real UTM dataset', () => {
  it(`builds within budget (${source} data)`, () => {
    console.log(`[graph] buildTopology: ${topologyMs.toFixed(1)} ms for ${topology.nodes.length} courses / ${topology.edges.length} edges`)
    expect(topologyMs).toBeLessThan(300)
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

  it('keeps cells, lanes and node fields consistent', () => {
    expect(topology.cells).toHaveLength(topology.lanes.length)
    topology.cells.forEach((row, lane) => {
      expect(row).toHaveLength(topology.columnCount)
      row.forEach((cell, col) => cell.forEach((v, order) => {
        expect(topology.nodes[v]).toMatchObject({ lane, col, order })
      }))
    })
    for (const n of topology.nodes) {
      expect(topology.lanes[n.lane].subject).toBe(n.subject)
      const band = topology.bands[n.band]
      expect(n.col).toBeGreaterThanOrEqual(band.startCol)
      expect(n.col).toBeLessThanOrEqual(band.endCol)
      expect(n.displaced).toBe(n.band > bandOfLevel(n.level))
    }
  })

  it('draws every layout edge strictly left to right, never inside one column', () => {
    expect(topology.edges.length).toBeGreaterThan(4000)
    const bad = topology.edges.filter(({ from, to }) => topology.nodes[from].col >= topology.nodes[to].col)
    expect(edgeCodes(topology, bad)).toEqual([])
    for (const { from, to } of topology.edges) expect(topology.nodes[from].band).toBeLessThanOrEqual(topology.nodes[to].band)
  })

  it('has contiguous bands 100–400 with one column per internal chain step', () => {
    expect(topology.bands.map(band => band.level)).toEqual([100, 200, 300, 400])
    topology.bands.forEach((band, index) => {
      expect(band.index).toBe(index)
      expect(band.startCol).toBe(index === 0 ? 0 : topology.bands[index - 1].endCol + 1)
      expect(band.endCol).toBeGreaterThanOrEqual(band.startCol)
      expect(band.courseCount).toBe(topology.nodes.filter(n => n.band === index).length)
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

  it('displaces FRE180H5 behind its 200-level prerequisite FSL206H5', () => {
    const fre = node(topology, 'FRE180H5')
    expect(fre.band).toBeGreaterThanOrEqual(1)
    expect(fre.displaced).toBe(true)
    expect(fre.col).toBeGreaterThan(node(topology, 'FSL206H5').col)
  })

  it('drops self-references and breaks the LIN104H5 ↔ LIN105H5 cycle deterministically', () => {
    const all = [...topology.edges, ...topology.brokenEdges]
    expect(all.some(edge => edge.from === edge.to)).toBe(false)
    for (const code of ['FSC307H5', 'FSC407H5']) {
      const v = node(topology, code).index
      expect(topology.preds[v]).not.toContain(v)
    }
    expect(edgeCodes(topology, topology.brokenEdges)).toContain('LIN105H5>LIN104H5')
    expect(edgeCodes(topology)).toContain('LIN104H5>LIN105H5')
    expect(edgeCodes(topology)).not.toContain('LIN105H5>LIN104H5')
  })

  it('fills adjacency from the kept edges only', () => {
    const fromAdjacency = topology.preds.flatMap((list, to) => list.map(from => `${from}>${to}`)).sort()
    const fromSuccs = topology.succs.flatMap((list, from) => list.map(to => `${from}>${to}`)).sort()
    const fromEdges = topology.edges.map(edge => `${edge.from}>${edge.to}`).sort()
    expect(fromAdjacency).toEqual(fromEdges)
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
    expect(edgeCodes(topo, topo.brokenEdges)).toEqual(['AAA103H5>AAA101H5'])
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

  it('raises courses transitively behind later-band prerequisites', () => {
    const topo = buildTopology(syntheticDataset([
      { code: 'BBB201H5' },
      { code: 'BBB101H5', prereq: ['BBB201H5'] },
      { code: 'BBB102H5', prereq: ['BBB101H5'] },
      { code: 'BBB103H5' },
    ]))
    expect(node(topo, 'BBB101H5')).toMatchObject({ band: 1, displaced: true })
    expect(node(topo, 'BBB102H5')).toMatchObject({ band: 1, displaced: true })
    expect(node(topo, 'BBB103H5')).toMatchObject({ band: 0, displaced: false })
    const cols = ['BBB201H5', 'BBB101H5', 'BBB102H5'].map(code => node(topo, code).col)
    expect(cols[0]).toBeLessThan(cols[1])
    expect(cols[1]).toBeLessThan(cols[2])
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

  it('pulls roots towards their successors and sends isolated courses to the end of the cell', () => {
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
})
