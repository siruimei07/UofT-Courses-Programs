// Hit testing and spatial navigation over a Geometry (design-spec 11.2, 11.3). A 64 world-px grid
// holds each labelled node's dot + label box and an 8 × 8 box per mini dot; hidden nodes and
// overflow minis (not drawn) are excluded. Pure: no DOM.
import type { Geometry, NodeBox, Presentation, Topology } from './types'

export const HIT_CELL = 64
/** Hit box of a mini dot (world px). */
export const MINI_HIT = 8
/** Dot half-size added around labelled dots so a click on the glyph always hits. */
const DOT_HIT = 6

export interface HitGrid {
  cell: number
  originX: number
  originY: number
  cols: number
  rows: number
  /** Node indices per bucket (row-major). */
  buckets: number[][]
  /** x0, y0, x1, y1 per node (NaN when not hit-testable). */
  boxes: Float64Array
}

export function hitBox(box: NodeBox): [number, number, number, number] | null {
  if (box.cls === 'hidden' || box.overflow) return null
  if (box.cls === 'mini') {
    const h = MINI_HIT / 2
    return [box.cx - h, box.cy - h, box.cx + h, box.cy + h]
  }
  return [
    Math.min(box.x, box.cx - DOT_HIT),
    Math.min(box.y, box.cy - DOT_HIT),
    Math.max(box.x + box.w, box.cx + DOT_HIT),
    Math.max(box.y + box.h, box.cy + DOT_HIT),
  ]
}

export function buildHitGrid(geometry: Geometry, cell = HIT_CELL): HitGrid {
  const n = geometry.nodes.length
  const boxes = new Float64Array(n * 4).fill(NaN)
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  geometry.nodes.forEach((node, i) => {
    const box = node ? hitBox(node) : null
    if (!box) return
    boxes.set(box, i * 4)
    minX = Math.min(minX, box[0])
    minY = Math.min(minY, box[1])
    maxX = Math.max(maxX, box[2])
    maxY = Math.max(maxY, box[3])
  })
  if (minX === Infinity) return { cell, originX: 0, originY: 0, cols: 0, rows: 0, buckets: [], boxes }
  const originX = Math.floor(minX / cell) * cell
  const originY = Math.floor(minY / cell) * cell
  const cols = Math.floor((maxX - originX) / cell) + 1
  const rows = Math.floor((maxY - originY) / cell) + 1
  const buckets: number[][] = Array.from({ length: cols * rows }, () => [])
  for (let i = 0; i < n; i++) {
    const x0 = boxes[i * 4]
    if (Number.isNaN(x0)) continue
    const c0 = Math.floor((x0 - originX) / cell)
    const c1 = Math.floor((boxes[i * 4 + 2] - originX) / cell)
    const r0 = Math.floor((boxes[i * 4 + 1] - originY) / cell)
    const r1 = Math.floor((boxes[i * 4 + 3] - originY) / cell)
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) buckets[r * cols + c].push(i)
  }
  return { cell, originX, originY, cols, rows, buckets, boxes }
}

/** Node under a world point, or -1. Ties go to the nearest dot: |dy| + 0.1 · |dx|. */
export function hitTest(grid: HitGrid, geometry: Geometry, wx: number, wy: number): number {
  const c = Math.floor((wx - grid.originX) / grid.cell)
  const r = Math.floor((wy - grid.originY) / grid.cell)
  if (c < 0 || r < 0 || c >= grid.cols || r >= grid.rows) return -1
  let best = -1
  let bestScore = Infinity
  for (const i of grid.buckets[r * grid.cols + c]) {
    const b = i * 4
    if (wx < grid.boxes[b] || wx > grid.boxes[b + 2] || wy < grid.boxes[b + 1] || wy > grid.boxes[b + 3]) continue
    const node = geometry.nodes[i]
    const score = Math.abs(wy - node.cy) + 0.1 * Math.abs(wx - node.cx)
    if (score < bestScore || (score === bestScore && i < best)) {
      best = i
      bestScore = score
    }
  }
  return best
}

/** Every hit-testable node whose box intersects the world rectangle (deduplicated, ascending). */
export function queryRect(grid: HitGrid, x: number, y: number, w: number, h: number): number[] {
  if (!grid.cols) return []
  const c0 = Math.max(0, Math.floor((x - grid.originX) / grid.cell))
  const c1 = Math.min(grid.cols - 1, Math.floor((x + w - grid.originX) / grid.cell))
  const r0 = Math.max(0, Math.floor((y - grid.originY) / grid.cell))
  const r1 = Math.min(grid.rows - 1, Math.floor((y + h - grid.originY) / grid.cell))
  const seen = new Set<number>()
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      for (const i of grid.buckets[r * grid.cols + c]) {
        const b = i * 4
        if (grid.boxes[b] > x + w || grid.boxes[b + 2] < x || grid.boxes[b + 1] > y + h || grid.boxes[b + 3] < y) continue
        seen.add(i)
      }
    }
  }
  return [...seen].sort((a, b) => a - b)
}

// ---------------------------------------------------------------------------
// Keyboard cursor navigation (11.3)

export type Direction = 'up' | 'down' | 'left' | 'right'

const CHAIN_ROLES = new Set(['focus', 'prereq-direct', 'prereq', 'unlock-direct', 'unlock'])

/**
 * Nodes the keyboard cursor may visit: the chain during a selection, program courses in program
 * mode, otherwise every visible labelled or mini node. Overflow minis are never candidates.
 */
export function cursorCandidates(presentation: Presentation, geometry: Geometry, focus: number, programActive: boolean): number[] {
  const out: number[] = []
  presentation.cls.forEach((cls, i) => {
    const box = geometry.nodes[i]
    if (cls === 'hidden' || !box || box.overflow) return
    if (focus >= 0) {
      if (CHAIN_ROLES.has(presentation.role[i])) out.push(i)
    } else if (programActive) {
      if (presentation.inProgram[i]) out.push(i)
    } else {
      out.push(i)
    }
  })
  return out
}

export interface NavContext {
  topology: Topology
  geometry: Geometry
  presentation: Presentation
  candidates: readonly number[]
  focus: number
}

function nearestBy(list: readonly number[], score: (v: number) => number): number {
  let best = -1
  let bestScore = Infinity
  for (const v of list) {
    const s = score(v)
    if (s < bestScore) {
      best = v
      bestScore = s
    }
  }
  return best
}

/** Up/Down: the previous/next node of the same track, then the nearest node of the adjacent lane. */
function vertical(ctx: NavContext, from: number, down: boolean): number {
  const { topology, geometry, candidates } = ctx
  const node = topology.nodes[from]
  const box = geometry.nodes[from]
  const sameTrack = candidates.filter(v => {
    const b = geometry.nodes[v]
    return v !== from && topology.nodes[v].lane === node.lane && topology.nodes[v].col === node.col && b.track === box.track &&
      (down ? b.cy > box.cy : b.cy < box.cy)
  })
  if (sameTrack.length) return nearestBy(sameTrack, v => Math.abs(geometry.nodes[v].cy - box.cy) + 0.01 * Math.abs(geometry.nodes[v].cx - box.cx))
  // Chain nodes of the same column in other lanes come next during a selection.
  if (ctx.focus >= 0) {
    const sameColumn = candidates.filter(v => v !== from && topology.nodes[v].col === node.col && (down ? geometry.nodes[v].cy > box.cy : geometry.nodes[v].cy < box.cy))
    if (sameColumn.length) return nearestBy(sameColumn, v => Math.abs(geometry.nodes[v].cy - box.cy))
  }
  const lanes = topology.lanes.length
  for (let lane = node.lane + (down ? 1 : -1); lane >= 0 && lane < lanes; lane += down ? 1 : -1) {
    const inLane = candidates.filter(v => topology.nodes[v].lane === lane)
    if (inLane.length) return nearestBy(inLane, v => Math.abs(geometry.nodes[v].cx - box.cx) + 0.25 * Math.abs(geometry.nodes[v].cy - box.cy))
  }
  return from
}

/** Left/Right: the nearest node by y in the previous/next non-empty column of the lane, then of nearby lanes. */
function horizontal(ctx: NavContext, from: number, right: boolean): number {
  const { topology, geometry, presentation, candidates, focus } = ctx
  const node = topology.nodes[from]
  const box = geometry.nodes[from]
  if (from === focus) {
    const direct = candidates.filter(v => presentation.role[v] === (right ? 'unlock-direct' : 'prereq-direct'))
    if (direct.length) return nearestBy(direct, v => Math.abs(geometry.nodes[v].cy - box.cy) + 0.1 * Math.abs(geometry.nodes[v].cx - box.cx))
  }
  const beyond = (v: number) => (right ? topology.nodes[v].col > node.col : topology.nodes[v].col < node.col)
  const lanes = topology.lanes.length
  for (let d = 0; d < lanes; d++) {
    const pool = candidates.filter(v => Math.abs(topology.nodes[v].lane - node.lane) === d && beyond(v))
    if (!pool.length) continue
    const cols = pool.map(v => topology.nodes[v].col)
    const col = right ? Math.min(...cols) : Math.max(...cols)
    const inCol = pool.filter(v => topology.nodes[v].col === col)
    return nearestBy(inCol, v => Math.abs(geometry.nodes[v].cy - box.cy))
  }
  return from
}

export function moveCursor(ctx: NavContext, from: number, direction: Direction): number {
  if (from < 0 || !ctx.candidates.includes(from)) return ctx.candidates.length ? startCursor(ctx) : -1
  switch (direction) {
    case 'up': return vertical(ctx, from, false)
    case 'down': return vertical(ctx, from, true)
    case 'left': return horizontal(ctx, from, false)
    case 'right': return horizontal(ctx, from, true)
  }
}

/** Where the cursor starts: the focus, otherwise the first candidate in reading order. */
export function startCursor(ctx: NavContext, near?: { x: number; y: number }): number {
  if (ctx.focus >= 0 && ctx.candidates.includes(ctx.focus)) return ctx.focus
  if (near) return nearestBy(ctx.candidates, v => Math.abs(ctx.geometry.nodes[v].cy - near.y) + Math.abs(ctx.geometry.nodes[v].cx - near.x))
  return nearestBy(ctx.candidates, v => ctx.geometry.nodes[v].cy * 1e4 + ctx.geometry.nodes[v].cx)
}

/** Home / End: the node of the first / last lane nearest (by x) to the current cursor. */
export function laneEdgeCursor(ctx: NavContext, from: number, last: boolean): number {
  const lanes = [...new Set(ctx.candidates.map(v => ctx.topology.nodes[v].lane))].sort((a, b) => a - b)
  if (!lanes.length) return -1
  const lane = last ? lanes[lanes.length - 1] : lanes[0]
  const x = from >= 0 ? ctx.geometry.nodes[from].cx : 0
  return nearestBy(ctx.candidates.filter(v => ctx.topology.nodes[v].lane === lane), v => Math.abs(ctx.geometry.nodes[v].cx - x) + 0.01 * ctx.geometry.nodes[v].cy)
}
