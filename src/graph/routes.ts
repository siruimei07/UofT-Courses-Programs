// Highlighted edges as world-space paths (design-spec 8.7-8.9, 7.4): anchors and curves, corridor
// routing around labels and dots, fan bundling and "any one of" fork junctions. Pure: Topology +
// Presentation + Geometry in, path segments out. Only chain and program edges are routed; faint
// edges, stubs and hover previews share the same anchors through `plainEdgePaths` (8.10).
import { geometryOptions } from './geometry'
import type {
  DisplayClass, EdgeKind, EdgeRole, Geometry, GeometryOptions, NodeRole, PathSegment, Presentation, RoutedPath,
  RouteInput, Routes, Topology,
} from './types'

const ROUTED: ReadonlySet<EdgeRole> = new Set<EdgeRole>(['prereq-direct', 'prereq', 'unlock-direct', 'unlock', 'program'])

/** Hit test (8.8): obstacles inflated by 2 px in a 64 px grid; at least 20 samples per curve. */
const INFLATE = 2
/**
 * Anchor pieces (leaders, wrapped-track steps and gap runs, entries) have fixed geometry (8.7); they
 * are checked against the label and dot boxes inflated by 1 px only, which leaves room for two runs
 * 3 px apart in a 22 px compact row gap (one per neighbouring row, see anchorShift).
 */
const ANCHOR_INFLATE = 1
const GRID = 64
const SAMPLES = 20
/**
 * Long segments are also sampled every 4 px: with the 2 px inflation no straight piece between two
 * clear samples can touch a real box, so "no hit" really means no curve crosses a label or dot.
 */
const SAMPLE_STEP = 4
/** Extra margin kept from the inflated obstacles when a gutter boundary is computed. */
const MARGIN = 1

const LEADER_GAP = 4
/**
 * Wrapped tracks (8.7, product rule: nothing may seem to link two courses of one column). An inner
 * track's source S-steps into its row gap right after its own label: a run of at most TRACK_STEP px
 * that ends NEXT_DOT_CLEAR px before the next track's dot column, so the step reads as leaving its
 * own label and never as a tick towards the neighbour on the same row. A later track's target
 * leaves the row gap with a quarter turn of radius HOOK_R straight down (or up) into its dot, so no
 * stroke lies on its row between the previous track's label and its dot. The gap runs sit
 * ANCHOR_SHIFT px towards their own row where the gap allows.
 */
const TRACK_STEP = 14
const TRACK_STEP_MIN = 6
const NEXT_DOT_CLEAR = 8
/** Largest dot radius next to a track's left edge (direct prerequisites and unlocks, 7.1). */
const DOT_R_MAX = 5
const HOOK_R = 6
/** Cubic approximation of a quarter circle. */
const KAPPA = 0.5523
const ANCHOR_SHIFT = 1.5
/** S-step runs: 20 px is the usual gutter step (8.8.4) and the narrowest smooth window; never under 6 px. */
const STEP_RUN = 20
const STEP_RUN_MIN = 6
/**
 * Transitions between heights are cubic S-steps with horizontal tangents. The first horizontal run
 * tried is SMOOTH × the vertical travel (at most SMOOTH_MAX); where that would cross a label the
 * step falls back to a shorter run, down to the free gutter, so vertical travel never crosses a label.
 */
const SMOOTH = 1.2
const SMOOTH_MAX = 320
/** Lane-padding corridor slots: the padding centre, then ± 3 px (8.8.6); never outside that band. */
const CORRIDOR_SLOT = 3
/**
 * Horizontal runs of unrelated edges (no shared endpoint) may not lie closer than RUN_CLEAR px while
 * overlapping by more than RUN_OVERLAP px: they would read as one line.
 */
const RUN_CLEAR = 2.5
const RUN_OVERLAP = 4
const RUN_BUCKET = 8
/** Elbow penalty: slopes above STEEP cost STEEP_COST px per unit; at most SEARCH_MAX feasible level pairs are compared. */
const STEEP = 2
const STEEP_COST = 12
const SEARCH_MAX = 6
/** Level pairs evaluated per path (cheapest first); the last-resort pass that may share runs compares only its first CROWDED_SEARCH_MAX feasible ones. */
const PAIR_MAX = 48
const CROWDED_SEARCH_MAX = 2

/** Fan bundling (8.9). */
const FAN_MIN = 6
const BUNDLE_MIN = 3
const SPLIT_BEFORE = 22
const MERGE_AFTER = 14
const STAGGER = 3
const STAGGER_MAX = 9
/** A staggered prerequisite trunk end S-steps into the focus row over this run before the entry. */
const TRUNK_STEP = 12

/** Fork junction (7.4). */
const JUNCTION_BEFORE = 28
const JUNCTION_R = 3.5
const JUNCTION_STACK = 20
/** Obstacle owner ids of junctions: -2, -3, ... (node indices are >= 0). */
const junctionOwner = (k: number) => -2 - k

/** Overview stubs (8.10). */
const STUB_SOURCE = 14
const STUB_TARGET = 10

/** Rings drawn around dots (7.1, 7.2): offsets from the dot radius and half stroke widths; the focus rings its knockout. */
const FOCUS_KNOCKOUT = 10.5
const PROGRAM_RING = 3.5
const PROGRAM_RING_HALF = 1
const AVAILABLE_RING = 3.5
const AVAILABLE_RING_OUTER = 6.5
const AVAILABLE_RING_HALF = 0.75

/** Dot radius of design-spec 7.1 (world px); geometry has no radii, so entries and dot boxes use these. */
export function dotRadius(role: NodeRole, cls: DisplayClass): number {
  if (cls === 'hidden') return 0
  if (cls === 'mini') return 2.25
  if (role === 'focus') return 8.5
  if (role === 'prereq-direct' || role === 'unlock-direct') return 5
  // Compact overview dots and program courses outside a selected chain (7.3) are 3.75.
  if (cls === 'compact' && (role === 'none' || role === 'program')) return 3.75
  return 4.25
}

// ---------------------------------------------------------------------------
// Segments and sampling

const M = (x: number, y: number): PathSegment => ({ op: 'M', x, y })
const L = (x: number, y: number): PathSegment => ({ op: 'L', x, y })
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

/** Cubic with horizontal tangents at both ends. */
const curve = (x0: number, y0: number, x1: number, y1: number, k: number): PathSegment =>
  ({ op: 'C', x1: x0 + k, y1: y0, x2: x1 - k, y2: y1, x: x1, y: y1 })

/** S-step between two heights (horizontal tangents, control points at mid-run). */
const sStep = (x0: number, y0: number, x1: number, y1: number): PathSegment => curve(x0, y0, x1, y1, (x1 - x0) / 2)

/**
 * From a row gap into a dot from above or below (wrapped target, 8.7): run along the gap to
 * cx − ρ, turn a quarter circle towards the dot and drop straight to its edge at endY.
 */
function hookInto(cx: number, gap: number, endY: number): PathSegment[] {
  const dir = Math.sign(endY - gap) || 1
  const rho = Math.min(HOOK_R, Math.abs(endY - gap))
  const turnY = gap + dir * rho
  const segs: PathSegment[] = [
    L(cx - rho, gap),
    { op: 'C', x1: cx - rho + KAPPA * rho, y1: gap, x2: cx, y2: turnY - dir * KAPPA * rho, x: cx, y: turnY },
  ]
  if (Math.abs(endY - turnY) > 1e-6) segs.push(L(cx, endY))
  return segs
}

/** k = clamp(0.45 · dx, 16, 240) (8.7), kept below dx so very short curves never fold back. */
function plainK(dx: number): number {
  return dx > 0 ? Math.min(clamp(0.45 * dx, 16, 240), 0.9 * dx) : 0
}

/** Calls `visit` on points along the path; stops and returns true when it returns true. */
export function samplePath(segments: readonly PathSegment[], step: number, visit: (x: number, y: number) => boolean): boolean {
  let x = 0
  let y = 0
  for (const s of segments) {
    if (s.op !== 'C') {
      if (s.op === 'M') {
        x = s.x
        y = s.y
        if (visit(x, y)) return true
        continue
      }
      const n = Math.max(1, Math.ceil(Math.hypot(s.x - x, s.y - y) / step))
      for (let i = 1; i <= n; i++) if (visit(x + ((s.x - x) * i) / n, y + ((s.y - y) * i) / n)) return true
    } else {
      const net = Math.hypot(s.x1 - x, s.y1 - y) + Math.hypot(s.x2 - s.x1, s.y2 - s.y1) + Math.hypot(s.x - s.x2, s.y - s.y2)
      const length = (net + Math.hypot(s.x - x, s.y - y)) / 2
      const n = Math.max(SAMPLES, Math.ceil(length / step))
      for (let i = 1; i <= n; i++) {
        const t = i / n
        const u = 1 - t
        const a = u * u * u
        const b = 3 * u * u * t
        const c = 3 * u * t * t
        const d = t * t * t
        if (visit(a * x + b * s.x1 + c * s.x2 + d * s.x, a * y + b * s.y1 + c * s.y2 + d * s.y)) return true
      }
    }
    x = s.x
    y = s.y
  }
  return false
}

/** A horizontal piece of a path: an `L` (or a flat `C`) at one height. */
export interface HorizontalRun {
  y: number
  x0: number
  x1: number
}

/** Horizontal runs longer than `minLength` (straight or flat-curve segments at one height). */
export function horizontalRuns(segments: readonly PathSegment[], minLength = 0): HorizontalRun[] {
  const runs: HorizontalRun[] = []
  let x = 0
  let y = 0
  for (const s of segments) {
    const flat = s.op === 'L' || (s.op === 'C' && s.y1 === y && s.y2 === y)
    if (s.op !== 'M' && flat && Math.abs(s.y - y) < 1e-9 && Math.abs(s.x - x) > minLength) {
      runs.push({ y, x0: Math.min(x, s.x), x1: Math.max(x, s.x) })
    }
    x = s.x
    y = s.y
  }
  return runs
}

// ---------------------------------------------------------------------------
// Obstacles and occupied runs

class ObstacleGrid {
  private readonly cells = new Map<number, number[]>()
  private readonly box: number[] = []
  private readonly owner: number[] = []

  private readonly inflate: number

  constructor(inflate = INFLATE) {
    this.inflate = inflate
  }

  /** Adds a box (inflated by the grid's inflation) owned by a node index or a junction id. */
  add(x0: number, y0: number, x1: number, y1: number, owner: number) {
    const id = this.owner.length
    const d = this.inflate
    this.box.push(x0 - d, y0 - d, x1 + d, y1 + d)
    this.owner.push(owner)
    this.strips = null
    for (let gx = cellOf(x0 - d); gx <= cellOf(x1 + d); gx++) {
      for (let gy = cellOf(y0 - d); gy <= cellOf(y1 + d); gy++) {
        const key = gridKey(gx, gy)
        const list = this.cells.get(key)
        if (list) list.push(id)
        else this.cells.set(key, [id])
      }
    }
  }

  hit(x: number, y: number, skip: readonly number[]): boolean {
    const list = this.cells.get(gridKey(cellOf(x), cellOf(y)))
    if (!list) return false
    for (const id of list) {
      const o = id * 4
      if (x < this.box[o] || x > this.box[o + 2] || y < this.box[o + 1] || y > this.box[o + 3]) continue
      if (!skip.includes(this.owner[id])) return true
    }
    return false
  }

  /** Bounding-box prefilter: could anything not in `skip` be inside the box? */
  touches(x0: number, y0: number, x1: number, y1: number, skip: readonly number[]): boolean {
    for (let gx = cellOf(x0); gx <= cellOf(x1); gx++) {
      for (let gy = cellOf(y0); gy <= cellOf(y1); gy++) {
        const list = this.cells.get(gridKey(gx, gy))
        if (!list) continue
        for (const id of list) {
          const o = id * 4
          if (this.box[o] > x1 || this.box[o + 2] < x0 || this.box[o + 1] > y1 || this.box[o + 3] < y0) continue
          if (!skip.includes(this.owner[id])) return true
        }
      }
    }
    return false
  }

  private stamp = new Uint32Array(0)
  private epoch = 0
  /** Per 64 px strip of x: box ids sorted by top, for tall band queries. */
  private strips: Map<number, number[]> | null = null
  private tallest = 0

  private buildStrips(): Map<number, number[]> {
    const strips = new Map<number, number[]>()
    for (let id = 0; id < this.owner.length; id++) {
      const o = id * 4
      this.tallest = Math.max(this.tallest, this.box[o + 3] - this.box[o + 1])
      for (let gx = cellOf(this.box[o]); gx <= cellOf(this.box[o + 2]); gx++) {
        const list = strips.get(gx)
        if (list) list.push(id)
        else strips.set(gx, [id])
      }
    }
    for (const list of strips.values()) list.sort((a, b) => this.box[a * 4 + 1] - this.box[b * 4 + 1])
    return strips
  }

  /** Adds the x-extent of every obstacle (not in `skip`) that intersects the rectangle to `out`. */
  blocks(x0: number, y0: number, x1: number, y1: number, skip: readonly number[], out: Array<[number, number, number]>) {
    const strips = this.strips ?? (this.strips = this.buildStrips())
    if (this.stamp.length < this.owner.length) this.stamp = new Uint32Array(this.owner.length)
    const epoch = ++this.epoch
    const from = y0 - this.tallest
    for (let gx = cellOf(x0); gx <= cellOf(x1); gx++) {
      const list = strips.get(gx)
      if (!list) continue
      let lo = 0
      let hi = list.length
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (this.box[list[mid] * 4 + 1] < from) lo = mid + 1
        else hi = mid
      }
      for (let i = lo; i < list.length; i++) {
        const id = list[i]
        const o = id * 4
        if (this.box[o + 1] > y1) break
        if (this.stamp[id] === epoch) continue
        this.stamp[id] = epoch
        if (this.box[o] > x1 || this.box[o + 2] < x0 || this.box[o + 3] < y0) continue
        if (!skip.includes(this.owner[id])) out.push([this.box[o], this.box[o + 2], this.owner[id]])
      }
    }
  }

  /** A horizontal run at y from x0 is clear up to the returned x (x1 when nothing is in the way). */
  stopRight(y: number, x0: number, x1: number, skip: readonly number[]): number {
    let stop = x1
    const gy = cellOf(y)
    for (let gx = cellOf(x0); gx <= cellOf(stop); gx++) {
      for (const id of this.cells.get(gridKey(gx, gy)) ?? []) {
        const o = id * 4
        if (y < this.box[o + 1] || y > this.box[o + 3] || this.box[o + 2] < x0 || this.box[o] > stop) continue
        if (!skip.includes(this.owner[id])) stop = Math.max(x0, this.box[o])
      }
    }
    return stop
  }

  /** A horizontal run at y ending at x1 is clear back to the returned x (x0 when nothing is in the way). */
  stopLeft(y: number, x0: number, x1: number, skip: readonly number[]): number {
    let stop = x0
    const gy = cellOf(y)
    for (let gx = cellOf(x1); gx >= cellOf(stop); gx--) {
      for (const id of this.cells.get(gridKey(gx, gy)) ?? []) {
        const o = id * 4
        if (y < this.box[o + 1] || y > this.box[o + 3] || this.box[o] > x1 || this.box[o + 2] < stop) continue
        if (!skip.includes(this.owner[id])) stop = Math.min(x1, this.box[o + 2])
      }
    }
    return stop
  }
}

const cellOf = (value: number) => Math.floor(value / GRID)
const gridKey = (gx: number, gy: number) => gx * 1_000_003 + gy

function pathHits(segments: readonly PathSegment[], grid: ObstacleGrid, skip: readonly number[]): boolean {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  const extend = (x: number, y: number) => {
    if (x < x0) x0 = x
    if (x > x1) x1 = x
    if (y < y0) y0 = y
    if (y > y1) y1 = y
  }
  for (const s of segments) {
    extend(s.x, s.y)
    if (s.op === 'C') {
      extend(s.x1, s.y1)
      extend(s.x2, s.y2)
    }
  }
  if (!grid.touches(x0, y0, x1, y1, skip)) return false
  return samplePath(segments, SAMPLE_STEP, (x, y) => grid.hit(x, y, skip))
}

/** Endpoints of a routed path for run sharing: paths with a common source or target may share runs. */
interface Ends {
  from: number
  to: number
}

interface OccupiedRun extends HorizontalRun, Ends {}

class RunBuckets {
  private readonly buckets = new Map<number, OccupiedRun[]>()

  add(run: HorizontalRun, ends: Ends) {
    const k = Math.floor(run.y / RUN_BUCKET)
    const entry: OccupiedRun = { ...run, ...ends }
    const list = this.buckets.get(k)
    if (list) list.push(entry)
    else this.buckets.set(k, [entry])
  }

  /** Does the run lie on a run of a path without a shared endpoint? */
  clashes(run: HorizontalRun, ends: Ends): boolean {
    for (let k = Math.floor((run.y - RUN_CLEAR) / RUN_BUCKET); k <= Math.floor((run.y + RUN_CLEAR) / RUN_BUCKET); k++) {
      for (const other of this.buckets.get(k) ?? []) {
        if (Math.abs(other.y - run.y) >= RUN_CLEAR) continue
        if (Math.min(other.x1, run.x1) - Math.max(other.x0, run.x0) <= RUN_OVERLAP) continue
        if (related(ends, other)) continue
        return true
      }
    }
    return false
  }

  /** Unrelated runs within RUN_CLEAR of y that overlap [x0, x1] by more than RUN_OVERLAP. */
  private nearby(y: number, x0: number, x1: number, ends: Ends, visit: (run: OccupiedRun, from: number, to: number) => void) {
    for (let k = Math.floor((y - RUN_CLEAR) / RUN_BUCKET); k <= Math.floor((y + RUN_CLEAR) / RUN_BUCKET); k++) {
      for (const other of this.buckets.get(k) ?? []) {
        if (Math.abs(other.y - y) >= RUN_CLEAR || related(ends, other)) continue
        const from = Math.max(x0, other.x0)
        const to = Math.min(x1, other.x1)
        if (to - from > RUN_OVERLAP) visit(other, from, to)
      }
    }
  }

  /** A run at y from x0 may extend to the returned x without lying on an unrelated run. */
  stopRight(y: number, x0: number, x1: number, ends: Ends): number {
    let stop = x1
    this.nearby(y, x0, x1, ends, (_run, from) => {
      stop = Math.min(stop, from + RUN_OVERLAP)
    })
    return stop
  }

  /** A run at y ending at x1 may start at the returned x without lying on an unrelated run. */
  stopLeft(y: number, x0: number, x1: number, ends: Ends): number {
    let stop = x0
    this.nearby(y, x0, x1, ends, (_run, _from, to) => {
      stop = Math.max(stop, to - RUN_OVERLAP)
    })
    return stop
  }
}

const related = (a: Ends, b: Ends) => (a.from >= 0 && a.from === b.from) || (a.to >= 0 && a.to === b.to)

/**
 * Horizontal runs of the paths routed so far, plus reservations: every run an anchor might need
 * (wrapped-track steps run along a fixed row gap and cannot move). Routed middle parts avoid both;
 * anchors only avoid runs that were really drawn.
 */
class RunRegistry {
  private readonly drawn = new RunBuckets()
  private readonly reserved = new RunBuckets()

  reserve(segments: readonly PathSegment[], ends: Ends) {
    for (const run of horizontalRuns(segments, RUN_OVERLAP)) this.reserved.add(run, ends)
  }

  add(segments: readonly PathSegment[], ends: Ends) {
    for (const run of horizontalRuns(segments, RUN_OVERLAP)) this.drawn.add(run, ends)
  }

  /** Does an anchor piece lie on a drawn run of an unrelated path? */
  anchorClashes(segments: readonly PathSegment[], ends: Ends): boolean {
    return horizontalRuns(segments, RUN_OVERLAP).some(run => this.drawn.clashes(run, ends))
  }

  /** Does a routed middle part lie on a drawn or reserved run of an unrelated path? */
  middleClashes(middle: readonly PathSegment[], ends: Ends): boolean {
    return horizontalRuns(middle, RUN_OVERLAP).some(run => this.drawn.clashes(run, ends) || this.reserved.clashes(run, ends))
  }

  stopRight(y: number, x0: number, x1: number, ends: Ends): number {
    return this.reserved.stopRight(y, x0, this.drawn.stopRight(y, x0, x1, ends), ends)
  }

  stopLeft(y: number, x0: number, x1: number, ends: Ends): number {
    return this.reserved.stopLeft(y, this.drawn.stopLeft(y, x0, x1, ends), x1, ends)
  }
}

/** Tail anchor segments as a standalone path (they start at the port). */
const tailAnchor = (tail: Port): PathSegment[] => [M(tail.x, tail.y), ...tail.segs]

// ---------------------------------------------------------------------------
// Context: obstacles, gutters and row gaps

interface Context {
  topology: Topology
  geometry: Geometry
  opt: GeometryOptions
  focus: number
  role(v: number): NodeRole
  /** Label boxes and dot boxes (r + 2), design-spec 8.8.1: every part of a path must clear them. */
  grid: ObstacleGrid
  /**
   * Rings that reach past the dot box (program and "available" rings, 7.1-7.2): the routed middle
   * part of a path clears them too. Anchor pieces (leaders, wrapped-track steps, entries) keep the
   * fixed geometry of 8.7 and only clear `anchors`.
   */
  rings: ObstacleGrid
  /** The label and dot boxes of `grid`, inflated by ANCHOR_INFLATE only: what anchor pieces clear. */
  anchors: ObstacleGrid
  runs: RunRegistry
  /** Per column: left end of the free gutter before it / right end of the free gutter after it. */
  freeLeft: Float64Array
  freeRight: Float64Array
  /** Per column: right end of the free gutter before it (where its own leftmost obstacle begins). */
  gutterEnd: Float64Array
  /** Per column: number of visible columns before it (same-row rule). */
  visibleBefore: Int32Array
  /** Per labelled node: highest track used by labelled nodes of its cell, and half its row pitch. */
  cellMaxTrack: Int32Array
  rowHalf: Float64Array
  /**
   * Per node in a wrapped cell: how far its anchor runs sit from the row-gap centre towards its own
   * row, so the two neighbours sharing a gap run 3 px apart instead of on one line (full and
   * compact rows; 0 only where a custom row height leaves no room).
   */
  anchorShift: Float64Array
  /** Per lane: the row-gap heights of its labelled cells, sorted (channels for single-height runs). */
  laneGaps: number[][]
  /**
   * Row-gap run chosen for a wrapped-track anchor (`h${v}` as a source, `t${v}` as a target), as the
   * offset of its height from the node's cy: the slot next to its own row in the gap above or below,
   * or the neighbour row's slot of that gap when its own are taken. See planAnchorSides.
   */
  sides: Map<string, number>
  /** Obstacles in the band next to a port, per port position and target height (see stepRun). */
  bands: Map<string, Array<[number, number, number]>>
  /** Columns with obstacles, left to right: inflated x-extent, merged obstacle heights and members (band tests). */
  spans: ColumnSpan[]
  /** Inflated fork-junction boxes (they sit in a gutter, outside every column span). */
  junctionBoxes: Array<[number, number, number, number]>
}

interface ColumnSpan {
  x0: number
  x1: number
  /** Merged [top, bottom] pairs of every inflated label, dot and ring box of the column, by height. */
  ys: number[]
  nodes: Set<number>
}

/** Does any obstacle of the column reach into the band [y0, y1]? */
function spanBlocked(span: ColumnSpan, y0: number, y1: number): boolean {
  const ys = span.ys
  let lo = 0
  let hi = ys.length / 2
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (ys[mid * 2 + 1] < y0) lo = mid + 1
    else hi = mid
  }
  return lo < ys.length / 2 && ys[lo * 2] <= y1
}

const isLabelled = (cls: DisplayClass) => cls === 'full' || cls === 'compact'

/**
 * Half size of the box that keeps a path 1 px clear of a node's outermost ring (after INFLATE), or
 * 0 when the node has no ring beyond its dot box.
 */
function ringRadius(presentation: Presentation, v: number, hasFocus: boolean): number {
  const role = presentation.role[v]
  const r = role === 'focus' ? FOCUS_KNOCKOUT : dotRadius(role, presentation.cls[v])
  const programRing = presentation.inProgram[v] && (hasFocus ? role !== 'none' && role !== 'program' : role === 'program')
  const record = presentation.record[v]
  const available = role !== 'focus' && presentation.eligibility[v] === 'met' && record !== 'completed' && record !== 'inProgress'
  let outer = 0
  if (programRing) outer = r + PROGRAM_RING + PROGRAM_RING_HALF
  if (available) outer = r + (programRing ? AVAILABLE_RING_OUTER : AVAILABLE_RING) + AVAILABLE_RING_HALF
  const half = outer + 1 - INFLATE
  return half > dotRadius(role, presentation.cls[v]) + 2 ? half : 0
}

function buildContext(topology: Topology, presentation: Presentation | null, geometry: Geometry, obstacles: boolean): Context {
  const opt = geometryOptions(geometry)
  const nodes = geometry.nodes
  const n = topology.nodes.length
  const role = (v: number): NodeRole => presentation?.role[v] ?? 'none'
  const focusIndex = presentation ? presentation.role.indexOf('focus') : -1
  const focus = focusIndex >= 0 && isLabelled(nodes[focusIndex].cls) ? focusIndex : -1
  const grid = new ObstacleGrid()
  const rings = new ObstacleGrid()
  const anchors = new ObstacleGrid(ANCHOR_INFLATE)
  const columnCount = geometry.columns.length
  const minLeft = new Float64Array(columnCount).fill(Infinity)
  const spanBoxes: Array<Array<[number, number]>> = Array.from({ length: columnCount }, () => [])
  const spanNodes: Array<Set<number>> = Array.from({ length: columnCount }, () => new Set())
  const maxRight = new Float64Array(columnCount).fill(-Infinity)
  const cellMaxTrack = new Int32Array(n)
  const rowHalf = new Float64Array(n)
  const anchorShift = new Float64Array(n)
  // The focus plate's box is its whole row (44-76); other label boxes are shorter than their row.
  const rowHeight = (v: number) => Math.max(nodes[v].h, opt.rowHeight[nodes[v].cls as 'full' | 'compact'])

  topology.cells.forEach(row => row.forEach(cell => {
    let maxTrack = 0
    let pitch = 0
    let labelHalf = 0
    for (const v of cell) {
      if (!isLabelled(nodes[v].cls)) continue
      maxTrack = Math.max(maxTrack, nodes[v].track)
      pitch = Math.max(pitch, rowHeight(v))
      labelHalf = Math.max(labelHalf, nodes[v].h / 2)
    }
    // Free half-band of a gap between two label boxes after the anchor inflation; a shifted run keeps
    // at least 0.5 px of it (compact rows: 11 − 8 − 1 = 2 px, the run sits 1.5 px off the gap centre).
    const shift = maxTrack > 0 && pitch / 2 - labelHalf - ANCHOR_INFLATE >= ANCHOR_SHIFT + 0.5 ? ANCHOR_SHIFT : 0
    for (const v of cell) {
      if (!isLabelled(nodes[v].cls)) continue
      cellMaxTrack[v] = maxTrack
      rowHalf[v] = (maxTrack > 0 ? pitch : rowHeight(v)) / 2
      anchorShift[v] = shift
    }
  }))

  for (let v = 0; v < n; v++) {
    const box = nodes[v]
    if (!isLabelled(box.cls)) continue
    const core = dotRadius(role(v), box.cls) + 2
    const ring = presentation ? ringRadius(presentation, v, focus >= 0) : 0
    if (obstacles) {
      grid.add(box.x, box.y, box.x + box.w, box.y + box.h, v)
      grid.add(box.cx - core, box.cy - core, box.cx + core, box.cy + core, v)
      anchors.add(box.x, box.y, box.x + box.w, box.y + box.h, v)
      anchors.add(box.cx - core, box.cy - core, box.cx + core, box.cy + core, v)
      if (ring) rings.add(box.cx - ring, box.cy - ring, box.cx + ring, box.cy + ring, v)
      const c = topology.nodes[v].col
      const half = Math.max(core, ring) + INFLATE
      spanBoxes[c].push([box.y - INFLATE, box.y + box.h + INFLATE], [box.cy - half, box.cy + half])
      spanNodes[c].add(v)
    }
    // Gutters end where the outermost obstacle of a column begins (rings included).
    const r = Math.max(core, ring)
    const col = topology.nodes[v].col
    minLeft[col] = Math.min(minLeft[col], box.x, box.cx - r)
    maxRight[col] = Math.max(maxRight[col], box.x + box.w, box.cx + r)
  }

  const freeLeft = new Float64Array(columnCount)
  const freeRight = new Float64Array(columnCount)
  const gutterEnd = Float64Array.from(minLeft, left => left - INFLATE - MARGIN)
  const visibleBefore = new Int32Array(columnCount + 1)
  let left = -Infinity
  for (let c = 0; c < columnCount; c++) {
    freeLeft[c] = left
    if (maxRight[c] > -Infinity) left = maxRight[c] + INFLATE + MARGIN
    visibleBefore[c + 1] = visibleBefore[c] + (geometry.columns[c].w > 0 ? 1 : 0)
  }
  let right = Infinity
  for (let c = columnCount - 1; c >= 0; c--) {
    freeRight[c] = right
    if (minLeft[c] < Infinity) right = minLeft[c] - INFLATE - MARGIN
  }
  // Only gaps inside the lane's content: a tall focus row (plate) would otherwise offer a "gap" in
  // the lane padding, outside the corridor band.
  const laneGaps = topology.lanes.map((lane, l) => {
    const ys = new Set<number>()
    const box = geometry.lanes[l]
    const inside = (y: number) => box && y >= box.y + opt.lanePaddingY - 1e-6 && y <= box.y + box.h - opt.lanePaddingY + 1e-6
    for (const v of lane.nodes) {
      if (!isLabelled(nodes[v].cls)) continue
      if (inside(nodes[v].cy - rowHalf[v])) ys.add(nodes[v].cy - rowHalf[v])
      if (inside(nodes[v].cy + rowHalf[v])) ys.add(nodes[v].cy + rowHalf[v])
    }
    return [...ys].sort((a, b) => a - b)
  })
  const spans: ColumnSpan[] = []
  for (let c = 0; c < columnCount; c++) {
    if (!spanBoxes[c].length) continue
    const sorted = spanBoxes[c].sort((p, q) => p[0] - q[0])
    const ys: number[] = []
    for (const [y0, y1] of sorted) {
      if (ys.length && y0 <= ys[ys.length - 1]) ys[ys.length - 1] = Math.max(ys[ys.length - 1], y1)
      else ys.push(y0, y1)
    }
    spans.push({ x0: minLeft[c] - INFLATE, x1: maxRight[c] + INFLATE, ys, nodes: spanNodes[c] })
  }
  return {
    topology, geometry, opt, focus, role, grid, rings, anchors, runs: new RunRegistry(), freeLeft, freeRight, gutterEnd, visibleBefore,
    cellMaxTrack, rowHalf, anchorShift, laneGaps, sides: new Map(), bands: new Map(), spans, junctionBoxes: [],
  }
}

/** Lane whose box contains y (the nearest one otherwise). */
function laneAt(geometry: Geometry, y: number): number {
  const lanes = geometry.lanes
  let lo = 0
  let hi = lanes.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (lanes[mid].y <= y) lo = mid
    else hi = mid - 1
  }
  return lo
}

// ---------------------------------------------------------------------------
// Ports: where the routed middle part starts (head) and ends (tail)

interface Port {
  x: number
  y: number
  /** Head: segments from the node to the port, starting with M. Tail: segments from the port to the node. */
  segs: PathSegment[]
  /**
   * Heights a horizontal run may use next to this port: the row gaps of its node (the one facing the
   * other end first), or the gap a wrapped-track port already sits in; empty for a point in free space.
   */
  levels: number[]
  /** Head: right end of the free gutter after the port. Tail: left end of the free gutter before it. */
  bound: number
  lane: number
}

/** Gap-run offsets from cy of a wrapped anchor: the planned one, else (dense cells) the near slot on each side. */
function gapOffsets(ctx: Context, key: string, v: number, sides: readonly number[]): number[] {
  const planned = ctx.sides.get(key)
  return planned !== undefined ? [planned] : sides.map(side => side * (ctx.rowHalf[v] - ctx.anchorShift[v]))
}

/**
 * Start and S-step run of an inner wrapped track's source (8.7): the step begins at the path start
 * (labelEnd + 4 with a leader, + 2 without) and ends NEXT_DOT_CLEAR px before the next track's dot
 * column, TRACK_STEP_MIN..TRACK_STEP px long.
 */
function innerStep(ctx: Context, v: number, leader: boolean): { start: number; run: number } {
  const box = ctx.geometry.nodes[v]
  const column = ctx.geometry.columns[ctx.topology.nodes[v].col]
  const start = box.x + box.w + (leader ? LEADER_GAP : 2)
  const nextDot = column.x + (box.track + 1) * (column.trackW + ctx.opt.trackGap) + ctx.opt.dotInset - DOT_R_MAX
  return { start, run: clamp(nextDot - NEXT_DOT_CLEAR - start, TRACK_STEP_MIN, TRACK_STEP) }
}

/**
 * Out-port of a source (8.7). With `leader` (highlighted edges) the path starts at labelEnd + 4 and
 * runs straight to the column's out-port; without it (faint edges, stubs) it starts at the track's
 * out-port. A source whose cell has labelled tracks to its right first S-steps into the row gap on
 * the target's side right after its own label and runs along the gap to the column's out-port (one
 * variant per side), so it never passes a label or dot of a later track and never seems to reach for
 * the next track's dot on its row. `shift` staggers bundle trunks.
 */
function headPorts(ctx: Context, v: number, towardY: number, shift = 0, leader = true): Port[] {
  const { geometry, opt } = ctx
  const box = geometry.nodes[v]
  const node = ctx.topology.nodes[v]
  const column = geometry.columns[node.col]
  const bound = ctx.freeRight[node.col]
  const lane = node.lane
  if (!isLabelled(box.cls)) {
    const x = box.cx + 3
    return [{ x, y: box.cy, segs: [M(x, box.cy)], levels: [], bound, lane }]
  }
  const y = box.cy + shift
  const trackOut = column.x + box.track * (column.trackW + opt.trackGap) + column.trackW - 2
  const labelEnd = box.x + box.w
  const start = leader ? labelEnd + LEADER_GAP : Math.max(trackOut, labelEnd + 2)
  const colOut = column.x + column.w - 2
  const half = ctx.rowHalf[v]
  const sides = towardY >= box.cy ? [1, -1] : [-1, 1]
  if (box.track < ctx.cellMaxTrack[v]) {
    const step = innerStep(ctx, v, leader)
    return gapOffsets(ctx, `h${v}`, v, sides).map(offset => {
      const gap = box.cy + offset
      const segs = [M(step.start, y), sStep(step.start, y, step.start + step.run, gap), L(colOut, gap)]
      return { x: colOut, y: gap, segs, levels: [gap], bound, lane }
    })
  }
  const x = Math.max(colOut, start)
  const segs = [M(start, y)]
  if (x > start) segs.push(L(x, y))
  return [{ x, y, segs, levels: sides.map(side => box.cy + side * half), bound, lane }]
}

/**
 * Entry of a target (8.7): x_in = track left − 2, then a straight run to cx − r − 1. A target in a
 * wrapped track (not the first) arrives in the row gap on the source's side at the column's entry,
 * runs along it to just before its dot column and turns straight down (or up) into the dot, so
 * nothing lies on its row between the previous track's label and its dot.
 */
function tailPorts(ctx: Context, v: number, fromY: number): Port[] {
  const { geometry, opt } = ctx
  const box = geometry.nodes[v]
  const node = ctx.topology.nodes[v]
  const column = geometry.columns[node.col]
  const bound = ctx.freeLeft[node.col]
  const lane = node.lane
  if (!isLabelled(box.cls)) return [{ x: box.cx - 3, y: box.cy, segs: [], levels: [], bound, lane }]
  const r = dotRadius(ctx.role(v), box.cls)
  const end = box.cx - r - 1
  const xIn = column.x + box.track * (column.trackW + opt.trackGap) - 2
  const half = ctx.rowHalf[v]
  const sides = fromY >= box.cy ? [1, -1] : [-1, 1]
  if (box.track > 0) {
    return gapOffsets(ctx, `t${v}`, v, sides).map(offset => {
      const gap = box.cy + offset
      return { x: column.x - 2, y: gap, segs: hookInto(box.cx, gap, box.cy + Math.sign(offset) * (r + 1)), levels: [gap], bound, lane }
    })
  }
  return [{ x: xIn, y: box.cy, segs: end > xIn ? [L(end, box.cy)] : [], levels: sides.map(side => box.cy + side * half), bound, lane }]
}

const freeHead = (x: number, y: number, bound: number, lane: number): Port => ({ x, y, segs: [M(x, y)], levels: [], bound, lane })
const freeTail = (x: number, y: number, bound: number, lane: number, levels: number[] = [], segs: PathSegment[] = []): Port =>
  ({ x, y, segs, levels, bound, lane })

// ---------------------------------------------------------------------------
// Candidates (8.8)

/** Whole path from a middle part (which starts with M at the head port). */
const assemble = (head: Port, middle: readonly PathSegment[], tail: Port): PathSegment[] => [...head.segs, ...middle.slice(1), ...tail.segs]

/** A: the plain curve of 8.7 (branches use k = 0.5 · dx, 8.9), middle part only. */
function plainMiddle(head: Port, tail: Port, branch: boolean): PathSegment[] {
  const dx = tail.x - head.x
  const k = branch ? Math.max(0, dx / 2) : plainK(dx)
  return [M(head.x, head.y), curve(head.x, head.y, tail.x, tail.y, k)]
}

function plainPath(head: Port, tail: Port, branch: boolean): PathSegment[] {
  return assemble(head, plainMiddle(head, tail, branch), tail)
}

/** Is a routed middle part clear of every label, dot and ring except its own endpoints'? */
function middleClear(ctx: Context, segs: readonly PathSegment[], skip: readonly number[]): boolean {
  return !pathHits(segs, ctx.grid, skip) && !pathHits(segs, ctx.rings, skip)
}

/** How far a horizontal run at y may go from x0 towards x1 (obstacles, rings and, unless ignored, unrelated runs). */
function reachRight(ctx: Context, y: number, x0: number, x1: number, skip: readonly number[], ends: Ends | null): number {
  const stop = ctx.rings.stopRight(y, x0, ctx.grid.stopRight(y, x0, x1, skip), skip)
  return ends ? ctx.runs.stopRight(y, x0, stop, ends) : stop
}

/** How far back from x1 towards x0 a horizontal run at y may start. */
function reachLeft(ctx: Context, y: number, x0: number, x1: number, skip: readonly number[], ends: Ends | null): number {
  const stop = ctx.rings.stopLeft(y, ctx.grid.stopLeft(y, x0, x1, skip), x1, skip)
  return ends ? ctx.runs.stopLeft(y, stop, x1, ends) : stop
}

/** Horizontal runs of an S-step tried longest first: smooth (SMOOTH × travel), halfway, the free gutter. */
function stepRuns(travel: number, gutter: number, room: number): number[] {
  const smooth = clamp(SMOOTH * travel, gutter, Math.min(SMOOTH_MAX, room))
  const runs = smooth - gutter > 8 ? [smooth, (smooth + gutter) / 2, gutter] : [Math.min(gutter, room)]
  return runs.filter(run => run <= room + 1e-9)
}

/** A height a path may use next to one of its ends. */
interface Level {
  y: number
  /** Row gaps, corridor slots and the gap a wrapped-track port sits in take runs; a node's own row never does. */
  runnable: boolean
  penalty: number
}

/**
 * Heights next to a port: its own row (left or entered by a curve only), its row gaps and the
 * lane-padding corridor slots of its lane (centre, then ± 3 px, the slot facing the far end first).
 * Corridor slots stay inside the padding band, so runs never reach a lane line, a slim lane's mini
 * row, the band header or the bottom of the plot.
 */
function portLevels(ctx: Context, port: Port, head: Port, tail: Port): Level[] {
  const out: Level[] = []
  const add = (y: number, runnable: boolean, penalty: number) => {
    if (!out.some(level => Math.abs(level.y - y) < 1e-6)) out.push({ y, runnable, penalty })
  }
  const pad = ctx.opt.lanePaddingY
  const box = ctx.geometry.lanes[port.lane]
  add(port.y, port.levels.includes(port.y), 0)
  // A row gap is a run level only inside the lane's content (a tall focus row reaches the padding).
  for (const y of port.levels) if (y === port.y || !box || (y >= box.y + pad - 1e-6 && y <= box.y + box.h - pad + 1e-6)) add(y, true, 0)
  if (box && !box.collapsed && !box.slim && box.h >= 2 * pad) {
    for (const centre of [box.y + pad / 2, box.y + box.h - pad / 2]) {
      const toward = (head.y + tail.y) / 2 >= centre ? 1 : -1
      add(centre, true, 0)
      add(centre + toward * CORRIDOR_SLOT, true, 1)
      add(centre - toward * CORRIDOR_SLOT, true, 2)
    }
  }
  return out
}

/** Transition between two heights: the 8.7 curve over a window [xa, xb]. */
const transition = (xa: number, ya: number, xb: number, yb: number): PathSegment => curve(xa, ya, xb, yb, plainK(xb - xa))

/** x-extents of labels, dots and rings (endpoints excepted) in the band between two heights over [x0, x1]. */
function bandBlocks(ctx: Context, ya: number, yb: number, x0: number, x1: number, skip: readonly number[]): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = []
  const y0 = Math.min(ya, yb)
  const y1 = Math.max(ya, yb)
  ctx.grid.blocks(x0, y0, x1, y1, skip, out)
  ctx.rings.blocks(x0, y0, x1, y1, skip, out)
  return out
}

/**
 * Horizontal run of the S-step between a port and a level: the widest band that no label, dot or
 * ring reaches (capped at a smooth SMOOTH × travel), else the longest clear of smooth / halfway /
 * free gutter; null when even the shortest step would cross something.
 */
function stepRun(ctx: Context, x: number, y: number, level: number, side: 1 | -1, gutter: number, room: number, skip: readonly number[]): number | null {
  const travel = Math.abs(level - y)
  const widest = clamp(SMOOTH * travel, STEP_RUN, SMOOTH_MAX)
  const reach = Math.min(room, widest)
  // Obstacles only change between computeRoutes calls, so the band next to a port is shared by
  // every path leaving (or entering) it at this height; endpoints are filtered per path.
  const key = `${x}|${y}|${level}|${side}`
  let blocks = ctx.bands.get(key)
  if (!blocks) {
    const near = side > 0 ? x : x - widest
    blocks = bandBlocks(ctx, y, level, near, near + widest, [])
    ctx.bands.set(key, blocks)
  }
  let free = reach
  for (const [b0, b1, owner] of blocks) {
    if (skip.includes(owner)) continue
    free = Math.min(free, side > 0 ? Math.max(0, b0 - x) : Math.max(0, x - b1))
  }
  if (free >= Math.max(STEP_RUN_MIN, Math.min(gutter, reach)) - 1e-9) return free
  const step = (run: number) => (side > 0 ? [M(x, y), sStep(x, y, x + run, level)] : [M(x - run, level), sStep(x - run, level, x, y)])
  return stepRuns(travel, gutter, room).find(run => middleClear(ctx, step(run), skip)) ?? null
}

/**
 * Where the change of height happens: the whole span if its curve is clear (B of 8.8.4), else the
 * widest window in which no label, dot or ring lies anywhere between the two heights (the free
 * column gutters always qualify), capped at 4 × the travel and centred in it. Smooth windows that
 * only clear the curve itself are tried when that band is narrower than SMOOTH × travel.
 */
function transitionWindow(
  ctx: Context, ya: number, yb: number, lo: number, hi: number, reachA: number, reachB: number, skip: readonly number[],
): [number, number] | null {
  const curveClear = (xa: number, xb: number) => middleClear(ctx, [M(xa, ya), transition(xa, ya, xb, yb)], skip)
  if (curveClear(lo, hi)) return [lo, hi]
  const travel = Math.abs(yb - ya)
  const cap = Math.max(STEP_RUN, 4 * travel)
  // Free intervals of the band over [lo, hi]: a column with any obstacle in the band blocks its
  // whole width (columns holding an endpoint are tested box by box).
  const y0 = Math.min(ya, yb)
  const y1 = Math.max(ya, yb)
  const blocks: Array<[number, number, number]> = []
  for (const span of ctx.spans) {
    if (span.x1 < lo || span.x0 > hi) continue
    if (skip.some(v => span.nodes.has(v))) {
      ctx.grid.blocks(Math.max(lo, span.x0), y0, Math.min(hi, span.x1), y1, skip, blocks)
      ctx.rings.blocks(Math.max(lo, span.x0), y0, Math.min(hi, span.x1), y1, skip, blocks)
    } else if (spanBlocked(span, y0, y1)) {
      blocks.push([span.x0, span.x1, -1])
    }
  }
  for (const [bx0, by0, bx1, by1] of ctx.junctionBoxes) if (bx1 >= lo && bx0 <= hi && by1 >= y0 && by0 <= y1) blocks.push([bx0, bx1, -1])
  blocks.sort((p, q) => p[0] - q[0])
  let best: [number, number] | null = null
  let cursor = lo
  const consider = (f0: number, f1: number) => {
    const highA = Math.min(f1, reachA)
    const lowB = Math.max(f0, reachB)
    if (f0 > highA + 1e-9 || lowB > f1 + 1e-9) return
    let xa = f0
    let xb = f1
    if (xb - xa > cap) {
      xa = clamp((f0 + f1 - cap) / 2, f0, highA)
      xb = clamp(xa + cap, lowB, f1)
    }
    if (xb - xa >= STEP_RUN_MIN - 1e-9 && (!best || xb - xa > best[1] - best[0])) best = [xa, xb]
  }
  for (const [b0, b1] of blocks) {
    if (b0 > cursor) consider(cursor, Math.min(b0, hi))
    cursor = Math.max(cursor, b1)
    if (cursor >= hi) break
  }
  if (cursor < hi) consider(cursor, hi)
  const found = best as [number, number] | null
  const width = found ? found[1] - found[0] : 0
  if (width < SMOOTH * travel) {
    for (const want of [SMOOTH * travel, 0.5 * travel]) {
      const w = clamp(want, STEP_RUN, hi - lo)
      if (w <= width) break
      const late = clamp(hi - w, lo, reachA)
      if (late + w >= reachB - 1e-9 && late + w <= hi + 1e-9 && curveClear(late, late + w)) return [late, late + w]
      const early = clamp(lo + w, reachB, hi)
      if (early - w >= lo - 1e-9 && early - w <= reachA + 1e-9 && curveClear(early - w, early)) return [early - w, early]
    }
  }
  return found
}

/**
 * B, C and the row-gap channels in one shape: S-step from the head to height `a`, run there,
 * change to height `b` inside a clear window, run there, S-step into the tail. Returns a middle
 * part already known to be clear, or null. With `ends` null the runs may lie on other paths' runs
 * (last resort before a fallback).
 */
function levelMiddle(
  ctx: Context, head: Port, tail: Port, a: Level, b: Level, skip: readonly number[], ends: Ends | null, memo: StepMemo,
): PathSegment[] | null {
  const span = tail.x - head.x
  if (span <= 0) return null
  const step0 = Math.abs(a.y - head.y) > 1e-6
  const step1 = Math.abs(tail.y - b.y) > 1e-6
  const single = Math.abs(a.y - b.y) < 1e-6
  // A single-height channel blocked between the widest possible steps is never usable.
  if (single) {
    const inner0 = head.x + (step0 ? Math.min(SMOOTH_MAX, SMOOTH * Math.abs(a.y - head.y)) : 0)
    const inner1 = tail.x - (step1 ? Math.min(SMOOTH_MAX, SMOOTH * Math.abs(tail.y - b.y)) : 0)
    if (inner1 - inner0 > 0.5 && reachRight(ctx, a.y, inner0, inner1, skip, ends) < inner1 - 1e-6) return null
  }
  let gutter0 = step0 ? clamp(head.bound - head.x, STEP_RUN_MIN, span) : 0
  let gutter1 = step1 ? clamp(tail.x - tail.bound, STEP_RUN_MIN, span) : 0
  if (gutter0 + gutter1 > span) {
    // Adjacent columns share one gutter: dip to the height and back, splitting the gutter.
    const share = gutter0 / (gutter0 + gutter1)
    gutter0 = span * share
    gutter1 = span - gutter0
  }
  let r0 = 0
  if (step0) {
    const run = memo(head, a.y, step1, () => stepRun(ctx, head.x, head.y, a.y, 1, gutter0, span - gutter1, skip))
    if (run === null) return null
    r0 = run
  }
  let r1 = 0
  if (step1) {
    const room = span - r0
    const run = memo(tail, b.y, room, () => stepRun(ctx, tail.x, tail.y, b.y, -1, gutter1, room, skip))
    if (run === null) return null
    r1 = run
  }
  const lo = head.x + r0
  const hi = tail.x - r1
  if (hi < lo - 1e-9) return null
  const segs = [M(head.x, head.y)]
  if (step0) segs.push(sStep(head.x, head.y, lo, a.y))
  if (single) {
    if (hi - lo > 0.5) {
      if (reachRight(ctx, a.y, lo, hi, skip, ends) < hi - 1e-6) return null
      segs.push(L(hi, a.y))
    }
  } else {
    if (hi - lo < STEP_RUN_MIN) return null
    const reachA = a.runnable ? reachRight(ctx, a.y, lo, hi, skip, ends) : lo
    const reachB = b.runnable ? reachLeft(ctx, b.y, lo, hi, skip, ends) : hi
    const window = transitionWindow(ctx, a.y, b.y, lo, hi, reachA, reachB, skip)
    if (!window) return null
    const [xa, xb] = window
    if (xa - lo > 0.5) segs.push(L(xa, a.y))
    segs.push(transition(xa, a.y, xb, b.y))
    if (hi - xb > 0.5) segs.push(L(hi, b.y))
  }
  if (step1) segs.push(sStep(hi, b.y, tail.x, tail.y))
  return segs
}

/** Step runs already computed for this path: per port, level and the other end's claim on the span. */
type StepMemo = (port: Port, level: number, other: boolean | number, compute: () => number | null) => number | null

function stepMemo(): StepMemo {
  const cache = new Map<Port, Map<string, number | null>>()
  return (port, level, other, compute) => {
    let byPort = cache.get(port)
    if (!byPort) cache.set(port, (byPort = new Map()))
    const key = `${level}|${other}`
    if (byPort.has(key)) return byPort.get(key) ?? null
    const run = compute()
    byPort.set(key, run)
    return run
  }
}

interface Job {
  heads: Port[]
  tails: Port[]
  /** Obstacle owners ignored for this path (its endpoints). */
  skip: number[]
  ends: Ends
  branch: boolean
  /** Same-row link skipping columns: never the plain curve (8.8). */
  sameRow: boolean
}

interface Routed {
  segments: PathSegment[]
  fallback: boolean
}

interface LevelPair {
  head: Port
  tail: Port
  a: Level
  b: Level
  /** Vertical detour: |head − a| + |a − b| + |b − tail| (+ corridor slot penalties). */
  cost: number
}

/**
 * Level pairs of every port combination, cheapest vertical detour first: two heights next to the
 * ends (own row, row gaps, corridor slots), plus every other row gap of the source and target lanes
 * as a single-height channel, so dense lanes offer one channel per row gap before runs would share.
 */
function levelPairs(ctx: Context, heads: readonly Port[], tails: readonly Port[]): LevelPair[] {
  const pairs: LevelPair[] = []
  const cost = (head: Port, tail: Port, a: Level, b: Level) => Math.abs(head.y - a.y) + Math.abs(a.y - b.y) + Math.abs(b.y - tail.y) + a.penalty + b.penalty
  for (const head of heads) {
    for (const tail of tails) {
      const as = portLevels(ctx, head, head, tail)
      const bs = portLevels(ctx, tail, head, tail)
      for (const a of as) {
        for (const b of bs) {
          if (!a.runnable && !b.runnable) continue
          if (Math.abs(a.y - b.y) < 1e-6 && !(a.runnable && b.runnable)) continue
          pairs.push({ head, tail, a, b, cost: cost(head, tail, a, b) })
        }
      }
      const near = [...as, ...bs]
      for (const lane of head.lane === tail.lane ? [head.lane] : [head.lane, tail.lane]) {
        for (const y of ctx.laneGaps[lane] ?? []) {
          if (near.some(level => Math.abs(level.y - y) < 1e-6)) continue
          const level: Level = { y, runnable: true, penalty: 0 }
          pairs.push({ head, tail, a: level, b: level, cost: cost(head, tail, level, level) })
        }
      }
    }
  }
  return pairs.sort((p, q) => p.cost - q.cost)
}

/**
 * Elbow penalty of a middle part: every change of height steeper than STEEP (vertical travel per
 * horizontal px) costs STEEP_COST px per unit of excess slope, so a smooth detour beats a cheaper
 * near-vertical drop in a narrow gutter.
 */
function steepness(segments: readonly PathSegment[]): number {
  let penalty = 0
  let x = 0
  let y = 0
  for (const s of segments) {
    if (s.op === 'C') {
      const dx = Math.max(1, s.x - x)
      penalty += Math.max(0, Math.abs(s.y - y) / dx - STEEP) * STEEP_COST
    }
    x = s.x
    y = s.y
  }
  return penalty
}

/**
 * The plain curve (A) when it is clear; otherwise the level pair with the lowest vertical detour
 * plus elbow penalty whose path clears every obstacle and lies on no run of an unrelated path.
 * When every candidate would share a run, the cheapest one that only clears obstacles is taken
 * before the plain-curve fallback. Anchor pieces (head and tail segments) are checked once per port.
 */
function route(ctx: Context, job: Job): Routed {
  const heads = job.heads.filter(head => !pathHits(head.segs, ctx.anchors, job.skip))
  const tails = job.tails.filter(tail => !pathHits(tailAnchor(tail), ctx.anchors, job.skip))
  // Ports whose fixed anchor already lies on a drawn unrelated run cannot give a clean path.
  const freeHeads = heads.filter(head => !ctx.runs.anchorClashes(head.segs, job.ends))
  const freeTails = tails.filter(tail => !ctx.runs.anchorClashes(tailAnchor(tail), job.ends))
  if (!job.sameRow) {
    for (const head of freeHeads) {
      for (const tail of freeTails) {
        const middle = plainMiddle(head, tail, job.branch)
        if (middleClear(ctx, middle, job.skip) && !ctx.runs.middleClashes(middle, job.ends)) {
          return { segments: assemble(head, middle, tail), fallback: false }
        }
      }
    }
  }
  const memo = stepMemo()
  const search = (pairs: readonly LevelPair[], ends: Ends | null, enough: number): PathSegment[] | null => {
    let best: { segments: PathSegment[]; score: number } | null = null
    let tried = 0
    let evaluated = 0
    for (const { head, tail, a, b, cost } of pairs) {
      if (best && (cost >= best.score || tried >= enough)) break
      if (++evaluated > PAIR_MAX) break
      const middle = levelMiddle(ctx, head, tail, a, b, job.skip, ends, memo)
      if (!middle || (ends && ctx.runs.middleClashes(middle, ends))) continue
      tried++
      const score = cost + steepness(middle)
      if (!best || score < best.score) best = { segments: assemble(head, middle, tail), score }
    }
    return best?.segments ?? null
  }
  const clean = freeHeads.length && freeTails.length ? search(levelPairs(ctx, freeHeads, freeTails), job.ends, SEARCH_MAX) : null
  const segments = clean ?? search(levelPairs(ctx, heads, tails), null, CROWDED_SEARCH_MAX)
  if (segments) return { segments, fallback: false }
  return { segments: plainPath(job.heads[0], job.tails[0], job.branch), fallback: true }
}

// ---------------------------------------------------------------------------
// Fan bundling and forks

interface Bundle {
  col: number
  edges: number[]
  /** Median cy of the far ends. */
  y: number
}

function median(values: number[]): number {
  const sorted = values.slice().sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * Groups of >= 3 far ends per column, lane and edge kind, sorted by median y (8.9); only when the fan
 * has >= 6 edges. Prerequisites and corequisites never share a trunk: a mixed trunk would draw
 * optional corequisites solid (dashes mean corequisite only, 7.4) and pull required prerequisites on
 * a detour to the corequisites' median (ECO200Y5: ECO101H5 / ECO102H5 up into the MAT lane). Lanes
 * never share one either: one split point for a column's targets in several lanes made a vertical
 * rail along the column's entries across lanes, which read as a link between its courses.
 */
function planBundles(ctx: Context, fan: readonly number[], candidates: readonly number[], farEnd: (edge: number) => number): Bundle[] {
  if (fan.length < FAN_MIN) return []
  const groups = new Map<string, { col: number; edges: number[] }>()
  for (const edge of candidates) {
    const { col, lane } = ctx.topology.nodes[farEnd(edge)]
    const key = `${col}|${lane}|${ctx.topology.edges[edge].kind}`
    const group = groups.get(key)
    if (group) group.edges.push(edge)
    else groups.set(key, { col, edges: [edge] })
  }
  return [...groups.values()]
    .filter(({ edges }) => edges.length >= BUNDLE_MIN)
    .map(({ col, edges }) => ({ col, edges, y: median(edges.map(edge => ctx.geometry.nodes[farEnd(edge)].cy)) }))
    .sort((a, b) => a.y - b.y || a.col - b.col || bundleKindOrder(ctx.topology, a.edges) - bundleKindOrder(ctx.topology, b.edges))
}

const bundleKindOrder = (topology: Topology, edges: readonly number[]) => (topology.edges[edges[0]].kind === 'coreq' ? 1 : 0)

const staggerOf = (i: number, count: number) => clamp((i - (count - 1) / 2) * STAGGER, -STAGGER_MAX, STAGGER_MAX)

const bundleKind = (topology: Topology, edges: readonly number[]): EdgeKind =>
  edges.every(edge => topology.edges[edge].kind === 'coreq') ? 'coreq' : 'prereq'

interface Junction {
  x: number
  y: number
  edges: number[]
}

/** Parsed `any` groups with >= 2 routed direct prerequisites converge on junctions in front of the focus. */
function planJunctions(ctx: Context, anyGroups: readonly number[][], directIn: ReadonlyMap<number, number>): Junction[] {
  const focus = ctx.focus
  const used = new Set<number>()
  const groups: number[][] = []
  for (const group of anyGroups) {
    const edges: number[] = []
    for (const source of group) {
      const edge = directIn.get(source)
      if (edge === undefined || used.has(source)) continue
      used.add(source)
      edges.push(edge)
    }
    if (edges.length >= 2) groups.push(edges)
  }
  if (!groups.length) return []
  // Groups fed from higher rows take the higher junctions, so approaches never cross a junction.
  const sourceY = (edge: number) => ctx.geometry.nodes[ctx.topology.edges[edge].from].cy
  groups.sort((a, b) => median(a.map(sourceY)) - median(b.map(sourceY)))
  const box = ctx.geometry.nodes[focus]
  const column = ctx.geometry.columns[ctx.topology.nodes[focus].col]
  const xIn = column.x + box.track * (column.trackW + ctx.opt.trackGap) - 2
  // Kept inside the free gutter (the glyph never covers a label of the previous column) and past
  // every member's out-port (sources in the previous column end only ~20 px before the focus).
  let lastOut = -Infinity
  for (const edges of groups) {
    for (const edge of edges) lastOut = Math.max(lastOut, headPorts(ctx, ctx.topology.edges[edge].from, box.cy)[0].x)
  }
  const earliest = Math.max(xIn - JUNCTION_BEFORE, ctx.freeLeft[ctx.topology.nodes[focus].col] + JUNCTION_R, lastOut + JUNCTION_R + STEP_RUN_MIN)
  const x = Math.min(xIn - JUNCTION_R - 2, earliest)
  // Junctions stack at cy ± 10 k. When other direct prerequisites also enter the focus, the stack
  // shifts by half steps so the entry line at cy and their source rows stay clear of glyphs.
  const memberEdges = new Set(groups.flat())
  const others = [...directIn.values()].filter(edge => !memberEdges.has(edge)).map(edge => ctx.geometry.nodes[ctx.topology.edges[edge].from].cy)
  const clearance = JUNCTION_R + INFLATE + 2
  let best = 0
  let bestCost = Infinity
  for (const shift of others.length ? [0, 0.5, -0.5, 1, -1] : [0]) {
    const ys = groups.map((_, k) => box.cy + (k - (groups.length - 1) / 2 + shift) * JUNCTION_STACK)
    const blocked = (y: number) => ys.some(jy => Math.abs(jy - y) < clearance)
    const cost = (others.length && blocked(box.cy) ? others.length + 1 : 0) + others.filter(blocked).length
    if (cost < bestCost) {
      best = shift
      bestCost = cost
    }
  }
  return groups.map((edges, k) => ({ x, y: box.cy + (k - (groups.length - 1) / 2 + best) * JUNCTION_STACK, edges }))
}

/** A wrapped-track anchor wanted by one edge: its node, whether it is the edge's source, and the edge's other end. */
interface AnchorWant {
  v: number
  head: boolean
  far: number
}

/** A planned anchor: `pull` sums the sides of its far ends; `far` is the single far end of all its edges, or -1. */
interface Anchor {
  v: number
  head: boolean
  pull: number
  far: number
}

/**
 * Row-gap runs of wrapped-track anchors (8.7). A source in an inner track runs along the gap above
 * or below its row to the column's out-port, a target in a later track arrives along one and turns
 * into its dot. Two such runs in one gap would read as one line between two courses of the same
 * column (product rule), so no two anchors that overlap in x may share a slot:
 * - each gap has two slots 3 px apart, one next to each neighbouring row (anchorShift);
 * - per row of a cell, the assignment that places the most anchors in their own row's slots, then
 *   agrees most with the side facing their far ends, is taken (a node in a middle track may put its
 *   head and tail in one slot: they never overlap);
 * - an anchor left over takes the neighbour row's slot of a gap where that is free over its span.
 * An anchor with no free slot keeps both near slots for the router (dense cells only).
 */
function planAnchorSides(ctx: Context, wants: readonly AnchorWant[], leader = true) {
  const { geometry, opt } = ctx
  const anchors = new Map<string, Anchor>()
  for (const want of wants) {
    const box = geometry.nodes[want.v]
    if (!isLabelled(box.cls) || (want.head ? box.track >= ctx.cellMaxTrack[want.v] : box.track === 0)) continue
    const key = `${want.head ? 'h' : 't'}${want.v}`
    const anchor = anchors.get(key) ?? { v: want.v, head: want.head, pull: 0, far: want.far }
    anchor.pull += Math.sign(geometry.nodes[want.far].cy - box.cy)
    if (anchor.far !== want.far) anchor.far = -1
    anchors.set(key, anchor)
  }
  // A source's gap run starts where its S-step ends; a target's ends where its hook turns. The hook
  // itself (and the drop into the dot) counts as part of the run here, so a source stepping into the
  // same gap further left can never meet it.
  const runOf = (v: number, head: boolean, offset: number): HorizontalRun => {
    const box = geometry.nodes[v]
    const column = geometry.columns[ctx.topology.nodes[v].col]
    const y = box.cy + offset
    if (head) {
      const step = innerStep(ctx, v, leader)
      return { y, x0: step.start + step.run, x1: column.x + column.w - 2 }
    }
    return { y, x0: column.x - 2, x1: box.cx + opt.dotInset }
  }
  const near = (v: number, side: number) => side * (ctx.rowHalf[v] - ctx.anchorShift[v])
  // Two sources' runs may share a slot when every edge of both ends at one and the same target (and
  // two targets' when every edge comes from one source): that is a bus of related edges (8.8.6),
  // never a link between the two courses. A source's and a target's runs never may.
  const taken: Array<{ run: HorizontalRun; anchor: Anchor }> = []
  const shareable = (a: Anchor, b: Anchor) => a.head === b.head && a.far >= 0 && a.far === b.far
  const clash = (a: HorizontalRun, b: HorizontalRun) => Math.abs(a.y - b.y) < RUN_CLEAR && Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > RUN_OVERLAP
  const free = (run: HorizontalRun, anchor: Anchor) => !taken.some(other => !shareable(other.anchor, anchor) && clash(other.run, run))
  const take = (key: string, anchor: Anchor, offset: number) => {
    ctx.sides.set(key, offset)
    taken.push({ run: runOf(anchor.v, anchor.head, offset), anchor })
  }
  const rows = new Map<string, Array<[string, Anchor]>>()
  for (const entry of anchors) {
    const v = entry[1].v
    const key = `${ctx.topology.nodes[v].lane}|${ctx.topology.nodes[v].col}|${geometry.nodes[v].cy}`
    const list = rows.get(key)
    if (list) list.push(entry)
    else rows.set(key, [entry])
  }
  const firstOf = (list: Array<[string, { v: number }]>) => geometry.nodes[list[0][1].v]
  const order = [...rows.values()].sort((a, b) => firstOf(a).cx - firstOf(b).cx || firstOf(a).cy - firstOf(b).cy)
  const leftOver: Array<[string, Anchor]> = []
  for (const row of order) {
    row.sort(([, a], [, b]) => geometry.nodes[a.v].track - geometry.nodes[b.v].track || Number(a.head) - Number(b.head))
    const runs = row.map(([, a]) => [runOf(a.v, a.head, near(a.v, 1)), runOf(a.v, a.head, near(a.v, -1))] as const)
    const usable = runs.map(([below, above], i) => [free(below, row[i][1]), free(above, row[i][1])] as const)
    const rest = row.map(() => 0)
    for (let i = row.length - 1; i >= 0; i--) rest[i] = (rest[i + 1] ?? 0) + Math.abs(row[i][1].pull) + 1
    const chosen: Array<0 | 1 | -1> = row.map(() => 0)
    let best: Array<0 | 1 | -1> = chosen.slice()
    let bestScore = -1
    const visit = (i: number, placed: number, score: number) => {
      if (i === row.length) {
        if (placed * 1000 + score > bestScore) {
          bestScore = placed * 1000 + score
          best = chosen.slice()
        }
        return
      }
      // Even placing every remaining anchor on its preferred side could not beat the best so far.
      if ((placed + row.length - i) * 1000 + score + rest[i] <= bestScore) return
      const { pull } = row[i][1]
      const preferred: 1 | -1 = pull >= 0 ? 1 : -1
      const sides: Array<1 | -1> = preferred > 0 ? [1, -1] : [-1, 1]
      for (const side of sides) {
        const slot = side > 0 ? 0 : 1
        const conflict = (other: 0 | 1 | -1, k: number) => k < i && other === side && !shareable(row[k][1], row[i][1]) && clash(runs[k][slot], runs[i][slot])
        if (!usable[i][slot] || chosen.some(conflict)) continue
        chosen[i] = side
        visit(i + 1, placed + 1, score + (side === preferred ? Math.abs(pull) + 1 : 0))
        chosen[i] = 0
      }
      visit(i + 1, placed, score)
    }
    visit(0, 0, 0)
    row.forEach((entry, i) => {
      const [key, a] = entry
      if (best[i]) take(key, a, near(a.v, best[i]))
      else leftOver.push(entry)
    })
  }
  // The neighbour row's slot of the gap above or below (3 px further out), inside the lane's content.
  const pad = opt.lanePaddingY
  const offsets = (a: Anchor, far: boolean) => (a.pull >= 0 ? [1, -1] : [-1, 1])
    .map(side => side * (ctx.rowHalf[a.v] + (far ? 1 : -1) * ctx.anchorShift[a.v]))
    .filter(offset => {
      const lane = geometry.lanes[ctx.topology.nodes[a.v].lane]
      const y = geometry.nodes[a.v].cy + offset
      return y >= lane.y + pad - 1e-6 && y <= lane.y + lane.h - pad + 1e-6
    })
  const stillOver: Array<[string, Anchor]> = []
  for (const entry of leftOver) {
    const [key, a] = entry
    const offset = ctx.anchorShift[a.v] ? offsets(a, true).find(o => free(runOf(a.v, a.head, o), a)) : undefined
    if (offset === undefined) stillOver.push(entry)
    else take(key, a, offset)
  }
  // Dense cells only: a slot shared with runs of the same kind (sources with sources, targets with
  // targets) reads as a bus, never as a source reaching a target of its own column; take one rather
  // than leave the choice to chance.
  for (const [key, a] of stillOver) {
    const sameKindOnly = (o: number) => {
      const run = runOf(a.v, a.head, o)
      return !taken.some(other => other.anchor.head !== a.head && clash(other.run, run))
    }
    const offset = [...offsets(a, false), ...(ctx.anchorShift[a.v] ? offsets(a, true) : [])].find(sameKindOnly)
    if (offset !== undefined) take(key, a, offset)
  }
}

// ---------------------------------------------------------------------------
// Entry points

interface Task {
  meta: Omit<RoutedPath, 'segments'>
  job: Job
  /** Direct edges, trunks and branches are routed first, so the most prominent lines get the best corridors. */
  direct: boolean
}

/**
 * Routes every edge whose role is a chain or program role. Output order: plain edges (by edge
 * index), then bundle trunks with their branches, then fork stubs. A fork stub's first point is
 * the junction centre (glyph r 3.5, drawn on top); edges of that group end at the same point. Lane
 * padding, row heights and the track gap come from the options the geometry was computed with.
 */
export function computeRoutes(topology: Topology, presentation: Presentation, geometry: Geometry, input: RouteInput): Routes {
  const { cls, edgeRole } = presentation
  const routed: number[] = []
  topology.edges.forEach((edge, e) => {
    if (ROUTED.has(edgeRole[e]) && cls[edge.from] !== 'hidden' && cls[edge.to] !== 'hidden') routed.push(e)
  })
  if (!routed.length) return { paths: [], fallbacks: 0 }
  const ctx = buildContext(topology, presentation, geometry, true)
  const { focus } = ctx
  const nodes = geometry.nodes
  const edges = topology.edges

  const directIn = new Map<number, number>()
  const directOut: number[] = []
  if (focus >= 0) {
    for (const e of routed) {
      if (edges[e].to === focus && edgeRole[e] === 'prereq-direct') directIn.set(edges[e].from, e)
      if (edges[e].from === focus && edgeRole[e] === 'unlock-direct') directOut.push(e)
    }
  }
  const junctions = focus >= 0 ? planJunctions(ctx, input.anyGroups, directIn) : []
  const junctionOf = new Map<number, number>()
  junctions.forEach((junction, k) => {
    for (const e of junction.edges) junctionOf.set(e, k)
    ctx.junctionBoxes.push([junction.x - JUNCTION_R - INFLATE, junction.y - JUNCTION_R - INFLATE, junction.x + JUNCTION_R + INFLATE, junction.y + JUNCTION_R + INFLATE])
    ctx.grid.add(junction.x - JUNCTION_R, junction.y - JUNCTION_R, junction.x + JUNCTION_R, junction.y + JUNCTION_R, junctionOwner(k))
    ctx.anchors.add(junction.x - JUNCTION_R, junction.y - JUNCTION_R, junction.x + JUNCTION_R, junction.y + JUNCTION_R, junctionOwner(k))
  })
  const directInEdges = [...directIn.values()]
  const unlockBundles = planBundles(ctx, directOut, directOut, e => edges[e].to)
  const prereqBundles = planBundles(ctx, directInEdges, directInEdges.filter(e => !junctionOf.has(e)), e => edges[e].from)
  const mergedIn = new Set(prereqBundles.flatMap(bundle => bundle.edges))
  planAnchorSides(ctx, routed.flatMap(e => {
    const { from, to } = edges[e]
    const wants: AnchorWant[] = [{ v: from, head: true, far: to }]
    if (!junctionOf.has(e) && !mergedIn.has(e)) wants.push({ v: to, head: false, far: from })
    return wants
  }))
  const bundled = new Set<number>()
  for (const bundle of [...unlockBundles, ...prereqBundles]) for (const e of bundle.edges) bundled.add(e)
  const isDirect = (role: EdgeRole) => role === 'prereq-direct' || role === 'unlock-direct'

  const tasks: Task[] = []
  for (const e of routed) {
    if (bundled.has(e)) continue
    const { from, to, kind } = edges[e]
    const meta = { edge: e, role: edgeRole[e], kind, shape: 'edge' as const }
    const ends = { from, to }
    const k = junctionOf.get(e)
    const heads = headPorts(ctx, from, k === undefined ? nodes[to].cy : junctions[k].y)
    if (k !== undefined) {
      const junction = junctions[k]
      const tail = freeTail(junction.x, junction.y, ctx.freeLeft[topology.nodes[focus].col], topology.nodes[focus].lane)
      tasks.push({ meta, job: { heads, tails: [tail], skip: [from, to, junctionOwner(k)], ends, branch: false, sameRow: false }, direct: true })
      continue
    }
    const tails = tailPorts(ctx, to, nodes[from].cy)
    if (junctions.length && to === focus) {
      // Other direct prerequisites may also arrive left of the junction column and run straight
      // to the focus between stacked junctions.
      const lead = tails[0]
      const x = junctions[0].x - JUNCTION_R - INFLATE - MARGIN
      if (x < lead.x) tails.push({ ...lead, x, segs: [L(lead.x, lead.y), ...lead.segs], levels: [] })
    }
    const colFrom = topology.nodes[from].col
    const colTo = topology.nodes[to].col
    const sameRow = Math.abs(nodes[from].cy - nodes[to].cy) < 0.5 && ctx.visibleBefore[colTo] - ctx.visibleBefore[colFrom + 1] > 0
    tasks.push({ meta, job: { heads, tails, skip: [from, to], ends, branch: false, sameRow }, direct: isDirect(edgeRole[e]) })
  }

  unlockBundles.forEach((bundle, i) => {
    const column = geometry.columns[bundle.col]
    const heads = headPorts(ctx, focus, bundle.y, staggerOf(i, unlockBundles.length))
    // 22 px before the column (8.9), but never left of the middle of the free gutter, so the trunk
    // keeps room to turn into the split point when the gutter is narrow (columnGap 24, hidden
    // columns); in the column right after the focus it must still lie past the out-port.
    const middle = (ctx.freeLeft[bundle.col] + ctx.gutterEnd[bundle.col]) / 2
    const x = Math.max(column.x - SPLIT_BEFORE, middle, heads[0].x + STEP_RUN_MIN)
    const lane = laneAt(geometry, bundle.y)
    const tail = freeTail(x, bundle.y, ctx.freeLeft[bundle.col], lane)
    tasks.push({
      meta: { edge: -1, role: 'unlock-direct', kind: bundleKind(topology, bundle.edges), shape: 'trunk' },
      job: { heads, tails: [tail], skip: [focus], ends: { from: focus, to: -1 }, branch: false, sameRow: false },
      direct: true,
    })
    for (const e of bundle.edges) {
      const to = edges[e].to
      const job: Job = { heads: [freeHead(x, bundle.y, column.x - 1, lane)], tails: tailPorts(ctx, to, bundle.y), skip: [focus, to], ends: { from: focus, to }, branch: true, sameRow: false }
      tasks.push({ meta: { edge: e, role: edgeRole[e], kind: edges[e].kind, shape: 'branch' }, job, direct: true })
    }
  })

  if (prereqBundles.length) {
    const focusBox = nodes[focus]
    const focusCol = geometry.columns[topology.nodes[focus].col]
    const xIn = focusCol.x + focusBox.track * (focusCol.trackW + ctx.opt.trackGap) - 2
    const end = focusBox.cx - dotRadius('focus', focusBox.cls) - 1
    const focusLane = topology.nodes[focus].lane
    const focusGaps = (y: number) => (y >= focusBox.cy ? [1, -1] : [-1, 1]).map(side => focusBox.cy + side * ctx.rowHalf[focus])
    prereqBundles.forEach((bundle, i) => {
      const column = geometry.columns[bundle.col]
      const colOut = column.x + column.w - 2
      const x = colOut + clamp(ctx.freeRight[bundle.col] - colOut - 4, 4, MERGE_AFTER)
      const lane = laneAt(geometry, bundle.y)
      for (const e of bundle.edges) {
        const from = edges[e].from
        const job: Job = { heads: headPorts(ctx, from, bundle.y), tails: [freeTail(x, bundle.y, colOut, lane)], skip: [from, focus], ends: { from, to: focus }, branch: true, sameRow: false }
        tasks.push({ meta: { edge: e, role: edgeRole[e], kind: edges[e].kind, shape: 'branch' }, job, direct: true })
      }
      // The trunk end is staggered around the focus row and S-steps into it before the entry, so
      // every trunk meets the focus dot. A merge point too close to the entry for that step (the
      // bundle column right before the focus) leads straight into the focus row instead.
      const room = xIn - TRUNK_STEP - x >= STEP_RUN_MIN
      const y = room ? focusBox.cy + staggerOf(i, prereqBundles.length) : focusBox.cy
      const segs: PathSegment[] = []
      let tailX = xIn
      if (y !== focusBox.cy) {
        tailX = xIn - TRUNK_STEP
        segs.push(sStep(tailX, y, xIn, focusBox.cy))
      }
      if (end > xIn) segs.push(L(end, focusBox.cy))
      const tail = freeTail(tailX, y, ctx.freeLeft[topology.nodes[focus].col], focusLane, focusGaps(bundle.y), segs)
      const job: Job = { heads: [freeHead(x, bundle.y, ctx.freeRight[bundle.col], lane)], tails: [tail], skip: [focus], ends: { from: -1, to: focus }, branch: false, sameRow: false }
      tasks.push({ meta: { edge: -1, role: 'prereq-direct', kind: bundleKind(topology, bundle.edges), shape: 'trunk' }, job, direct: true })
    })
  }

  for (const { job } of tasks) {
    for (const head of job.heads) ctx.runs.reserve(head.segs, job.ends)
    for (const tail of job.tails) ctx.runs.reserve(tailAnchor(tail), job.ends)
  }
  const paths = new Array<RoutedPath>(tasks.length)
  let fallbacks = 0
  const order = tasks.map((_, i) => i).sort((a, b) => Number(tasks[b].direct) - Number(tasks[a].direct) || a - b)
  for (const i of order) {
    const { meta, job } = tasks[i]
    const result = route(ctx, job)
    if (result.fallback) fallbacks++
    else ctx.runs.add(result.segments, job.ends)
    paths[i] = { ...meta, segments: result.segments }
  }

  if (junctions.length) {
    const box = nodes[focus]
    const column = geometry.columns[topology.nodes[focus].col]
    const xIn = column.x + box.track * (column.trackW + ctx.opt.trackGap) - 2
    const end = box.cx - dotRadius('focus', box.cls) - 1
    for (const junction of junctions) {
      const segments: PathSegment[] = [M(junction.x, junction.y)]
      segments.push(junction.y === box.cy ? L(xIn, box.cy) : curve(junction.x, junction.y, xIn, box.cy, (xIn - junction.x) / 2))
      if (end > xIn) segments.push(L(end, box.cy))
      paths.push({ edge: -1, role: 'prereq-direct', kind: 'prereq', shape: 'fork', segments })
    }
  }
  return { paths, fallbacks }
}

/** Options of the shared overview anchors. */
export interface PlainEdgeOptions {
  /**
   * Node roles, for exact dot radii at the entry (cx − r − 1). Without it every node uses its
   * class's overview radius; the run then ends a little further under the dot, which is drawn on top.
   */
  presentation?: Presentation
  /** Start at labelEnd + 4 with a straight leader, like a highlighted edge (8.7). Faint edges and stubs start at the out-port. */
  leader?: boolean
  /**
   * Edges drawn together with these (default: `edges` itself). Wrapped-track anchors take their row
   * gap sides from all of them (see planAnchorSides), so a source's gap run and a later-track
   * target's gap run never meet in one gap and read as a link inside one column; pass the same list
   * to every call that draws one picture (faint edges and stubs) so an edge keeps its anchors.
   */
  planWith?: readonly number[]
  /**
   * Faint overview texture only: where a dense wrapped cell has no free row-gap slot for an anchor,
   * the edge stops at the column's entry (or starts at its out-port) instead of sharing a gap with
   * an edge of the opposite direction, which would read as a link between two courses of the
   * column. `onTruncate` receives each cut end (a terminal dot goes there, as on stubs, 8.10); a
   * stub half that would start or end at such an anchor is left empty.
   */
  truncateUnplaced?: boolean
  onTruncate?: (edge: number, x: number, y: number) => void
}

/** A wrapped-track anchor the planner could not place (dense cells), see PlainEdgeOptions.truncateUnplaced. */
function unplaced(ctx: Context, v: number, head: boolean): boolean {
  const box = ctx.geometry.nodes[v]
  if (!isLabelled(box.cls)) return false
  const wrapped = head ? box.track < ctx.cellMaxTrack[v] : box.track > 0
  return wrapped && !ctx.sides.has(`${head ? 'h' : 't'}${v}`)
}

/**
 * Plans keyed by the `planWith` array they were made for: the renderer passes one array for the faint
 * layer, the stubs and the hover previews of a scene, so the plan is made once per scene.
 */
const plainPlans = new WeakMap<readonly number[], { topology: Topology; geometry: Geometry; presentation: Presentation | null; ctx: Context }>()

/**
 * Context with the row-gap sides of wrapped-track anchors planned over `edges` (no obstacles). The
 * plan always uses the faint start (labelEnd + 2), so a hover preview with the leader keeps exactly
 * the anchors of the faint edge underneath it.
 */
function plainContext(topology: Topology, geometry: Geometry, edges: readonly number[], options: PlainEdgeOptions): Context {
  const presentation = options.presentation ?? null
  const cached = options.planWith ? plainPlans.get(options.planWith) : undefined
  if (cached && cached.topology === topology && cached.geometry === geometry && cached.presentation === presentation) return cached.ctx
  const ctx = buildContext(topology, presentation, geometry, false)
  const wants: AnchorWant[] = []
  for (const e of options.planWith ?? edges) {
    const { from, to } = topology.edges[e]
    wants.push({ v: from, head: true, far: to }, { v: to, head: false, far: from })
  }
  planAnchorSides(ctx, wants, false)
  if (options.planWith) plainPlans.set(options.planWith, { topology, geometry, presentation, ctx })
  return ctx
}

/**
 * Plain anchored curves (8.7, no corridor routing) for any edges: faint overview edges, hover
 * previews and the base of long-edge stubs (8.10) all use these anchors. A source in a wrapped
 * track that is not the last of its cell steps into the row gap right after its label and runs to
 * the column's out-port; a target in a later track arrives through the row gap and drops into its
 * dot from above or below. So no plain edge passes a label or dot of its own columns or seems to
 * link two of its courses (product rule: no edge inside one column). `edges` are indices into
 * `topology.edges`.
 *
 * The older argument order `(topology, presentation, geometry, edges, geometryOptions?)` is still
 * accepted: it starts every path at labelEnd + 4 (with the leader) and ignores the options, which
 * now come from the geometry itself.
 */
export function plainEdgePaths(topology: Topology, geometry: Geometry, edges: readonly number[], options?: PlainEdgeOptions): PathSegment[][]
export function plainEdgePaths(
  topology: Topology, presentation: Presentation, geometry: Geometry, edges: readonly number[], geometryOptions?: Partial<GeometryOptions>,
): PathSegment[][]
export function plainEdgePaths(
  topology: Topology,
  first: Geometry | Presentation,
  second: Geometry | readonly number[],
  third?: PlainEdgeOptions | readonly number[],
): PathSegment[][] {
  const legacy = 'cls' in first
  const geometry = (legacy ? second : first) as Geometry
  const edges = (legacy ? third : second) as readonly number[]
  const options: PlainEdgeOptions = legacy ? { presentation: first, leader: true } : (third as PlainEdgeOptions | undefined) ?? {}
  const ctx = plainContext(topology, geometry, edges, options)
  return edges.map(e => {
    const { from, to } = topology.edges[e]
    let head = headPorts(ctx, from, geometry.nodes[to].cy, 0, options.leader ?? false)[0]
    let tail = tailPorts(ctx, to, geometry.nodes[from].cy)[0]
    if (options.truncateUnplaced && unplaced(ctx, from, true)) {
      head = freeHead(head.x, head.y, head.bound, head.lane)
      options.onTruncate?.(e, head.x, head.y)
    }
    if (options.truncateUnplaced && unplaced(ctx, to, false)) {
      tail = freeTail(tail.x, tail.y, tail.bound, tail.lane)
      options.onTruncate?.(e, tail.x, tail.y)
    }
    return plainPath(head, tail, false)
  })
}

/** Both halves of an overview long-edge stub (8.10), on the same anchors as `plainEdgePaths`. */
export interface EdgeStubs {
  /** From the source to its column's out-port (through the row gap for an inner wrapped track), then 14 px on; the terminal dot sits at the last point. */
  source: PathSegment[]
  /** From the terminal dot 10 px before the target's entry into its dot (through the row gap and down or up into it for a later wrapped track). */
  target: PathSegment[]
}

export function plainEdgeStubs(topology: Topology, geometry: Geometry, edges: readonly number[], options: PlainEdgeOptions = {}): EdgeStubs[] {
  const ctx = plainContext(topology, geometry, edges, options)
  return edges.map(e => {
    const { from, to } = topology.edges[e]
    const head = headPorts(ctx, from, geometry.nodes[to].cy, 0, options.leader ?? false)[0]
    const tail = tailPorts(ctx, to, geometry.nodes[from].cy)[0]
    return {
      source: options.truncateUnplaced && unplaced(ctx, from, true) ? [] : [...head.segs, L(head.x + STUB_SOURCE, head.y)],
      target: options.truncateUnplaced && unplaced(ctx, to, false) ? [] : [M(tail.x - STUB_TARGET, tail.y), L(tail.x, tail.y), ...tail.segs],
    }
  })
}
