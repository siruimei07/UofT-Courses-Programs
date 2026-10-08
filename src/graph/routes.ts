// Highlighted edges as world-space paths (design-spec 8.7-8.9, 7.4): anchors and curves, corridor
// routing around labels and dots, fan bundling and "any one of" fork junctions. Pure: Topology +
// Presentation + Geometry in, path segments out. Only chain and program edges are routed.
import { DEFAULT_GEOMETRY_OPTIONS } from './geometry'
import type {
  DisplayClass, EdgeKind, EdgeRole, Geometry, GeometryOptions, NodeRole, PathSegment, Presentation, RoutedPath,
  RouteInput, Routes, Topology,
} from './types'

const ROUTED: ReadonlySet<EdgeRole> = new Set<EdgeRole>(['prereq-direct', 'prereq', 'unlock-direct', 'unlock', 'program'])

/** Hit test (8.8): obstacles inflated by 2 px in a 64 px grid; at least 20 samples per curve. */
const INFLATE = 2
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
/** S-step into a row gap at a wrapped track (8.7) and into / out of a corridor (8.8). */
const TRACK_STEP = 14
const STEP_RUN = 20
const STEP_RUN_MIN = 6
/** Horizontal room of the final curve of a lane-padding corridor into the target's left gutter. */
const GUTTER_RUN = 24
const CORRIDOR_OFFSET = 3

/** Fan bundling (8.9). */
const FAN_MIN = 6
const BUNDLE_MIN = 3
const SPLIT_BEFORE = 22
const MERGE_AFTER = 14
const STAGGER = 3
const STAGGER_MAX = 9

/** Fork junction (7.4). */
const JUNCTION_BEFORE = 28
const JUNCTION_R = 3.5
const JUNCTION_STACK = 20
/** Obstacle owner ids of junctions: -2, -3, ... (node indices are >= 0). */
const junctionOwner = (k: number) => -2 - k

/** Dot radius of design-spec 7.1 (world px); geometry has no radii, so entries and dot boxes use these. */
export function dotRadius(role: NodeRole, cls: DisplayClass): number {
  if (cls === 'hidden') return 0
  if (cls === 'mini') return 2.25
  if (role === 'focus') return 8.5
  if (role === 'prereq-direct' || role === 'unlock-direct') return 5
  if (role === 'none' && cls === 'compact') return 3.75
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

/** Short S between two rows (horizontal tangents, control points at mid-run). */
const sStep = (x0: number, y0: number, x1: number, y1: number): PathSegment => curve(x0, y0, x1, y1, (x1 - x0) / 2)

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

// ---------------------------------------------------------------------------
// Obstacles

class ObstacleGrid {
  private readonly cells = new Map<number, number[]>()
  private readonly box: number[] = []
  private readonly owner: number[] = []

  /** Adds a box (inflated by INFLATE) owned by a node index or a junction id. */
  add(x0: number, y0: number, x1: number, y1: number, owner: number) {
    const id = this.owner.length
    this.box.push(x0 - INFLATE, y0 - INFLATE, x1 + INFLATE, y1 + INFLATE)
    this.owner.push(owner)
    for (let gx = cellOf(x0 - INFLATE); gx <= cellOf(x1 + INFLATE); gx++) {
      for (let gy = cellOf(y0 - INFLATE); gy <= cellOf(y1 + INFLATE); gy++) {
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

// ---------------------------------------------------------------------------
// Context: obstacles, gutters and row gaps

interface Context {
  topology: Topology
  presentation: Presentation
  geometry: Geometry
  opt: GeometryOptions
  focus: number
  grid: ObstacleGrid
  /** Per column: left end of the free gutter before it / right end of the free gutter after it. */
  freeLeft: Float64Array
  freeRight: Float64Array
  /** Per column: number of visible columns before it (same-row rule). */
  visibleBefore: Int32Array
  /** Per labelled node: highest track used by labelled nodes of its cell, and half its row pitch. */
  cellMaxTrack: Int32Array
  rowHalf: Float64Array
}

const isLabelled = (cls: DisplayClass) => cls === 'full' || cls === 'compact'

function buildContext(
  topology: Topology,
  presentation: Presentation,
  geometry: Geometry,
  options: Partial<GeometryOptions>,
  obstacles = true,
): Context {
  const opt: GeometryOptions = { ...DEFAULT_GEOMETRY_OPTIONS }
  for (const [key, value] of Object.entries(options)) if (value !== undefined) (opt as unknown as Record<string, unknown>)[key] = value
  const { cls, role } = presentation
  const n = topology.nodes.length
  const focusIndex = role.indexOf('focus')
  const focus = focusIndex >= 0 && isLabelled(cls[focusIndex]) ? focusIndex : -1
  const grid = new ObstacleGrid()
  const columnCount = geometry.columns.length
  const minLeft = new Float64Array(columnCount).fill(Infinity)
  const maxRight = new Float64Array(columnCount).fill(-Infinity)
  const cellMaxTrack = new Int32Array(n)
  const rowHalf = new Float64Array(n)
  const rowHeight = (v: number) => (v === focus ? geometry.nodes[v].h : opt.rowHeight[cls[v] as 'full' | 'compact'])

  topology.cells.forEach(row => row.forEach(cell => {
    let maxTrack = 0
    let pitch = 0
    for (const v of cell) {
      if (!isLabelled(cls[v])) continue
      maxTrack = Math.max(maxTrack, geometry.nodes[v].track)
      pitch = Math.max(pitch, rowHeight(v))
    }
    for (const v of cell) {
      if (!isLabelled(cls[v])) continue
      cellMaxTrack[v] = maxTrack
      rowHalf[v] = (maxTrack > 0 ? pitch : rowHeight(v)) / 2
    }
  }))

  for (let v = 0; v < n; v++) {
    if (!isLabelled(cls[v])) continue
    const box = geometry.nodes[v]
    const r = dotRadius(role[v], cls[v]) + 2
    if (obstacles) {
      grid.add(box.x, box.y, box.x + box.w, box.y + box.h, v)
      grid.add(box.cx - r, box.cy - r, box.cx + r, box.cy + r, v)
    }
    const col = topology.nodes[v].col
    minLeft[col] = Math.min(minLeft[col], box.x, box.cx - r)
    maxRight[col] = Math.max(maxRight[col], box.x + box.w, box.cx + r)
  }

  const freeLeft = new Float64Array(columnCount)
  const freeRight = new Float64Array(columnCount)
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
  return { topology, presentation, geometry, opt, focus, grid, freeLeft, freeRight, visibleBefore, cellMaxTrack, rowHalf }
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
  /** Row gaps candidate B may step into, the one facing the other end first; empty when the port sits in free space. */
  gaps: number[]
  /** Head: right end of the free gutter after the port. Tail: left end of the free gutter before it. */
  bound: number
  lane: number
}

/**
 * Out-port of a source (8.7): straight leader from labelEnd + 4 to the column's out-port. A source
 * whose cell has labelled tracks to its right first S-steps into the row gap on the target's side
 * and runs along it to the column's out-port (one variant per side). `shift` staggers bundle trunks.
 */
function headPorts(ctx: Context, v: number, towardY: number, shift = 0): Port[] {
  const { geometry, opt } = ctx
  const box = geometry.nodes[v]
  const node = ctx.topology.nodes[v]
  const column = geometry.columns[node.col]
  const bound = ctx.freeRight[node.col]
  const lane = node.lane
  if (!isLabelled(box.cls)) {
    const x = box.cx + 3
    return [{ x, y: box.cy, segs: [M(x, box.cy)], gaps: [], bound, lane }]
  }
  const y = box.cy + shift
  const start = box.x + box.w + LEADER_GAP
  const colOut = column.x + column.w - 2
  const half = ctx.rowHalf[v]
  const sides = towardY >= box.cy ? [1, -1] : [-1, 1]
  if (box.track < ctx.cellMaxTrack[v]) {
    const trackOut = Math.max(start, column.x + box.track * (column.trackW + opt.trackGap) + column.trackW - 2)
    return sides.map(side => {
      const gap = box.cy + side * half
      const segs = [M(start, y)]
      if (trackOut > start) segs.push(L(trackOut, y))
      segs.push(sStep(trackOut, y, trackOut + TRACK_STEP, gap), L(colOut, gap))
      return { x: colOut, y: gap, segs, gaps: [], bound, lane }
    })
  }
  const x = Math.max(colOut, start)
  const segs = [M(start, y)]
  if (x > start) segs.push(L(x, y))
  return [{ x, y, segs, gaps: sides.map(side => box.cy + side * half), bound, lane }]
}

/**
 * Entry of a target (8.7): x_in = track left − 2, then a straight run to cx − r − 1. A target in a
 * wrapped track (not the first) arrives in the row gap on the source's side at the column's entry,
 * runs along it and S-steps 14 px into its row just before the dot.
 */
function tailPorts(ctx: Context, v: number, fromY: number): Port[] {
  const { geometry, opt, presentation } = ctx
  const box = geometry.nodes[v]
  const node = ctx.topology.nodes[v]
  const column = geometry.columns[node.col]
  const bound = ctx.freeLeft[node.col]
  const lane = node.lane
  if (!isLabelled(box.cls)) return [{ x: box.cx - 3, y: box.cy, segs: [], gaps: [], bound, lane }]
  const end = box.cx - dotRadius(presentation.role[v], box.cls) - 1
  const xIn = column.x + box.track * (column.trackW + opt.trackGap) - 2
  const half = ctx.rowHalf[v]
  const sides = fromY >= box.cy ? [1, -1] : [-1, 1]
  if (box.track > 0) {
    return sides.map(side => {
      const gap = box.cy + side * half
      const segs = [L(xIn - TRACK_STEP, gap), sStep(xIn - TRACK_STEP, gap, xIn, box.cy)]
      if (end > xIn) segs.push(L(end, box.cy))
      return { x: column.x - 2, y: gap, segs, gaps: [], bound, lane }
    })
  }
  return [{ x: xIn, y: box.cy, segs: end > xIn ? [L(end, box.cy)] : [], gaps: sides.map(side => box.cy + side * half), bound, lane }]
}

const freeHead = (x: number, y: number, bound: number, lane: number): Port => ({ x, y, segs: [M(x, y)], gaps: [], bound, lane })
const freeTail = (x: number, y: number, bound: number, lane: number, gaps: number[] = []): Port =>
  ({ x, y, segs: [], gaps, bound, lane })

// ---------------------------------------------------------------------------
// Candidates (8.8)

/** A: the plain curve of 8.7 (branches use k = 0.5 · dx, 8.9). */
function plainPath(head: Port, tail: Port, branch: boolean): PathSegment[] {
  const dx = tail.x - head.x
  const k = branch ? Math.max(0, dx / 2) : plainK(dx)
  return [...head.segs, curve(head.x, head.y, tail.x, tail.y, k), ...tail.segs]
}

/** B: S-step into a row gap next to the source, curve to a row gap next to the target, S-step in. */
function rowGapPath(head: Port, tail: Port, g1: number, g2: number): PathSegment[] | null {
  const run1 = g1 === head.y ? 0 : clamp(head.bound - head.x, STEP_RUN_MIN, STEP_RUN)
  const run2 = g2 === tail.y ? 0 : clamp(tail.x - tail.bound, STEP_RUN_MIN, STEP_RUN)
  const x1 = head.x + run1
  const x2 = tail.x - run2
  if (x2 - x1 < 8) return null
  const segs = [...head.segs]
  if (run1) segs.push(sStep(head.x, head.y, x1, g1))
  segs.push(curve(x1, g1, x2, g2, plainK(x2 - x1)))
  if (run2) segs.push(sStep(x2, g2, tail.x, tail.y))
  return segs.concat(tail.segs)
}

/** C: S-step into a lane's padding corridor, run to the target's left gutter, curve into the target. */
function corridorPath(head: Port, tail: Port, y: number): PathSegment[] | null {
  let x1 = head.x + clamp(head.bound - head.x, STEP_RUN_MIN, STEP_RUN)
  let gx = Math.max(tail.bound, tail.x - GUTTER_RUN)
  if (gx < x1) {
    // Adjacent columns share one gutter: dip into the corridor and back at its midpoint.
    if (tail.x <= head.x) return null
    x1 = gx = (head.x + tail.x) / 2
  }
  return [...head.segs, sStep(head.x, head.y, x1, y), L(gx, y), curve(gx, y, tail.x, tail.y, (tail.x - gx) / 2), ...tail.segs]
}

interface Corridor {
  key: string
  y: number
}

/**
 * Lane-padding corridors (top and bottom) of the source lane and of the target lane, the smallest
 * vertical detour first; ties keep the source lane first.
 */
function corridorsOf(ctx: Context, head: Port, tail: Port): Corridor[] {
  const out: Array<Corridor & { detour: number }> = []
  const pad = ctx.opt.lanePaddingY / 2
  const add = (lane: number, side: number) => {
    const box = ctx.geometry.lanes[lane]
    if (!box || box.collapsed || box.h <= 2 * pad) return
    const key = `${lane}${side < 0 ? 't' : 'b'}`
    const y = side < 0 ? box.y + pad : box.y + box.h - pad
    if (!out.some(corridor => corridor.key === key)) out.push({ key, y, detour: Math.abs(head.y - y) + Math.abs(y - tail.y) })
  }
  add(head.lane, -1)
  add(head.lane, 1)
  add(tail.lane, -1)
  add(tail.lane, 1)
  return out.sort((a, b) => a.detour - b.detour)
}

interface Job {
  heads: Port[]
  tails: Port[]
  /** Obstacle owners ignored for this path (its endpoints). */
  skip: number[]
  branch: boolean
  /** Same-row link skipping columns: never the plain curve (8.8). */
  sameRow: boolean
}

interface Routed {
  segments: PathSegment[]
  fallback: boolean
  corridor?: { key: string; build(offset: number): PathSegment[] | null }
}

function route(ctx: Context, job: Job): Routed {
  const clear = (segs: PathSegment[] | null): segs is PathSegment[] => segs !== null && !pathHits(segs, ctx.grid, job.skip)
  if (!job.sameRow) {
    for (const head of job.heads) {
      for (const tail of job.tails) {
        const segs = plainPath(head, tail, job.branch)
        if (clear(segs)) return { segments: segs, fallback: false }
      }
    }
  }
  for (const head of job.heads) {
    for (const tail of job.tails) {
      for (const g1 of head.gaps.length ? head.gaps : [head.y]) {
        for (const g2 of tail.gaps.length ? tail.gaps : [tail.y]) {
          if (g1 === head.y && g2 === tail.y) continue
          const segs = rowGapPath(head, tail, g1, g2)
          if (clear(segs)) return { segments: segs, fallback: false }
        }
      }
    }
  }
  for (const head of job.heads) {
    for (const tail of job.tails) {
      for (const corridor of corridorsOf(ctx, head, tail)) {
        const build = (offset: number) => corridorPath(head, tail, corridor.y + offset)
        const segs = build(0)
        if (clear(segs)) return { segments: segs, fallback: false, corridor: { key: corridor.key, build } }
      }
    }
  }
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

/** Groups of >= 3 far ends per column, sorted by median y (8.9); only when the fan has >= 6 edges. */
function planBundles(ctx: Context, fan: readonly number[], candidates: readonly number[], farEnd: (edge: number) => number): Bundle[] {
  if (fan.length < FAN_MIN) return []
  const byCol = new Map<number, number[]>()
  for (const edge of candidates) {
    const col = ctx.topology.nodes[farEnd(edge)].col
    const list = byCol.get(col)
    if (list) list.push(edge)
    else byCol.set(col, [edge])
  }
  return [...byCol]
    .filter(([, edges]) => edges.length >= BUNDLE_MIN)
    .map(([col, edges]) => ({ col, edges, y: median(edges.map(edge => ctx.geometry.nodes[farEnd(edge)].cy)) }))
    .sort((a, b) => a.y - b.y || a.col - b.col)
}

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
  const clear = JUNCTION_R + INFLATE + 2
  let best = 0
  let bestCost = Infinity
  for (const shift of others.length ? [0, 0.5, -0.5, 1, -1] : [0]) {
    const ys = groups.map((_, k) => box.cy + (k - (groups.length - 1) / 2 + shift) * JUNCTION_STACK)
    const blocked = (y: number) => ys.some(jy => Math.abs(jy - y) < clear)
    const cost = (others.length && blocked(box.cy) ? others.length + 1 : 0) + others.filter(blocked).length
    if (cost < bestCost) {
      best = shift
      bestCost = cost
    }
  }
  return groups.map((edges, k) => ({ x, y: box.cy + (k - (groups.length - 1) / 2 + best) * JUNCTION_STACK, edges }))
}

// ---------------------------------------------------------------------------
// Entry points

/**
 * Routes every edge whose role is a chain or program role. Output order: plain edges (by edge
 * index), then bundle trunks with their branches, then fork stubs. A fork stub's first point is
 * the junction centre (glyph r 3.5, drawn on top); edges of that group end at the same point.
 * `options` must match the ones geometry was computed with (only lanePaddingY, rowHeight and
 * trackGap are read here).
 */
export function computeRoutes(
  topology: Topology,
  presentation: Presentation,
  geometry: Geometry,
  input: RouteInput,
  options: Partial<GeometryOptions> = {},
): Routes {
  const { cls, edgeRole } = presentation
  const routed: number[] = []
  topology.edges.forEach((edge, e) => {
    if (ROUTED.has(edgeRole[e]) && cls[edge.from] !== 'hidden' && cls[edge.to] !== 'hidden') routed.push(e)
  })
  if (!routed.length) return { paths: [], fallbacks: 0 }
  const ctx = buildContext(topology, presentation, geometry, options)
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
    ctx.grid.add(junction.x - JUNCTION_R, junction.y - JUNCTION_R, junction.x + JUNCTION_R, junction.y + JUNCTION_R, junctionOwner(k))
  })
  const directInEdges = [...directIn.values()]
  const unlockBundles = planBundles(ctx, directOut, directOut, e => edges[e].to)
  const prereqBundles = planBundles(ctx, directInEdges, directInEdges.filter(e => !junctionOf.has(e)), e => edges[e].from)
  const bundled = new Set<number>()
  for (const bundle of [...unlockBundles, ...prereqBundles]) for (const e of bundle.edges) bundled.add(e)

  const paths: RoutedPath[] = []
  const corridorUses: Array<{ path: RoutedPath; key: string; order: number; edge: number; skip: number[]; build(offset: number): PathSegment[] | null }> = []
  let fallbacks = 0
  const emit = (meta: Omit<RoutedPath, 'segments'>, job: Job, orderY: number) => {
    const result = route(ctx, job)
    const path: RoutedPath = { ...meta, segments: result.segments }
    paths.push(path)
    if (result.fallback) fallbacks++
    if (result.corridor) corridorUses.push({ path, key: result.corridor.key, order: orderY, edge: meta.edge, skip: job.skip, build: result.corridor.build })
  }

  for (const e of routed) {
    if (bundled.has(e)) continue
    const { from, to, kind } = edges[e]
    const k = junctionOf.get(e)
    const heads = headPorts(ctx, from, k === undefined ? nodes[to].cy : junctions[k].y)
    if (k !== undefined) {
      const junction = junctions[k]
      const lane = topology.nodes[focus].lane
      const tail = freeTail(junction.x, junction.y, ctx.freeLeft[topology.nodes[focus].col], lane)
      emit({ edge: e, role: edgeRole[e], kind, shape: 'edge' }, { heads, tails: [tail], skip: [from, to, junctionOwner(k)], branch: false, sameRow: false }, junction.y)
      continue
    }
    const tails = tailPorts(ctx, to, nodes[from].cy)
    if (junctions.length && to === focus) {
      // Other direct prerequisites may also arrive left of the junction column and run straight
      // to the focus between stacked junctions.
      const lead = tails[0]
      const x = junctions[0].x - JUNCTION_R - INFLATE - MARGIN
      if (x < lead.x) tails.push({ ...lead, x, segs: [L(lead.x, lead.y), ...lead.segs] })
    }
    const colFrom = topology.nodes[from].col
    const colTo = topology.nodes[to].col
    const sameRow = Math.abs(nodes[from].cy - nodes[to].cy) < 0.5 && ctx.visibleBefore[colTo] - ctx.visibleBefore[colFrom + 1] > 0
    emit({ edge: e, role: edgeRole[e], kind, shape: 'edge' }, { heads, tails, skip: [from, to], branch: false, sameRow }, nodes[to].cy)
  }

  unlockBundles.forEach((bundle, i) => {
    const column = geometry.columns[bundle.col]
    const heads = headPorts(ctx, focus, bundle.y, staggerOf(i, unlockBundles.length))
    // In the column right after the focus the split point must still lie past the out-port.
    const x = Math.max(column.x - SPLIT_BEFORE, ctx.freeLeft[bundle.col], heads[0].x + STEP_RUN_MIN)
    const lane = laneAt(geometry, bundle.y)
    const trunk = { heads, tails: [freeTail(x, bundle.y, ctx.freeLeft[bundle.col], lane)] }
    emit({ edge: -1, role: 'unlock-direct', kind: bundleKind(topology, bundle.edges), shape: 'trunk' }, { ...trunk, skip: [focus], branch: false, sameRow: false }, bundle.y)
    for (const e of bundle.edges) {
      const to = edges[e].to
      const job: Job = { heads: [freeHead(x, bundle.y, column.x - 1, lane)], tails: tailPorts(ctx, to, bundle.y), skip: [focus, to], branch: true, sameRow: false }
      emit({ edge: e, role: edgeRole[e], kind: edges[e].kind, shape: 'branch' }, job, nodes[to].cy)
    }
  })

  if (prereqBundles.length) {
    const focusBox = nodes[focus]
    const focusCol = geometry.columns[topology.nodes[focus].col]
    const xIn = focusCol.x + focusBox.track * (focusCol.trackW + ctx.opt.trackGap) - 2
    const focusLane = topology.nodes[focus].lane
    prereqBundles.forEach((bundle, i) => {
      const column = geometry.columns[bundle.col]
      const colOut = column.x + column.w - 2
      const x = colOut + clamp(ctx.freeRight[bundle.col] - colOut - 4, 4, MERGE_AFTER)
      const lane = laneAt(geometry, bundle.y)
      for (const e of bundle.edges) {
        const from = edges[e].from
        const job: Job = { heads: headPorts(ctx, from, bundle.y), tails: [freeTail(x, bundle.y, colOut, lane)], skip: [from, focus], branch: true, sameRow: false }
        emit({ edge: e, role: edgeRole[e], kind: edges[e].kind, shape: 'branch' }, job, bundle.y)
      }
      const y = focusBox.cy + staggerOf(i, prereqBundles.length)
      const gaps = bundle.y >= focusBox.cy ? [1, -1] : [-1, 1]
      const tail = freeTail(xIn, y, ctx.freeLeft[topology.nodes[focus].col], focusLane, gaps.map(side => focusBox.cy + side * ctx.rowHalf[focus]))
      const job: Job = { heads: [freeHead(x, bundle.y, ctx.freeRight[bundle.col], lane)], tails: [tail], skip: [focus], branch: false, sameRow: false }
      emit({ edge: -1, role: 'prereq-direct', kind: bundleKind(topology, bundle.edges), shape: 'trunk' }, job, y)
    })
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

  applyCorridorOffsets(ctx, corridorUses)
  return { paths, fallbacks }
}

/** Edges sharing a lane-padding corridor are spread 3 px apart, ordered by target y (8.8.6). */
function applyCorridorOffsets(
  ctx: Context,
  uses: ReadonlyArray<{ path: RoutedPath; key: string; order: number; edge: number; skip: number[]; build(offset: number): PathSegment[] | null }>,
) {
  const byKey = new Map<string, typeof uses[number][]>()
  for (const use of uses) {
    const list = byKey.get(use.key)
    if (list) list.push(use)
    else byKey.set(use.key, [use])
  }
  for (const group of byKey.values()) {
    if (group.length < 2) continue
    group.sort((a, b) => a.order - b.order || a.edge - b.edge)
    group.forEach((use, i) => {
      const segs = use.build((i - (group.length - 1) / 2) * CORRIDOR_OFFSET)
      if (segs && !pathHits(segs, ctx.grid, use.skip)) use.path.segments = segs
    })
  }
}

/**
 * Plain anchored curves (8.7, no corridor routing) for any edges, e.g. the renderer's hover
 * preview, which routes long edges without corridors for speed.
 */
export function plainEdgePaths(
  topology: Topology,
  presentation: Presentation,
  geometry: Geometry,
  edgeIndices: readonly number[],
  options: Partial<GeometryOptions> = {},
): PathSegment[][] {
  const ctx = buildContext(topology, presentation, geometry, options, false)
  return edgeIndices.map(e => {
    const { from, to } = topology.edges[e]
    const head = headPorts(ctx, from, geometry.nodes[to].cy)[0]
    const tail = tailPorts(ctx, to, geometry.nodes[from].cy)[0]
    return plainPath(head, tail, false)
  })
}
