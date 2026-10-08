// Where everything is for the current display classes, in world units (CSS px at zoom 1).
// Implements design-spec 8.1 and 8.3-8.6; label widths come from the caller's LabelMeasure.
import type {
  BandBox, ColumnBox, DisplayClass, Geometry, GeometryOptions, LabelMeasure, LaneBox, NodeBox, Presentation, Topology,
} from './types'

/**
 * Design-spec 8.1, after its fit tuning order (columnGap 28 → 24, bandPad 14 / 10 → 10 / 8,
 * fullLabelMax 184 → 172): the CSC148H5 chain at 1920 × 1080 with the panel open still misses the
 * 0.92 floor by about 2 %, so every step applies (known limit recorded in tests/graph-geometry.test.ts).
 */
export const DEFAULT_GEOMETRY_OPTIONS: GeometryOptions = {
  laneHeaderWidth: 176,
  bandHeaderHeight: 60,
  lanePaddingY: 12,
  laneMinHeight: 64,
  divisionLabelHeight: 17,
  laneSlimHeight: 30,
  laneCollapsedHeight: 0,
  bandPadLeft: 10,
  bandPadRight: 8,
  columnGap: 24,
  miniColumnGap: 6,
  colWidth: { full: 212, compact: 104, mini: 22 },
  rowHeight: { full: 40, compact: 22, mini: 8 },
  focusRowHeight: 44,
  miniPitch: 8,
  miniGapAbove: 6,
  miniPerRowMax: 10,
  cellMaxHeight: { full: 720, compact: 440 },
  trackGap: 8,
  dotInset: 8,
  labelX: 20,
  fullLabelMax: 172,
}

/**
 * A computed geometry also carries the effective options it was laid out with (not part of the
 * `Geometry` contract), so routes and anchors always use the same lane padding, row heights and
 * track gap as the boxes. Read them with `geometryOptions`.
 */
export interface LaidOutGeometry extends Geometry {
  options: GeometryOptions
}

/** The options a geometry was computed with; the defaults for geometries built elsewhere (e.g. tweens). */
export function geometryOptions(geometry: Geometry): GeometryOptions {
  return (geometry as Partial<LaidOutGeometry>).options ?? DEFAULT_GEOMETRY_OPTIONS
}

/** Not a spec constant: extra input that only the text module can know. */
export interface GeometryExtras {
  /**
   * Wrapped title lines of the focus plate (1-3, design-spec 7.5), from the renderer's text module.
   * When omitted, geometry estimates it from the title length (FOCUS_CHARS_PER_LINE).
   */
  focusLines?: number
}

/** Space after the longest label inside a track (trackW = labelX + label + 8; gap = columnGap − 8). */
export const LABEL_PAD = 8
/** Half height of a full label box (code + title lines): cy ± 15.5 in a 40 px row. */
export const FULL_LABEL_HALF = 15.5
/** Half height of a compact label box (code only): cy ± 8. */
export const COMPACT_LABEL_HALF = 8
/** The focus plate starts 2 px left of labelX (col.x + 18) and is 10 px wider than the measured width. */
export const PLATE_INSET = 2
export const PLATE_EXTRA = 10
/** Each wrapped title line beyond the first adds this to the focus row (and the plate). */
export const FOCUS_LINE_HEIGHT = 16
export const FOCUS_MAX_LINES = 3
/**
 * Fallback estimate for the plate's wrap (260 px at 12.5 / 400, word breaks): ~34 characters per
 * line, which puts the 3-line limit at the ~100-character titles named in design-spec 7.5.
 * Overestimating only adds air under the plate.
 */
const FOCUS_CHARS_PER_LINE = 34

type Visible = Exclude<DisplayClass, 'hidden'>
type LaneMode = 'labelled' | 'slim' | 'collapsed'

interface CellPlan {
  col: number
  /** Labelled nodes in static order, then minis in static order. */
  labelled: number[]
  minis: number[]
  /** 1 = stacked; otherwise balanced column-major tracks on a uniform row pitch. */
  tracks: number
  rowsPerTrack: number
  pitch: number
  /** Height of the tallest track. */
  stackH: number
}

export function computeGeometry(
  topology: Topology,
  presentation: Presentation,
  measure: LabelMeasure,
  options: Partial<GeometryOptions> & GeometryExtras = {},
): LaidOutGeometry {
  if (presentation.cls.length !== topology.nodes.length) {
    throw new Error(`Presentation has ${presentation.cls.length} classes for ${topology.nodes.length} nodes`)
  }
  const { opt, focusLines } = mergeOptions(options)
  const cls = presentation.cls
  const focus = presentation.role.indexOf('focus')
  const rowH = (v: number) => (v === focus ? focusRowHeight(topology, v, opt, focusLines) : opt.rowHeight[cls[v] as Visible])

  const modes = topology.lanes.map(lane => laneMode(lane.nodes, cls, presentation.dimming))
  const plans = topology.lanes.map((lane, l) => (modes[l] === 'labelled' ? planCells(topology.cells[l], cls, rowH, opt) : []))
  const labelW = measureLabels(topology, cls, focus, measure)
  const columns = layoutColumns(topology, cls, focus, labelW, plans, opt)
  const bands = layoutBands(topology, columns.boxes, columns.gaps, opt)
  const width = bands.length ? bands[bands.length - 1].x + bands[bands.length - 1].w : opt.laneHeaderWidth

  const nodes = new Array<NodeBox>(topology.nodes.length)
  const lanes: LaneBox[] = []
  const ctx: LaneContext = { topology, cls, focus, rowH, labelW, columns: columns.boxes, nodes, opt }
  // The division label sits on the first lane of each division (display order) that is neither
  // collapsed nor slim; only that lane gets the extra minimum height. The lane column uses the flag.
  const labelledDivisions = new Set<string>()
  let y = opt.bandHeaderHeight
  topology.lanes.forEach((lane, l) => {
    let box: LaneBox
    if (modes[l] === 'collapsed') {
      box = { y, h: opt.laneCollapsedHeight, collapsed: true, slim: false, divisionLabel: false }
    } else if (modes[l] === 'slim') {
      box = { y, h: opt.laneSlimHeight, collapsed: false, slim: true, divisionLabel: false }
      layoutSlimLane(topology.cells[l], y + opt.laneSlimHeight / 2, ctx)
    } else {
      const divisionLabel = !labelledDivisions.has(lane.division)
      labelledDivisions.add(lane.division)
      const tallest = layoutLabelledLane(plans[l], y + opt.lanePaddingY, ctx)
      const minimum = opt.laneMinHeight + (divisionLabel ? opt.divisionLabelHeight : 0)
      box = { y, h: Math.max(minimum, 2 * opt.lanePaddingY + tallest), collapsed: false, slim: false, divisionLabel }
    }
    for (const v of lane.nodes) {
      if (cls[v] !== 'hidden') continue
      const x = columns.boxes[topology.nodes[v].col].x
      nodes[v] = { x, y, w: 0, h: 0, cx: x, cy: y, cls: 'hidden', track: 0, overflow: false }
    }
    lanes.push(box)
    y += box.h
  })
  return { nodes, columns: columns.boxes, lanes, bands, width, height: y, options: opt }
}

function mergeOptions(options: Partial<GeometryOptions> & GeometryExtras) {
  const merged: Record<string, unknown> = { ...DEFAULT_GEOMETRY_OPTIONS }
  for (const [key, value] of Object.entries(options)) {
    if (value !== undefined && key !== 'focusLines') merged[key] = value
  }
  return { opt: merged as unknown as GeometryOptions, focusLines: options.focusLines }
}

/** Plate row: focusRowHeight + 16 per wrapped title line beyond the first (max 3 lines). */
function focusRowHeight(topology: Topology, v: number, opt: GeometryOptions, focusLines: number | undefined): number {
  const estimate = Math.ceil(topology.nodes[v].title.length / FOCUS_CHARS_PER_LINE)
  const lines = Math.min(FOCUS_MAX_LINES, Math.max(1, Math.round(focusLines ?? estimate)))
  return opt.focusRowHeight + FOCUS_LINE_HEIGHT * (lines - 1)
}

function laneMode(laneNodes: readonly number[], cls: readonly DisplayClass[], dimming: boolean): LaneMode {
  let visible = false
  let labelled = false
  for (const v of laneNodes) {
    if (cls[v] === 'hidden') continue
    visible = true
    if (cls[v] !== 'mini') labelled = true
  }
  if (!visible) return 'collapsed'
  return dimming && !labelled ? 'slim' : 'labelled'
}

/** Stack or wrap the labelled nodes of every non-empty cell of a labelled lane (8.4). */
function planCells(
  row: readonly number[][],
  cls: readonly DisplayClass[],
  rowH: (v: number) => number,
  opt: GeometryOptions,
): CellPlan[] {
  const plans: CellPlan[] = []
  row.forEach((cell, col) => {
    const labelled: number[] = []
    const minis: number[] = []
    for (const v of cell) {
      if (cls[v] === 'mini') minis.push(v)
      else if (cls[v] !== 'hidden') labelled.push(v)
    }
    if (!labelled.length && !minis.length) return
    let height = 0
    let pitch = 0
    let anyFull = false
    for (const v of labelled) {
      const h = rowH(v)
      height += h
      pitch = Math.max(pitch, h)
      if (cls[v] === 'full') anyFull = true
    }
    const limit = anyFull ? opt.cellMaxHeight.full : opt.cellMaxHeight.compact
    if (height <= limit || labelled.length < 2) {
      plans.push({ col, labelled, minis, tracks: 1, rowsPerTrack: labelled.length, pitch: 0, stackH: height })
      return
    }
    // Balanced column-major tracks on one shared row grid (uniform pitch), top-aligned.
    const wanted = Math.min(labelled.length, Math.ceil(height / limit))
    const rowsPerTrack = Math.ceil(labelled.length / wanted)
    const tracks = Math.ceil(labelled.length / rowsPerTrack)
    plans.push({ col, labelled, minis, tracks, rowsPerTrack, pitch, stackH: rowsPerTrack * pitch })
  })
  return plans
}

function measureLabels(topology: Topology, cls: readonly DisplayClass[], focus: number, measure: LabelMeasure): Float64Array {
  const widths = new Float64Array(topology.nodes.length)
  for (let v = 0; v < widths.length; v++) {
    const c = cls[v]
    if (c === 'full' || c === 'compact') widths[v] = Math.max(0, measure(v, c, v === focus))
  }
  return widths
}

/** Column widths per 8.3: labelled (measured, capped, × tracks), mini-only 22 px, empty 0. */
function layoutColumns(
  topology: Topology,
  cls: readonly DisplayClass[],
  focus: number,
  labelW: Float64Array,
  plans: readonly CellPlan[][],
  opt: GeometryOptions,
) {
  const count = topology.columnCount
  const maxLabel = new Float64Array(count)
  const labelled = new Uint8Array(count)
  const full = new Uint8Array(count)
  const mini = new Uint8Array(count)
  const tracks = new Int32Array(count).fill(1)
  for (const node of topology.nodes) {
    const c = cls[node.index]
    if (c === 'hidden') continue
    if (c === 'mini') {
      mini[node.col] = 1
      continue
    }
    labelled[node.col] = 1
    if (c === 'full') full[node.col] = 1
    if (node.index !== focus) maxLabel[node.col] = Math.max(maxLabel[node.col], labelW[node.index])
  }
  for (const lanePlans of plans) for (const plan of lanePlans) tracks[plan.col] = Math.max(tracks[plan.col], plan.tracks)

  const focusCol = focus >= 0 && cls[focus] !== 'hidden' && cls[focus] !== 'mini' ? topology.nodes[focus].col : -1
  const gaps = new Float64Array(count)
  const boxes = Array.from({ length: count }, (_, col): ColumnBox => {
    if (labelled[col]) {
      const cap = full[col] ? opt.colWidth.full : opt.colWidth.compact
      let trackW = Math.min(cap, opt.labelX + maxLabel[col] + LABEL_PAD)
      // The focus column may exceed the cap by the plate (which never truncates).
      if (col === focusCol) trackW = Math.max(trackW, opt.labelX + labelW[focus] + LABEL_PAD)
      const t = tracks[col]
      gaps[col] = opt.columnGap - LABEL_PAD
      return { x: 0, w: t * trackW + (t - 1) * opt.trackGap, tracks: t, trackW, kind: 'labelled' }
    }
    if (mini[col]) {
      gaps[col] = opt.miniColumnGap
      return { x: 0, w: opt.colWidth.mini, tracks: 1, trackW: opt.colWidth.mini, kind: 'mini' }
    }
    return { x: 0, w: 0, tracks: 1, trackW: 0, kind: 'empty' }
  })
  return { boxes, gaps }
}

/**
 * Bands tile from the lane header column: bandPadLeft, the visible columns with their gaps, and
 * bandPadRight instead of the last column's gap. A band without visible columns has width 0.
 * Empty columns get the x where the next visible column (or the band's right padding) starts.
 */
function layoutBands(topology: Topology, columns: ColumnBox[], gaps: Float64Array, opt: GeometryOptions): BandBox[] {
  let x = opt.laneHeaderWidth
  return topology.bands.map(band => {
    let last = -1
    for (let col = band.startCol; col <= band.endCol; col++) if (columns[col].w > 0) last = col
    if (last < 0) {
      for (let col = band.startCol; col <= band.endCol; col++) columns[col].x = x
      return { x, w: 0, visible: false }
    }
    const start = x
    let cursor = x + opt.bandPadLeft
    for (let col = band.startCol; col <= band.endCol; col++) {
      columns[col].x = cursor
      if (columns[col].w === 0) continue
      cursor += columns[col].w + (col === last ? 0 : gaps[col])
    }
    x = cursor + opt.bandPadRight
    return { x: start, w: x - start, visible: true }
  })
}

interface LaneContext {
  topology: Topology
  cls: readonly DisplayClass[]
  focus: number
  rowH: (v: number) => number
  labelW: Float64Array
  columns: readonly ColumnBox[]
  nodes: NodeBox[]
  opt: GeometryOptions
}

/** Lays out every cell of a labelled lane from `top`; returns the tallest cell height. */
function layoutLabelledLane(plans: readonly CellPlan[], top: number, ctx: LaneContext): number {
  const { columns, opt } = ctx
  let tallest = 0
  for (const plan of plans) {
    const column = columns[plan.col]
    let cursor = top
    plan.labelled.forEach((v, i) => {
      const track = plan.tracks > 1 ? Math.floor(i / plan.rowsPerTrack) : 0
      const h = ctx.rowH(v)
      let cy: number
      if (plan.tracks > 1) {
        cy = top + (i % plan.rowsPerTrack) * plan.pitch + plan.pitch / 2
      } else {
        cy = cursor + h / 2
        cursor += h
      }
      ctx.nodes[v] = labelledBox(v, column.x + track * (column.trackW + opt.trackGap), cy, h, track, column.trackW, ctx)
    })
    let height = plan.stackH
    if (plan.minis.length) {
      const perRow = column.kind === 'mini'
        ? 2
        : Math.max(1, Math.min(opt.miniPerRowMax, Math.floor((column.w - 16) / opt.miniPitch)))
      const gridTop = top + (plan.labelled.length ? plan.stackH + opt.miniGapAbove : 0)
      plan.minis.forEach((v, i) => {
        const cx = column.x + opt.dotInset + (i % perRow) * opt.miniPitch
        const cy = gridTop + Math.floor(i / perRow) * opt.miniPitch + opt.miniPitch / 2
        ctx.nodes[v] = miniBox(cx, cy, false, opt)
      })
      height = gridTop - top + Math.ceil(plan.minis.length / perRow) * opt.miniPitch
    }
    tallest = Math.max(tallest, height)
  }
  return tallest
}

function labelledBox(v: number, trackX: number, cy: number, rowH: number, track: number, trackW: number, ctx: LaneContext): NodeBox {
  const { opt } = ctx
  const c = ctx.cls[v] as Visible
  const cx = trackX + opt.dotInset
  if (v === ctx.focus) {
    const x = trackX + opt.labelX - PLATE_INSET
    return { x, y: cy - rowH / 2, w: ctx.labelW[v] + PLATE_EXTRA, h: rowH, cx, cy, cls: c, track, overflow: false }
  }
  const half = c === 'full' ? FULL_LABEL_HALF : COMPACT_LABEL_HALF
  const w = Math.min(ctx.labelW[v], Math.max(0, trackW - opt.labelX - LABEL_PAD))
  return { x: trackX + opt.labelX, y: cy - half, w, h: 2 * half, cx, cy, cls: c, track, overflow: false }
}

function miniBox(cx: number, cy: number, overflow: boolean, opt: GeometryOptions): NodeBox {
  const size = overflow ? 0 : opt.miniPitch
  return { x: cx - size / 2, y: cy - size / 2, w: size, h: size, cx, cy, cls: 'mini', track: 0, overflow }
}

/** Slim lane: one row of minis per cell on the centre line; the rest overflow (not drawn, not hit). */
function layoutSlimLane(row: readonly number[][], cy: number, ctx: LaneContext) {
  const { columns, opt } = ctx
  row.forEach((cell, col) => {
    const column = columns[col]
    const perRow = Math.max(1, Math.floor((column.w - 4) / opt.miniPitch))
    let i = 0
    for (const v of cell) {
      if (ctx.cls[v] !== 'mini') continue
      const slot = Math.min(i, perRow - 1)
      ctx.nodes[v] = miniBox(column.x + opt.dotInset + slot * opt.miniPitch, cy, i >= perRow, opt)
      i++
    }
  })
}
