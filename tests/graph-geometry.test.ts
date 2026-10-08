import { describe, expect, it } from 'vitest'
import {
  buildTopology, COMPACT_LABEL_HALF, computeGeometry, computePresentation, DEFAULT_GEOMETRY_OPTIONS, FULL_LABEL_HALF, LABEL_PAD,
} from '../src/graph'
import type { DisplayClass, Geometry, GeometryOptions, LabelMeasure, NodeRole, Presentation, PresentationInput, Topology } from '../src/graph'
import { loadGraphDataset, presentationInput, syntheticDataset } from './helpers/dataset'
import { bestOf, overlappingPairs, stubFocusLines, stubMeasure } from './helpers/graph'

const opt = DEFAULT_GEOMETRY_OPTIONS
const topology = buildTopology(loadGraphDataset().dataset)
const measure = stubMeasure(topology)
const close = (a: number, b: number) => Math.abs(a - b) < 1e-6

const isLabelled = (cls: DisplayClass) => cls === 'full' || cls === 'compact'

/** Independent re-statement of design-spec 8.3-8.6; returns human-readable violations. */
function geometryProblems(topo: Topology, p: Presentation, g: Geometry, measureFn: LabelMeasure, options: GeometryOptions = opt): string[] {
  const problems: string[] = []
  const check = (ok: boolean, message: () => string) => {
    if (!ok && problems.length < 25) problems.push(message())
  }
  const focus = p.role.indexOf('focus')
  const rowH = (v: number) => (v === focus ? g.nodes[v].h : options.rowHeight[p.cls[v] as 'full' | 'compact'])
  check(g.nodes.length === topo.nodes.length, () => 'node count')
  check(g.columns.length === topo.columnCount && g.lanes.length === topo.lanes.length && g.bands.length === topo.bands.length, () => 'box counts')

  // Columns (8.3).
  g.columns.forEach((column, col) => {
    const members = topo.nodes.filter(n => n.col === col && p.cls[n.index] !== 'hidden').map(n => n.index)
    const labelled = members.filter(v => isLabelled(p.cls[v]))
    const where = () => `column ${col} ${JSON.stringify(column)}`
    if (!members.length) return check(column.kind === 'empty' && column.w === 0, where)
    if (!labelled.length) return check(column.kind === 'mini' && column.w === options.colWidth.mini && column.tracks === 1, where)
    const cap = labelled.some(v => p.cls[v] === 'full') ? options.colWidth.full : options.colWidth.compact
    const widest = Math.max(0, ...labelled.filter(v => v !== focus).map(v => measureFn(v, p.cls[v] as 'full' | 'compact', false)))
    let trackW = Math.min(cap, options.labelX + widest + LABEL_PAD)
    if (labelled.includes(focus)) trackW = Math.max(trackW, options.labelX + measureFn(focus, 'full', true) + LABEL_PAD)
    const tracks = Math.max(...labelled.map(v => g.nodes[v].track)) + 1
    check(column.kind === 'labelled' && close(column.trackW, trackW) && column.tracks === tracks, where)
    check(close(column.w, tracks * column.trackW + (tracks - 1) * options.trackGap), where)
  })

  // Bands tile from the lane header; visible columns are separated by their class gap (8.3).
  let x = options.laneHeaderWidth
  topo.bands.forEach((band, b) => {
    const box = g.bands[b]
    const visible = g.columns.map((column, col) => ({ column, col })).filter(({ column, col }) => col >= band.startCol && col <= band.endCol && column.w > 0)
    check(close(box.x, x), () => `band ${band.level} x=${box.x}, expected ${x}`)
    if (!visible.length) return check(!box.visible && box.w === 0, () => `band ${band.level} should be hidden`)
    check(box.visible, () => `band ${band.level} should be visible`)
    let cursor = x + options.bandPadLeft
    visible.forEach(({ column, col }, i) => {
      check(close(column.x, cursor), () => `column ${col} x=${column.x}, expected ${cursor}`)
      cursor = column.x + column.w + (i === visible.length - 1 ? options.bandPadRight : column.kind === 'mini' ? options.miniColumnGap : options.columnGap - LABEL_PAD)
    })
    check(close(box.x + box.w, cursor), () => `band ${band.level} ends at ${box.x + box.w}, expected ${cursor}`)
    x = box.x + box.w
  })
  check(close(g.width, x), () => `width ${g.width}, expected ${x}`)

  // Nodes (8.4, 8.6).
  for (const n of topo.nodes) {
    const v = n.index
    const box = g.nodes[v]
    const column = g.columns[n.col]
    const where = () => `${n.code} ${JSON.stringify(box)}`
    check(box.cls === p.cls[v], where)
    if (box.cls === 'hidden') {
      check(box.w === 0 && box.h === 0, where)
      continue
    }
    if (box.cls === 'mini') {
      if (!box.overflow) check(box.cx - options.miniPitch / 2 >= column.x - 1e-6 && box.cx + options.miniPitch / 2 <= column.x + column.w + 1e-6, where)
      continue
    }
    check(box.track >= 0 && box.track < column.tracks && !box.overflow, where)
    const trackX = column.x + box.track * (column.trackW + options.trackGap)
    check(close(box.cx, trackX + options.dotInset), where)
    if (v === focus) {
      check(close(box.x, trackX + options.labelX - 2) && close(box.w, measureFn(v, 'full', true) + 10) && close(box.y, box.cy - box.h / 2), where)
      check(box.h === options.focusRowHeight || box.h === options.focusRowHeight + 16 || box.h === options.focusRowHeight + 32, where)
    } else {
      const half = box.cls === 'full' ? FULL_LABEL_HALF : COMPACT_LABEL_HALF
      const width = Math.min(measureFn(v, box.cls, false), column.trackW - options.labelX - LABEL_PAD)
      check(close(box.x, trackX + options.labelX) && close(box.w, width) && close(box.y, box.cy - half) && close(box.h, 2 * half), where)
    }
    check(box.x + box.w <= column.x + column.w + 1e-6, () => `${where()} leaves its column`)
  }

  // Lanes: contiguous, slim / collapsed / labelled heights (8.4, 8.5).
  let y = options.bandHeaderHeight
  topo.lanes.forEach((lane, l) => {
    const box = g.lanes[l]
    const where = () => `lane ${lane.subject} ${JSON.stringify(box)}`
    check(close(box.y, y), () => `${where()} expected y=${y}`)
    const visible = lane.nodes.filter(v => p.cls[v] !== 'hidden')
    const labelled = visible.filter(v => isLabelled(p.cls[v]))
    if (!visible.length) {
      check(box.collapsed && !box.slim && box.h === options.laneCollapsedHeight, where)
    } else if (p.dimming && !labelled.length) {
      check(box.slim && !box.collapsed && box.h === options.laneSlimHeight, where)
      for (const v of visible) check(close(g.nodes[v].cy, box.y + box.h / 2), () => `${topo.nodes[v].code} off the slim centre line`)
    } else {
      check(!box.slim && !box.collapsed, where)
      const top = box.y + options.lanePaddingY
      let content = 0
      for (const row of topo.cells[l]) {
        const cellLabelled = row.filter(v => isLabelled(p.cls[v]))
        const wrapped = cellLabelled.some(v => g.nodes[v].track > 0)
        const pitch = Math.max(0, ...cellLabelled.map(rowH))
        let labelBottom = top
        for (const v of cellLabelled) {
          const span = wrapped ? pitch : rowH(v)
          check(g.nodes[v].cy - span / 2 >= top - 1e-6, () => `${topo.nodes[v].code} above the lane padding`)
          labelBottom = Math.max(labelBottom, g.nodes[v].cy + span / 2)
        }
        // The first labelled row of every cell starts at laneTop + lanePaddingY (never pushed down by minis).
        if (cellLabelled.length) check(close(g.nodes[cellLabelled[0]].cy - (wrapped ? pitch : rowH(cellLabelled[0])) / 2, top), () => `${topo.nodes[cellLabelled[0]].code} first row not at the lane top`)
        let bottom = labelBottom
        for (const v of row) {
          if (p.cls[v] !== 'mini') continue
          const miniTop = g.nodes[v].cy - options.miniPitch / 2
          check(miniTop >= labelBottom + (cellLabelled.length ? options.miniGapAbove : 0) - 1e-6, () => `${topo.nodes[v].code} mini above the labelled stack`)
          bottom = Math.max(bottom, g.nodes[v].cy + options.miniPitch / 2)
        }
        content = Math.max(content, bottom - top)
      }
      const first = l === 0 || topo.lanes[l - 1].division !== lane.division
      const minimum = options.laneMinHeight + (first ? options.divisionLabelHeight : 0)
      check(close(box.h, Math.max(minimum, 2 * options.lanePaddingY + content)), () => `${where()} expected h=${Math.max(minimum, 2 * options.lanePaddingY + content)}`)
    }
    y = box.y + box.h
  })
  check(close(g.height, y), () => `height ${g.height}, expected ${y}`)

  // Every drawn edge runs strictly left to right between distinct, non-overlapping columns.
  topo.edges.forEach((edge, e) => {
    if (p.cls[edge.from] === 'hidden' || p.cls[edge.to] === 'hidden') return
    const a = g.columns[topo.nodes[edge.from].col]
    const b = g.columns[topo.nodes[edge.to].col]
    check(topo.nodes[edge.from].col !== topo.nodes[edge.to].col && a.x + a.w < b.x && g.nodes[edge.from].cx < g.nodes[edge.to].cx,
      () => `edge ${e} ${topo.nodes[edge.from].code} > ${topo.nodes[edge.to].code} is not left to right`)
  })
  return problems
}

function layout(input: PresentationInput, options: Partial<GeometryOptions> = {}) {
  const presentation = computePresentation(topology, input)
  const focus = presentation.role.indexOf('focus')
  const focusLines = focus >= 0 ? stubFocusLines(topology, focus) : undefined
  return { presentation, geometry: computeGeometry(topology, presentation, measure, { ...options, focusLines }) }
}

const cscProgram = new Set(topology.nodes.filter(n => n.subject === 'CSC' && n.level === 200).map(n => n.id))
const states: Array<[string, PresentationInput]> = [
  ['overview', presentationInput()],
  ['overview with titles', presentationInput({ titles: true })],
  ['CSC148H5, chain titles all', presentationInput({ focusId: 'UTM:CSC148H5' })],
  ['CSC148H5, chain titles direct', presentationInput({ focusId: 'UTM:CSC148H5', chainTitles: 'direct' })],
  ['CSC148H5, direct, hide unrelated', presentationInput({ focusId: 'UTM:CSC148H5', depth: 'direct', hideUnrelated: true })],
  ['SOC221H5 (wrapped chain cells)', presentationInput({ focusId: 'UTM:SOC221H5', chainTitles: 'direct' })],
  ['MAT232H5, levels 100 + 300', presentationInput({ focusId: 'UTM:MAT232H5', levels: new Set([100, 300]) })],
  ['levels 100 + 200', presentationInput({ levels: new Set([100, 200]) })],
  ['program (200-level CSC), show all edges', presentationInput({ programIds: cscProgram, showAllEdges: true })],
  ['program + focus STA256H5', presentationInput({ programIds: cscProgram, focusId: 'UTM:STA256H5' })],
  ['subjects CSC + MAT, focus MAT232H5', presentationInput({ subjects: new Set(['CSC', 'MAT']), focusId: 'UTM:MAT232H5' })],
]

describe('geometry on the real UTM dataset', () => {
  it.each(states)('lays out %s per design-spec 8.3-8.6 without overlaps', (_name, input) => {
    const { presentation, geometry } = layout(input)
    expect(overlappingPairs(topology, geometry)).toEqual([])
    expect(geometryProblems(topology, presentation, geometry, measure)).toEqual([])
  })

  it('keeps CSC108H5 and CSC148H5 on the same row (first labelled rows start at the lane padding)', () => {
    for (const input of [presentationInput(), presentationInput({ titles: true })]) {
      const { geometry } = layout(input)
      expect(geometry.nodes[topology.indexById.get('UTM:CSC108H5')!].cy).toBe(geometry.nodes[topology.indexById.get('UTM:CSC148H5')!].cy)
    }
  })

  it('wraps tall cells into balanced, top-aligned, column-major tracks on one row grid', () => {
    expect(opt.trackGap).toBeLessThan(opt.columnGap / 3)
    let wrappedCells = 0
    for (const input of [presentationInput(), presentationInput({ titles: true }), presentationInput({ focusId: 'UTM:SOC221H5' })]) {
      const { presentation, geometry } = layout(input)
      topology.cells.forEach((row, l) => row.forEach(cell => {
        const labelled = cell.filter(v => isLabelled(presentation.cls[v]))
        if (!labelled.some(v => geometry.nodes[v].track > 0)) return
        wrappedCells++
        const top = geometry.lanes[l].y + opt.lanePaddingY
        const pitch = Math.max(...labelled.map(v => opt.rowHeight[presentation.cls[v] as 'full' | 'compact']))
        const perTrack = labelled.filter(v => geometry.nodes[v].track === 0).length
        const height = labelled.reduce((sum, v) => sum + opt.rowHeight[presentation.cls[v] as 'full' | 'compact'], 0)
        const limit = labelled.some(v => presentation.cls[v] === 'full') ? opt.cellMaxHeight.full : opt.cellMaxHeight.compact
        expect(height).toBeGreaterThan(limit)
        expect(perTrack).toBe(Math.ceil(labelled.length / Math.ceil(height / limit)))
        labelled.forEach((v, i) => {
          // Static order runs down track 0, then down track 1, ...; all tracks start at the lane top.
          expect(geometry.nodes[v].track).toBe(Math.floor(i / perTrack))
          expect(geometry.nodes[v].cy).toBeCloseTo(top + (i % perTrack) * pitch + pitch / 2, 6)
        })
      }))
    }
    expect(wrappedCells).toBeGreaterThan(0)
  })

  it('aligns mini grids: one perRow per column, first dot at col.x + dotInset, rows miniPitch apart', () => {
    const { presentation, geometry } = layout(presentationInput({ focusId: 'UTM:CSC148H5' }))
    let checked = 0
    topology.cells.forEach((row, l) => {
      if (geometry.lanes[l].slim || geometry.lanes[l].collapsed) return
      row.forEach((cell, col) => {
        const minis = cell.filter(v => presentation.cls[v] === 'mini')
        if (!minis.length) return
        const column = geometry.columns[col]
        const perRow = column.kind === 'mini' ? 2 : Math.min(opt.miniPerRowMax, Math.floor((column.w - 16) / opt.miniPitch))
        const first = geometry.nodes[minis[0]]
        minis.forEach((v, i) => {
          expect(geometry.nodes[v].cx).toBeCloseTo(column.x + opt.dotInset + (i % perRow) * opt.miniPitch, 6)
          expect(geometry.nodes[v].cy).toBeCloseTo(first.cy + Math.floor(i / perRow) * opt.miniPitch, 6)
        })
        checked++
      })
    })
    expect(checked).toBeGreaterThan(20)
  })

  it('shrinks lanes with nothing on the path: slim 30 px (grey dots), collapsed 0 px (hide), hidden columns 0 px', () => {
    const grey = layout(presentationInput({ focusId: 'UTM:CSC148H5' }))
    const slim = grey.geometry.lanes.filter(lane => lane.slim)
    expect(slim.length).toBeGreaterThan(10)
    expect(slim.every(lane => lane.h === 30)).toBe(true)
    // Slim rows draw one row of minis per cell; the rest overflow (not drawn, not hit-testable).
    const overflow = grey.geometry.nodes.filter(box => box.overflow)
    expect(overflow.length).toBeGreaterThan(0)
    expect(overflow.every(box => box.cls === 'mini' && box.w === 0 && box.h === 0)).toBe(true)
    topology.cells.forEach((row, l) => {
      if (!grey.geometry.lanes[l].slim) return
      row.forEach((cell, col) => {
        const drawn = cell.filter(v => grey.presentation.cls[v] === 'mini' && !grey.geometry.nodes[v].overflow)
        expect(drawn.length).toBeLessThanOrEqual(Math.floor((grey.geometry.columns[col].w - 4) / opt.miniPitch))
      })
    })

    const hide = layout(presentationInput({ focusId: 'UTM:CSC148H5', hideUnrelated: true }))
    const collapsed = hide.geometry.lanes.filter(lane => lane.collapsed)
    expect(collapsed.length).toBeGreaterThan(10)
    expect(collapsed.every(lane => lane.h === 0 && !lane.slim)).toBe(true)
    expect(hide.geometry.lanes.some(lane => lane.slim)).toBe(false)
    const hiddenColumns = hide.geometry.columns.filter((_, col) => topology.nodes.every(n => n.col !== col || hide.presentation.cls[n.index] === 'hidden'))
    expect(hiddenColumns.every(column => column.w === 0 && column.kind === 'empty')).toBe(true)
  })

  it('collapses mini-only columns to 22 px during a selection', () => {
    const { geometry } = layout(presentationInput({ focusId: 'UTM:CSC148H5' }))
    const mini = geometry.columns.filter(column => column.kind === 'mini')
    expect(mini.length).toBeGreaterThan(0)
    expect(mini.every(column => column.w === 22)).toBe(true)
  })

  it('computes presentation + geometry within the 40 ms budget, twice for chain titles auto', () => {
    const rows = states.map(([name, input]) => {
      const { ms } = bestOf(3, () => {
        layout(input)
        if (input.focusId) layout({ ...input, chainTitles: 'direct' })
      })
      return { name, ms }
    })
    for (const { name, ms } of rows) console.log(`[graph] presentation + geometry (${name}): ${ms.toFixed(2)} ms`)
    for (const { ms } of rows) expect(ms).toBeLessThan(40)
  })

  it('is deterministic', () => {
    const input = presentationInput({ focusId: 'UTM:MAT232H5' })
    expect(layout(input).geometry).toEqual(layout(input).geometry)
  })
})

// ---------------------------------------------------------------------------

/** Presentation with hand-picked classes (roles 'none' unless given); dimming when any node is mini. */
function fake(topo: Topology, byCode: Record<string, DisplayClass>, roles: Record<string, NodeRole> = {}, dimming?: boolean): Presentation {
  const cls = topo.nodes.map(n => byCode[n.code] ?? 'hidden')
  return {
    cls,
    role: topo.nodes.map(n => roles[n.code] ?? 'none'),
    record: topo.nodes.map(() => null),
    eligibility: topo.nodes.map(() => null),
    inProgram: topo.nodes.map(() => false),
    edgeRole: topo.edges.map(edge => (cls[edge.from] === 'hidden' || cls[edge.to] === 'hidden' ? 'hidden' : 'faint')),
    dimming: dimming ?? cls.includes('mini'),
  }
}
const at = (topo: Topology, code: string) => topo.indexById.get(`UTM:${code}`)!

describe('geometry rules on synthetic layouts', () => {
  // Stub widths: codes 8 × 7.2 = 57.6, titles "Synthetic AAA101H5" 18 × 6.4 = 115.2.
  const CODE = 57.6
  const TITLE = 115.2

  it('measures columns, pads bands and gaps, and places labels per 8.3 / 8.6', () => {
    const topo = buildTopology(syntheticDataset([
      { code: 'AAA101H5' }, { code: 'AAA102H5', prereq: ['AAA101H5'] }, { code: 'AAA103H5', prereq: ['AAA102H5'] },
      { code: 'AAA201H5', prereq: ['AAA103H5'] },
    ]))
    const p = fake(topo, { AAA101H5: 'compact', AAA102H5: 'compact', AAA201H5: 'full' })
    const g = computeGeometry(topo, p, stubMeasure(topo))
    const compactW = opt.labelX + CODE + 8
    const fullW = opt.labelX + TITLE + 8
    const c0 = 176 + 14
    const c1 = c0 + compactW + 20
    const band0End = c1 + compactW + 10
    const c3 = band0End + 14
    const band1End = c3 + fullW + 10
    const expected: Array<[number, number, string]> = [
      [c0, compactW, 'labelled'], [c1, compactW, 'labelled'], [c1 + compactW, 0, 'empty'],
      [c3, fullW, 'labelled'], [band1End, 0, 'empty'], [band1End, 0, 'empty'],
    ]
    g.columns.forEach((column, col) => {
      expect(column.x).toBeCloseTo(expected[col][0], 6)
      expect(column.w).toBeCloseTo(expected[col][1], 6)
      expect(column.kind).toBe(expected[col][2])
    })
    expect(g.bands[0]).toMatchObject({ x: 176, visible: true })
    expect(g.bands[0].w).toBeCloseTo(band0End - 176, 6)
    expect(g.bands[1].x).toBeCloseTo(band0End, 6)
    expect(g.bands[1].w).toBeCloseTo(band1End - band0End, 6)
    expect(g.bands.slice(2).map(band => [band.w, band.visible])).toEqual([[0, false], [0, false]])
    expect(g.width).toBeCloseTo(band1End, 6)
    // One lane, first of its division: min height 64 + 17; the tallest cell is a 40 px full row.
    expect(g.lanes).toEqual([{ y: 60, h: 81, collapsed: false, slim: false }])
    const top = 60 + 12
    const compact = g.nodes[at(topo, 'AAA101H5')]
    expect(compact).toMatchObject({ x: c0 + 20, y: top + 11 - 8, h: 16, cx: c0 + 8, cy: top + 11, cls: 'compact', track: 0, overflow: false })
    expect(compact.w).toBeCloseTo(CODE, 6)
    const full = g.nodes[at(topo, 'AAA201H5')]
    expect(full).toMatchObject({ y: top + 20 - 15.5, h: 31, cy: top + 20, cls: 'full', track: 0 })
    expect(full.w).toBeCloseTo(TITLE, 6)
    expect(full.x).toBeCloseTo(c3 + 20, 6)
    expect(g.nodes[at(topo, 'AAA103H5')]).toMatchObject({ w: 0, h: 0, cls: 'hidden' })
    expect(geometryProblems(topo, p, g, stubMeasure(topo))).toEqual([])
  })

  it('caps track widths per class and lets the focus column exceed the cap by its plate', () => {
    const topo = buildTopology(syntheticDataset([{ code: 'AAA101H5' }, { code: 'AAA102H5', prereq: ['AAA101H5'] }, { code: 'AAA103H5', prereq: ['AAA102H5'] }]))
    const wide: LabelMeasure = (_index, _cls, isFocus) => (isFocus ? 300 : 400)
    const p = fake(topo, { AAA101H5: 'compact', AAA102H5: 'full', AAA103H5: 'full' }, { AAA103H5: 'focus' })
    const g = computeGeometry(topo, p, wide, { focusLines: 3 })
    expect(g.columns.slice(0, 3).map(column => column.trackW)).toEqual([104, 212, 20 + 300 + 8])
    const focus = g.nodes[at(topo, 'AAA103H5')]
    expect(focus).toMatchObject({ x: g.columns[2].x + 18, w: 310, h: 44 + 32 })
    expect(focus.x + focus.w).toBeCloseTo(g.columns[2].x + g.columns[2].trackW, 6)
    expect(g.nodes[at(topo, 'AAA101H5')].w).toBe(104 - 20 - 8)
    expect(geometryProblems(topo, p, g, wide)).toEqual([])
    // Without focusLines the row height is estimated from the title (18 characters: one line).
    expect(computeGeometry(topo, p, wide).nodes[at(topo, 'AAA103H5')].h).toBe(44)
  })

  it('stacks labelled nodes first, then a mini grid; mini-only columns are 22 px; slim rows overflow', () => {
    const minis = Array.from({ length: 12 }, (_, i) => ({ code: `AAA1${String(i + 2).padStart(2, '0')}H5` }))
    const topo = buildTopology(syntheticDataset([
      { code: 'AAA101H5' }, ...minis, { code: 'AAA150H5', prereq: ['AAA101H5'] },
      { code: 'BBB101H5' }, ...['BBB111H5', 'BBB112H5', 'BBB113H5', 'BBB114H5'].map(code => ({ code, prereq: ['AAA101H5'] })),
    ]))
    const byCode: Record<string, DisplayClass> = { AAA101H5: 'full' }
    for (const n of topo.nodes) if (n.code !== 'AAA101H5') byCode[n.code] = 'mini'
    const p = fake(topo, byCode)
    const g = computeGeometry(topo, p, stubMeasure(topo))
    const c0 = g.columns[0]
    const c1 = g.columns[1]
    expect(c0).toMatchObject({ kind: 'labelled', tracks: 1 })
    expect(c1).toMatchObject({ kind: 'mini', w: 22, trackW: 22, tracks: 1 })
    expect(c1.x).toBeCloseTo(c0.x + c0.w + 20, 6)
    const top = 60 + 12
    // AAA: full row (40), 6 px gap, then 12 minis in rows of 10.
    const grid = topo.cells[0][0].filter(v => p.cls[v] === 'mini')
    expect(grid).toHaveLength(12)
    grid.forEach((v, i) => {
      expect(g.nodes[v].cx).toBeCloseTo(c0.x + 8 + (i % 10) * 8, 6)
      expect(g.nodes[v].cy).toBe(top + 46 + Math.floor(i / 10) * 8 + 4)
    })
    expect(g.nodes[at(topo, 'AAA150H5')]).toMatchObject({ cy: top + 4, overflow: false })
    expect(g.nodes[at(topo, 'AAA150H5')].cx).toBeCloseTo(c1.x + 8, 6)
    expect(g.lanes[0]).toEqual({ y: 60, h: Math.max(81, 24 + 40 + 6 + 16), collapsed: false, slim: false })
    // BBB has only minis while dimming: a 30 px slim row; the mini column fits two dots, the rest overflow.
    expect(g.lanes[1]).toEqual({ y: 60 + 86, h: 30, collapsed: false, slim: true })
    const slimRow = ['BBB111H5', 'BBB112H5', 'BBB113H5', 'BBB114H5'].map(code => g.nodes[at(topo, code)])
    expect(slimRow.map(box => box.overflow)).toEqual([false, false, true, true])
    expect(slimRow.every(box => box.cy === 60 + 86 + 15)).toBe(true)
    expect(slimRow[1].cx - slimRow[0].cx).toBe(8)
    expect(g.nodes[at(topo, 'BBB101H5')]).toMatchObject({ cy: 161, overflow: false })
    expect(geometryProblems(topo, p, g, stubMeasure(topo))).toEqual([])
    expect(overlappingPairs(topo, g)).toEqual([])
  })

  it('wraps a tall cell into balanced tracks (compact cap 440, full cap 720) with a shared row grid', () => {
    const codes = Array.from({ length: 25 }, (_, i) => `AAA1${String(i + 10)}H5`)
    const topo = buildTopology(syntheticDataset(codes.map(code => ({ code }))))
    const compact = fake(topo, Object.fromEntries(codes.map(code => [code, 'compact' as const])))
    const g = computeGeometry(topo, compact, stubMeasure(topo))
    // 25 × 22 = 550 > 440 → 2 tracks of 13 + 12, top-aligned.
    expect(g.columns[0]).toMatchObject({ tracks: 2 })
    expect(g.columns[0].w).toBeCloseTo(2 * g.columns[0].trackW + 8, 6)
    const boxes = topo.cells[0][0].map(v => g.nodes[v])
    expect(boxes.map(box => box.track)).toEqual([...Array(13).fill(0), ...Array(12).fill(1)])
    expect(boxes[13].cy).toBe(boxes[0].cy)
    expect(boxes[12].cy - boxes[0].cy).toBe(12 * 22)
    expect(g.lanes[0].h).toBe(24 + 13 * 22)
    expect(geometryProblems(topo, compact, g, stubMeasure(topo))).toEqual([])

    // One full node raises the cap to 720 (24 × 22 + 40 = 568: no wrap) ...
    const mixed = fake(topo, Object.fromEntries(codes.map((code, i) => [code, i === 3 ? 'full' as const : 'compact' as const])))
    expect(computeGeometry(topo, mixed, stubMeasure(topo)).columns[0].tracks).toBe(1)
    // ... and a wrapped mixed cell uses the tallest row as its pitch so tracks share one grid.
    const tall = fake(topo, Object.fromEntries(codes.map((code, i) => [code, i < 18 ? 'full' as const : 'compact' as const])))
    const gt = computeGeometry(topo, tall, stubMeasure(topo))
    const tallBoxes = topo.cells[0][0].map(v => gt.nodes[v])
    expect(gt.columns[0].tracks).toBe(2)
    expect(tallBoxes[1].cy - tallBoxes[0].cy).toBe(40)
    expect(tallBoxes[13].cy).toBe(tallBoxes[0].cy)
    expect(geometryProblems(topo, tall, gt, stubMeasure(topo))).toEqual([])
    expect(overlappingPairs(topo, gt)).toEqual([])
  })

  it('collapses hidden lanes, adds the division label height to the first lane of a division, honours partial options', () => {
    const topo = buildTopology(syntheticDataset(
      [{ code: 'AAA101H5' }, { code: 'BBB101H5' }, { code: 'CCC101H5' }, { code: 'DDD101H5' }],
      [{ code: 'AAA', division: 'sci' }, { code: 'BBB', division: 'sci' }, { code: 'CCC', division: 'hum' }, { code: 'DDD', division: 'hum' }],
      [{ id: 'sci', label: 'Sciences' }, { id: 'hum', label: 'Humanities' }],
    ))
    const p = fake(topo, { AAA101H5: 'compact', CCC101H5: 'full', DDD101H5: 'compact' })
    const options = { laneCollapsedHeight: 6, columnGap: 20, laneMinHeight: 50, divisionLabelHeight: undefined }
    const g = computeGeometry(topo, p, stubMeasure(topo), options)
    expect(g.lanes).toEqual([
      { y: 60, h: 67, collapsed: false, slim: false },
      { y: 127, h: 6, collapsed: true, slim: false },
      { y: 133, h: 67, collapsed: false, slim: false },
      { y: 200, h: 50, collapsed: false, slim: false },
    ])
    expect(g.height).toBe(250)
    expect(geometryProblems(topo, p, g, stubMeasure(topo), { ...opt, laneCollapsedHeight: 6, columnGap: 20, laneMinHeight: 50 })).toEqual([])
  })

  it('rejects a presentation that does not match the topology', () => {
    const topo = buildTopology(syntheticDataset([{ code: 'AAA101H5' }]))
    const p = fake(topo, { AAA101H5: 'compact' })
    expect(() => computeGeometry(topo, { ...p, cls: [] }, stubMeasure(topo))).toThrow()
  })
})
