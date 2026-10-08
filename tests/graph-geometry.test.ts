import { describe, expect, it } from 'vitest'
import { buildTopology, computeGeometry, computePresentation, DEFAULT_GEOMETRY_OPTIONS } from '../src/graph'
import type { DisplayClass, Geometry, GeometryOptions, Presentation, PresentationInput, Topology } from '../src/graph'
import { loadGraphDataset, presentationInput, syntheticDataset } from './helpers/dataset'

const opt = DEFAULT_GEOMETRY_OPTIONS
const topology = buildTopology(loadGraphDataset().dataset)

/** Sweep over x: only boxes whose x-ranges intersect are compared for y-overlap. */
function overlappingPairs(geometry: Geometry): string[] {
  const boxes = geometry.nodes
    .map((box, index) => ({ ...box, index }))
    .filter(box => box.cls !== 'hidden')
    .sort((a, b) => a.x - b.x)
  const pairs: string[] = []
  let active: typeof boxes = []
  for (const box of boxes) {
    active = active.filter(other => other.x + other.w > box.x)
    for (const other of active) {
      if (other.y < box.y + box.h && box.y < other.y + other.h) pairs.push(`${other.index}/${box.index}`)
    }
    active.push(box)
  }
  return pairs
}

function checkGeometry(topo: Topology, p: Presentation, geometry: Geometry, options: GeometryOptions = opt) {
  const cls = p.cls
  expect(geometry.nodes).toHaveLength(topo.nodes.length)
  expect(overlappingPairs(geometry)).toEqual([])
  const problems: string[] = []
  const check = (ok: boolean, message: string) => {
    if (!ok) problems.push(message)
  }

  // Columns: hidden ones collapse to zero width without a gap; the rest take the widest class.
  const widest = new Array<number>(topo.columnCount).fill(0)
  for (const n of topo.nodes) {
    const c = cls[n.index]
    if (c !== 'hidden') widest[n.col] = Math.max(widest[n.col], options.colWidth[c])
  }
  let x = options.laneHeaderWidth
  widest.forEach((w, col) => {
    const box = geometry.columns[col]
    check(box.x === x && box.w === w, `column ${col}: ${JSON.stringify(box)}, expected x=${x} w=${w}`)
    if (w > 0) x += w + options.columnGap
  })
  expect(geometry.width).toBe(x)

  // Lanes: contiguous from the band header row down, as tall as the tallest cell, collapsed when empty.
  let y = options.bandHeaderHeight
  topo.lanes.forEach((lane, index) => {
    const box = geometry.lanes[index]
    const visible = lane.nodes.filter(v => cls[v] !== 'hidden')
    const bottom = Math.max(...visible.map(v => geometry.nodes[v].y + geometry.nodes[v].h))
    const expected = visible.length
      ? Math.max(options.laneMinHeight, bottom - box.y + options.lanePaddingY)
      : options.laneCollapsedHeight
    check(box.y === y && box.h === expected && box.collapsed === !visible.length,
      `lane ${lane.subject}: ${JSON.stringify(box)}, expected y=${y} h=${expected}`)
    y += box.h
  })
  expect(geometry.height).toBe(y)

  // Every visible node sits inside its column and lane, dot inside its label box.
  for (const n of topo.nodes) {
    const box = geometry.nodes[n.index]
    const where = `${n.code} ${JSON.stringify(box)}`
    check(box.cls === cls[n.index], `${where}: class`)
    if (box.cls === 'hidden') {
      check(box.w === 0 && box.h === 0, `${where}: hidden box has size`)
      continue
    }
    const column = geometry.columns[n.col]
    const lane = geometry.lanes[n.lane]
    check(box.x >= column.x && box.x + box.w <= column.x + column.w, `${where}: outside column`)
    check(box.y >= lane.y + options.lanePaddingY && box.y + box.h <= lane.y + lane.h - options.lanePaddingY, `${where}: outside lane`)
    check(box.cx > box.x && box.cx < box.x + box.w && box.cy === box.y + box.h / 2, `${where}: dot outside box`)
  }

  // Strictly left-to-right curves for every edge that is drawn.
  topo.edges.forEach((edge, index) => {
    if (p.edgeRole[index] === 'hidden') return
    check(geometry.nodes[edge.from].cx < geometry.nodes[edge.to].cx,
      `edge ${topo.nodes[edge.from].code} > ${topo.nodes[edge.to].code} runs backwards`)
  })

  // Visible bands tile the area right of the lane headers without gaps.
  let bandX = options.laneHeaderWidth
  topo.bands.forEach((band, index) => {
    const box = geometry.bands[index]
    const visible = geometry.columns.slice(band.startCol, band.endCol + 1).some(column => column.w > 0)
    check(box.visible === visible, `band ${band.level}: visible=${box.visible}`)
    if (!visible) return check(box.w === 0, `band ${band.level}: hidden band has width`)
    check(box.x === bandX, `band ${band.level}: x=${box.x}, expected ${bandX}`)
    bandX += box.w
  })
  check(bandX === geometry.width, `bands end at ${bandX}, world width ${geometry.width}`)
  expect(problems.slice(0, 20)).toEqual([])
}

function timed(input: PresentationInput) {
  const started = performance.now()
  const presentation = computePresentation(topology, input)
  const geometry = computeGeometry(topology, presentation.cls)
  return { presentation, geometry, ms: performance.now() - started }
}

describe('geometry on the real UTM dataset', () => {
  const cscIds = new Set(topology.nodes.filter(n => n.subject === 'CSC' && n.level === 200).map(n => n.id))
  const states: Array<[string, PresentationInput]> = [
    ['default', presentationInput()],
    ['focus CSC148H5', presentationInput({ focusId: 'UTM:CSC148H5' })],
    ['focus CSC148H5, direct, hide unrelated', presentationInput({ focusId: 'UTM:CSC148H5', depth: 'direct', hideUnrelated: true })],
    ['levels 100 + 200', presentationInput({ levels: new Set([100, 200]) })],
    ['program (200-level CSC), show all edges', presentationInput({ programIds: cscIds, showAllEdges: true })],
  ]

  it.each(states)('lays out %s without overlaps, backwards edges or lane gaps', (_name, input) => {
    const { presentation, geometry } = timed(input)
    checkGeometry(topology, presentation, geometry)
  })

  it('collapses hidden columns and lanes to zero size', () => {
    const { presentation, geometry } = timed(presentationInput({ focusId: 'UTM:CSC148H5', hideUnrelated: true }))
    const hiddenColumns = geometry.columns.filter((_, col) =>
      topology.nodes.every(n => n.col !== col || presentation.cls[n.index] === 'hidden'))
    expect(hiddenColumns.length).toBeGreaterThan(0)
    expect(hiddenColumns.every(column => column.w === 0)).toBe(true)
    const collapsed = geometry.lanes.filter(lane => lane.collapsed)
    expect(collapsed.length).toBeGreaterThan(0)
    expect(collapsed.every(lane => lane.h === opt.laneCollapsedHeight)).toBe(true)
    checkGeometry(topology, presentation, geometry)
  })

  it('computes presentation + geometry within the frame budget', () => {
    const results = states.map(([name, input]) => ({ name, ...timed(input) }))
    for (const { name, ms } of results) console.log(`[graph] presentation + geometry (${name}): ${ms.toFixed(2)} ms`)
    for (const { ms } of results) expect(ms).toBeLessThan(40)
  })
})

describe('geometry rules on synthetic layouts', () => {
  const lane = (codes: string[]) => buildTopology(syntheticDataset(codes.map(code => ({ code }))))
  const classes = (topo: Topology, byCode: Record<string, DisplayClass>) => topo.nodes.map(n => byCode[n.code] ?? 'hidden')
  const fake = (cls: DisplayClass[], topo: Topology) => ({
    cls,
    edgeRole: topo.edges.map(edge => (cls[edge.from] === 'hidden' || cls[edge.to] === 'hidden' ? 'hidden' : 'faint')),
  }) as unknown as Presentation

  it('packs runs of mini dots into a grid of floor(width / pitch) per row', () => {
    const topo = lane(['AAA101H5', 'AAA102H5', 'AAA103H5', 'AAA104H5', 'AAA105H5'])
    const cls = topo.nodes.map((): DisplayClass => 'mini')
    const geometry = computeGeometry(topo, cls)
    const top = opt.bandHeaderHeight + opt.lanePaddingY
    const left = opt.laneHeaderWidth
    expect(geometry.nodes.map(box => [box.x, box.y, box.w, box.h])).toEqual([
      [left, top, 7, 7], [left + 7, top, 7, 7],
      [left, top + 7, 7, 7], [left + 7, top + 7, 7, 7],
      [left, top + 14, 7, 7],
    ])
    expect(geometry.nodes[0]).toMatchObject({ cx: left + 3.5, cy: top + 3.5 })
    expect(geometry.columns[0]).toEqual({ x: left, w: 14 })
    expect(geometry.lanes[0]).toEqual({ y: opt.bandHeaderHeight, h: opt.laneMinHeight, collapsed: false })
    checkGeometry(topo, fake(cls, topo), geometry)
  })

  it('gives full and compact nodes whole rows; hidden nodes neither take space nor break a mini run', () => {
    const topo = lane(['AAA101H5', 'AAA102H5', 'AAA103H5', 'AAA104H5', 'AAA105H5', 'AAA106H5'])
    const cls = classes(topo, { AAA101H5: 'full', AAA102H5: 'mini', AAA104H5: 'mini', AAA105H5: 'compact', AAA106H5: 'mini' })
    const geometry = computeGeometry(topo, cls)
    const top = opt.bandHeaderHeight + opt.lanePaddingY
    const left = opt.laneHeaderWidth
    const [full, mini1, hidden, mini2, compact, mini3] = geometry.nodes
    expect(full).toEqual({ x: left, y: top, w: 184, h: 36, cx: left + opt.dotInset, cy: top + 18, cls: 'full' })
    expect([mini1.x, mini1.y, mini2.x, mini2.y]).toEqual([left, top + 36, left + 7, top + 36])
    expect([hidden.w, hidden.h]).toEqual([0, 0])
    expect(compact).toMatchObject({ x: left, y: top + 43, w: 184, h: 20, cy: top + 53 })
    expect([mini3.x, mini3.y]).toEqual([left, top + 63])
    expect(geometry.lanes[0].h).toBe(36 + 7 + 20 + 7 + 2 * opt.lanePaddingY)
    checkGeometry(topo, fake(cls, topo), geometry)
  })

  it('gives hidden and empty columns zero width and no gap; invisible bands report visible=false', () => {
    const topo = buildTopology(syntheticDataset([
      { code: 'AAA101H5' }, { code: 'AAA102H5', prereq: ['AAA101H5'] }, { code: 'AAA103H5', prereq: ['AAA102H5'] },
    ]))
    const cls = classes(topo, { AAA101H5: 'compact', AAA103H5: 'compact' })
    const geometry = computeGeometry(topo, cls)
    const left = opt.laneHeaderWidth
    const after = left + 2 * (92 + opt.columnGap)
    expect(geometry.columns).toEqual([
      { x: left, w: 92 }, { x: left + 92 + opt.columnGap, w: 0 }, { x: left + 92 + opt.columnGap, w: 92 },
      { x: after, w: 0 }, { x: after, w: 0 }, { x: after, w: 0 },
    ])
    expect(geometry.bands).toEqual([
      { x: left, w: after - left, visible: true },
      { x: after, w: 0, visible: false }, { x: after, w: 0, visible: false }, { x: after, w: 0, visible: false },
    ])
    expect(geometry.width).toBe(after)
    checkGeometry(topo, fake(cls, topo), geometry)
  })

  it('collapses lanes whose nodes are all hidden and honours partial options', () => {
    const topo = lane(['AAA101H5', 'BBB101H5', 'CCC101H5'])
    const cls = classes(topo, { AAA101H5: 'compact', CCC101H5: 'full' })
    const options = { ...opt, laneCollapsedHeight: 6, columnGap: 20, laneMinHeight: 50 }
    const geometry = computeGeometry(topo, cls, { laneCollapsedHeight: 6, columnGap: 20, laneMinHeight: 50 })
    expect(geometry.lanes).toEqual([
      { y: opt.bandHeaderHeight, h: 50, collapsed: false },
      { y: opt.bandHeaderHeight + 50, h: 6, collapsed: true },
      { y: opt.bandHeaderHeight + 56, h: 56, collapsed: false },
    ])
    expect(geometry.height).toBe(opt.bandHeaderHeight + 112)
    checkGeometry(topo, fake(cls, topo), geometry, options)
  })
})
