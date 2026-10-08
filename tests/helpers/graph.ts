// Deterministic stand-ins for the renderer's text module plus shared graph checks for the tests.
import type { GraphDataset } from '../../src/data/schema'
import type { Rule } from '../../src/domain/types'
import { DEFAULT_GEOMETRY_OPTIONS, dotRadius, geometryOptions, horizontalRuns, samplePath } from '../../src/graph'
import type { Geometry, HorizontalRun, LabelMeasure, PathSegment, Presentation, RoutedPath, Routes, Topology } from '../../src/graph'

/** Average advance per character: codes at 13 / 600, titles at 12.5 / 400, plate code at 14 / 700. */
export const CODE_CHAR = 7.2
export const TITLE_CHAR = 6.4
export const PLATE_CODE_CHAR = 8
/** "0.5 cr" after 8 px of space. */
export const PLATE_CREDIT = 8 + 36
export const PLATE_WRAP = 260

/** Stub LabelMeasure with the contract's shape (design-spec 8.1): compact = code, full = max(code, capped title), focus = plate. */
export function stubMeasure(topology: Topology, fullLabelMax = DEFAULT_GEOMETRY_OPTIONS.fullLabelMax): LabelMeasure {
  return (index, cls, isFocus) => {
    const { code, title } = topology.nodes[index]
    if (isFocus) return Math.max(code.length * PLATE_CODE_CHAR + PLATE_CREDIT, Math.min(title.length * TITLE_CHAR, PLATE_WRAP)) + 6
    const codeW = code.length * CODE_CHAR
    return cls === 'compact' ? codeW : Math.max(codeW, Math.min(title.length * TITLE_CHAR, fullLabelMax))
  }
}

/** Plate title lines the stub would need (1-3). */
export function stubFocusLines(topology: Topology, index: number): number {
  return Math.min(3, Math.max(1, Math.ceil((topology.nodes[index].title.length * TITLE_CHAR) / PLATE_WRAP)))
}

/** Parsed `any` groups of the focus's prerequisite rule (same rule as the app's readout): direct predecessors only, >= 2 per group. */
export function anyGroupsFor(dataset: GraphDataset, topology: Topology, focus: number): number[][] {
  const rule = dataset.courses.find(course => course.id === topology.nodes[focus].id)?.prereq?.rule
  if (!rule) return []
  const preds = new Set(topology.preds[focus])
  const groups: number[][] = []
  const visit = (node: Rule) => {
    if (node.kind === 'applicability') return visit(node.rule)
    if (node.kind !== 'all' && node.kind !== 'any') return
    if (node.kind === 'any') {
      const group = new Set<number>()
      for (const item of node.items) {
        if (item.kind !== 'course' && item.kind !== 'minGrade') continue
        const index = topology.indexById.get(item.courseId)
        if (index !== undefined && preds.has(index)) group.add(index)
      }
      if (group.size >= 2) groups.push([...group].sort((a, b) => a - b))
    }
    node.items.forEach(visit)
  }
  visit(rule)
  return groups
}

interface Box {
  x0: number
  y0: number
  x1: number
  y1: number
  owner: number
  what: string
}

/** Label boxes and dot boxes (r + 2) of every visible labelled node: the obstacles of design-spec 8.8. */
export function obstacleBoxes(topology: Topology, presentation: Presentation, geometry: Geometry, inflate = 0): Box[] {
  const boxes: Box[] = []
  geometry.nodes.forEach((box, v) => {
    if (box.cls !== 'full' && box.cls !== 'compact') return
    const r = dotRadius(presentation.role[v], box.cls) + 2 + inflate
    const code = topology.nodes[v].code
    boxes.push({ x0: box.x - inflate, y0: box.y - inflate, x1: box.x + box.w + inflate, y1: box.y + box.h + inflate, owner: v, what: `${code} label` })
    boxes.push({ x0: box.cx - r, y0: box.cy - r, x1: box.cx + r, y1: box.cy + r, owner: v, what: `${code} dot` })
  })
  return boxes
}

/** Endpoints a path may touch: the edge's own nodes, plus the focus for trunks, branches and forks. */
export function pathOwners(topology: Topology, path: RoutedPath, focus: number): number[] {
  if (path.edge < 0) return [focus]
  const { from, to } = topology.edges[path.edge]
  return [from, to, focus]
}

/** Every 1 px sample of every path that falls strictly inside a non-endpoint obstacle (no inflation). */
export function pathIntrusions(topology: Topology, paths: readonly RoutedPath[], boxes: readonly Box[], focus: number): string[] {
  const problems: string[] = []
  // 64 px buckets so a full-dataset sweep stays fast; the test itself is exact.
  const cell = (value: number) => Math.floor(value / 64)
  const buckets = new Map<string, Box[]>()
  for (const box of boxes) {
    for (let gx = cell(box.x0); gx <= cell(box.x1); gx++) {
      for (let gy = cell(box.y0); gy <= cell(box.y1); gy++) {
        const key = `${gx},${gy}`
        const list = buckets.get(key)
        if (list) list.push(box)
        else buckets.set(key, [box])
      }
    }
  }
  for (const path of paths) {
    const owners = pathOwners(topology, path, focus)
    const label = path.edge < 0 ? `${path.shape}` : `${topology.nodes[topology.edges[path.edge].from].code}>${topology.nodes[topology.edges[path.edge].to].code}`
    samplePath(path.segments, 1, (x, y) => {
      for (const box of buckets.get(`${cell(x)},${cell(y)}`) ?? []) {
        if (owners.includes(box.owner)) continue
        if (x > box.x0 && x < box.x1 && y > box.y0 && y < box.y1) {
          problems.push(`${label} (${path.shape}) crosses ${box.what} at ${x.toFixed(1)},${y.toFixed(1)}`)
          return true
        }
      }
      return false
    })
  }
  return problems
}

/** Pairs of visible, non-overflow node boxes whose areas overlap (sweep over x). */
export function overlappingPairs(topology: Topology, geometry: Geometry): string[] {
  const boxes = geometry.nodes
    .map((box, index) => ({ ...box, index }))
    .filter(box => box.cls !== 'hidden' && !box.overflow && box.w > 0 && box.h > 0)
    .sort((a, b) => a.x - b.x)
  const pairs: string[] = []
  let active: typeof boxes = []
  for (const box of boxes) {
    active = active.filter(other => other.x + other.w > box.x + 1e-9)
    for (const other of active) {
      if (other.y < box.y + box.h - 1e-9 && box.y < other.y + other.h - 1e-9) {
        pairs.push(`${topology.nodes[other.index].code}/${topology.nodes[box.index].code}`)
      }
    }
    active.push(box)
  }
  return pairs
}

/** Source and target node of a routed path (-1 where a trunk or fork has none); paths sharing one may share runs. */
export function pathEnds(topology: Topology, path: RoutedPath, focus: number): { from: number; to: number } {
  if (path.edge >= 0) return topology.edges[path.edge]
  return path.shape === 'trunk' && path.role === 'unlock-direct' ? { from: focus, to: -1 } : { from: -1, to: focus }
}

/** Horizontal run of a routed path, with the path it belongs to. */
interface PathRun extends HorizontalRun {
  path: number
}

const EPS = 1e-6
/** Trunk ends are staggered up to ± 9 px around the focus row (8.9). */
const STAGGER_MAX = 9
const SLOT = 3

/**
 * Where routed paths may run and reach (design-spec 8.8 and the corridor containment rule):
 * - every sample lies inside the plot: below the band header and above geometry.height;
 * - every horizontal run is on its own endpoint's row (a trunk: ± 9 px of the focus row), inside a
 *   labelled lane's content (row gaps), or inside a lane-padding corridor band of a labelled lane:
 *   the padding centre ± 3 px. Never on a lane line, in a slim or collapsed lane or in the header.
 */
export function containmentProblems(topology: Topology, geometry: Geometry, routes: Routes, focus: number): string[] {
  const opt = geometryOptions(geometry)
  const pad = opt.lanePaddingY
  const problems: string[] = []
  const name = (path: RoutedPath) => (path.edge < 0 ? path.shape : `${topology.nodes[topology.edges[path.edge].from].code}>${topology.nodes[topology.edges[path.edge].to].code}`)
  const laneAt = (y: number) => geometry.lanes.findIndex(lane => y >= lane.y - EPS && y <= lane.y + lane.h + EPS && lane.h > 0)
  for (const path of routes.paths) {
    samplePath(path.segments, 2, (x, y) => {
      if (y >= opt.bandHeaderHeight - EPS && y <= geometry.height + EPS) return false
      problems.push(`${name(path)} leaves the plot at ${x.toFixed(1)},${y.toFixed(1)}`)
      return true
    })
    const { from, to } = pathEnds(topology, path, focus)
    const rows = [from, to].filter(v => v >= 0).map(v => geometry.nodes[v].cy)
    const slack = path.edge < 0 || path.shape === 'branch' ? STAGGER_MAX : 0
    for (const run of horizontalRuns(path.segments, 2)) {
      if (rows.some(cy => Math.abs(run.y - cy) <= slack + EPS)) continue
      const l = laneAt(run.y)
      const lane = geometry.lanes[l]
      const where = `${name(path)} runs at y=${run.y.toFixed(1)} (${run.x0.toFixed(0)}-${run.x1.toFixed(0)})`
      if (l < 0 || lane.collapsed || lane.slim) {
        problems.push(`${where} outside any labelled lane${l >= 0 ? ` (${topology.lanes[l].subject}${lane.slim ? ', slim' : ''})` : ''}`)
        continue
      }
      const top = run.y - lane.y
      const bottom = lane.y + lane.h - run.y
      const inContent = top >= pad - EPS && bottom >= pad - EPS
      const inCorridor = Math.abs(top - pad / 2) <= SLOT + EPS || Math.abs(bottom - pad / 2) <= SLOT + EPS
      if (!inContent && !inCorridor) problems.push(`${where}: in ${topology.lanes[l].subject}'s padding outside the corridor band`)
    }
  }
  return problems
}

/** Pairs of unrelated paths (no shared endpoint) whose horizontal runs lie within `clear` px over more than `overlap` px. */
export function coincidentRuns(topology: Topology, routes: Routes, focus: number, clear = 1.5, overlap = 4): string[] {
  const runs: PathRun[] = []
  routes.paths.forEach((path, i) => {
    for (const run of horizontalRuns(path.segments, overlap)) runs.push({ ...run, path: i })
  })
  runs.sort((a, b) => a.y - b.y)
  const ends = routes.paths.map(path => pathEnds(topology, path, focus))
  const label = (i: number) => {
    const path = routes.paths[i]
    return path.edge < 0 ? path.shape : `${topology.nodes[topology.edges[path.edge].from].code}>${topology.nodes[topology.edges[path.edge].to].code}`
  }
  const problems: string[] = []
  for (let i = 0; i < runs.length; i++) {
    for (let k = i + 1; k < runs.length && runs[k].y - runs[i].y < clear; k++) {
      const a = runs[i]
      const b = runs[k]
      if (a.path === b.path || Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) <= overlap) continue
      const ea = ends[a.path]
      const eb = ends[b.path]
      if ((ea.from >= 0 && ea.from === eb.from) || (ea.to >= 0 && ea.to === eb.to)) continue
      problems.push(`${label(a.path)} and ${label(b.path)} share a run at y=${a.y.toFixed(1)}`)
    }
  }
  return problems
}

/** End point of a path. */
export function lastPoint(segments: readonly PathSegment[]): { x: number; y: number } {
  const last = segments[segments.length - 1]
  return { x: last.x, y: last.y }
}

/** Best of `runs` timings, in ms (less noise from other processes than a single run). */
export function bestOf<T>(runs: number, fn: () => T): { result: T; ms: number } {
  let best = Infinity
  let result!: T
  for (let i = 0; i < runs; i++) {
    const started = performance.now()
    result = fn()
    best = Math.min(best, performance.now() - started)
  }
  return { result, ms: best }
}

/**
 * Product rule (no edge may seem to link two courses of one column), wrapped tracks: pairs of a path
 * leaving a source in a wrapped column and a path entering a target in that column whose horizontal
 * runs inside the column lie within `clear` px over more than `overlap` px. Such a pair reads as one
 * line from the source to the target.
 */
export function wrappedMerges(
  topology: Topology, geometry: Geometry, paths: ReadonlyArray<{ edge: number; segments: readonly PathSegment[]; ends?: { from: number; to: number } }>,
  clear = 1.5, overlap = 4,
): string[] {
  interface Run extends HorizontalRun {
    col: number
    kind: 'head' | 'tail'
    path: number
  }
  const runs: Run[] = []
  paths.forEach((path, i) => {
    const ends = path.ends ?? (path.edge >= 0 ? topology.edges[path.edge] : null)
    if (!ends) return
    for (const run of horizontalRuns(path.segments, overlap)) {
      for (const [v, kind] of [[ends.from, 'head'], [ends.to, 'tail']] as const) {
        if (v < 0) continue
        const column = geometry.columns[topology.nodes[v].col]
        if (column.tracks < 2) continue
        const x0 = Math.max(run.x0, column.x)
        const x1 = Math.min(run.x1, column.x + column.w)
        if (x1 - x0 > overlap) runs.push({ y: run.y, x0, x1, col: topology.nodes[v].col, kind, path: i })
      }
    }
  })
  runs.sort((a, b) => a.y - b.y)
  const name = (i: number) => {
    const e = paths[i].edge
    return e < 0 ? 'bundle' : `${topology.nodes[topology.edges[e].from].code}>${topology.nodes[topology.edges[e].to].code}`
  }
  const problems: string[] = []
  for (let i = 0; i < runs.length; i++) {
    for (let k = i + 1; k < runs.length && runs[k].y - runs[i].y < clear; k++) {
      const a = runs[i]
      const b = runs[k]
      if (a.col !== b.col || a.kind === b.kind || a.path === b.path) continue
      if (Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) <= overlap) continue
      problems.push(`${name(a.path)} and ${name(b.path)} meet in one row gap of a wrapped column at y=${a.y.toFixed(1)}`)
    }
  }
  return problems
}

/**
 * Product rule, wrapped tracks: strokes of edges anchored in a node's column that lie on the row of a
 * later-track node (± 6 px) in the 10 px before its dot, where they would read as reaching for it
 * from the previous track's label. Its own incoming edges enter from above or below at cx instead.
 */
export function laterTrackReaches(topology: Topology, geometry: Geometry, paths: ReadonlyArray<{ edge: number; segments: readonly PathSegment[] }>): string[] {
  const zones = new Map<number, Array<{ v: number; x0: number; x1: number; y0: number; y1: number }>>()
  geometry.nodes.forEach((box, v) => {
    if ((box.cls !== 'full' && box.cls !== 'compact') || box.track === 0) return
    const col = topology.nodes[v].col
    const list = zones.get(col) ?? []
    list.push({ v, x0: box.cx - 5 - 10, x1: box.cx - 5, y0: box.cy - 6, y1: box.cy + 6 })
    zones.set(col, list)
  })
  const problems: string[] = []
  for (const path of paths) {
    if (path.edge < 0) continue
    const { from, to } = topology.edges[path.edge]
    const own = [...new Set([topology.nodes[from].col, topology.nodes[to].col])].flatMap(col => zones.get(col) ?? []).filter(z => z.v !== to)
    if (!own.length) continue
    samplePath(path.segments, 1, (x, y) => {
      const zone = own.find(z => x > z.x0 && x < z.x1 && y > z.y0 && y < z.y1)
      if (zone && problems.length < 20) problems.push(`${topology.nodes[from].code}>${topology.nodes[to].code} reaches ${topology.nodes[zone.v].code} on its row at ${x.toFixed(1)},${y.toFixed(1)}`)
      return Boolean(zone)
    })
  }
  return problems
}

/** Row band of every labelled node of a wrapped column, per column and track, sorted by top (cy ± half its cell's row pitch). */
function trackRowBands(topology: Topology, geometry: Geometry): Map<string, Array<[number, number, number]>> {
  const opt = geometryOptions(geometry)
  const bands = new Map<string, Array<[number, number, number]>>()
  topology.cells.forEach(row => row.forEach(cell => {
    const labelled = cell.filter(v => geometry.nodes[v].cls === 'full' || geometry.nodes[v].cls === 'compact')
    if (!labelled.length || geometry.columns[topology.nodes[labelled[0]].col].tracks < 2) return
    const pitch = Math.max(...labelled.map(v => Math.max(geometry.nodes[v].h, opt.rowHeight[geometry.nodes[v].cls as 'full' | 'compact'])))
    for (const v of labelled) {
      const key = `${topology.nodes[v].col}|${geometry.nodes[v].track}`
      const list = bands.get(key) ?? []
      list.push([geometry.nodes[v].cy - pitch / 2, geometry.nodes[v].cy + pitch / 2, v])
      bands.set(key, list)
    }
  }))
  for (const list of bands.values()) list.sort((a, b) => a[0] - b[0])
  return bands
}

/**
 * Product rule, wrapped tracks (owner decision 19.11): samples of strokes anchored in a wrapped column
 * (the column of either end) that lie inside the x-range of another track of that column at the row
 * of a node in that track (its row band, cy ± half the cell's row pitch). `items` are drawn strokes
 * (full paths or stub halves) with their layout edge.
 */
export function otherTrackCrossings(
  topology: Topology, geometry: Geometry, items: ReadonlyArray<{ edge: number; segments: readonly PathSegment[] }>, limit = 20,
): string[] {
  const opt = geometryOptions(geometry)
  const bands = trackRowBands(topology, geometry)
  const problems: string[] = []
  for (const item of items) {
    if (!item.segments.length) continue
    const { from, to } = topology.edges[item.edge]
    const ends = [from, to].filter(v => (geometry.nodes[v].cls === 'full' || geometry.nodes[v].cls === 'compact') && geometry.columns[topology.nodes[v].col].tracks > 1)
    if (!ends.length) continue
    samplePath(item.segments, 1, (x, y) => {
      for (const v of ends) {
        const col = topology.nodes[v].col
        const column = geometry.columns[col]
        if (x < column.x || x > column.x + column.w) continue
        const pitch = column.trackW + opt.trackGap
        const k = Math.floor((x - column.x) / pitch)
        if (k === geometry.nodes[v].track || x - column.x - k * pitch > column.trackW) continue
        const band = (bands.get(`${col}|${k}`) ?? []).find(([y0, y1]) => y > y0 && y < y1)
        if (!band) continue
        if (problems.length < limit) {
          problems.push(`${topology.nodes[from].code}>${topology.nodes[to].code} crosses track ${k} at ${topology.nodes[band[2]].code}'s row (${x.toFixed(1)},${y.toFixed(1)})`)
        }
        return true
      }
      return false
    })
  }
  return problems
}

/** Horizontal extent of a straight stub half at one height, terminal dot included at both ends. */
function stubExtent(segments: readonly PathSegment[], terminal: number): { y: number; x0: number; x1: number } | null {
  if (!segments.length) return null
  const ys = segments.map(s => s.y)
  if (ys.some(y => Math.abs(y - ys[0]) > 1e-9)) return null
  const xs = segments.map(s => s.x)
  return { y: ys[0], x0: Math.min(...xs) - terminal, x1: Math.max(...xs) + terminal }
}

/**
 * Stub halves of different nodes on one row of one column (wrapped cells) that come closer than
 * `clear` px (terminal dots included): two stubs facing each other in one track gap would read as a
 * link between two courses of the column.
 */
export function facingStubs(
  topology: Topology, halves: ReadonlyArray<{ v: number; segments: readonly PathSegment[] }>, clear = 6, terminal = 1.5,
): string[] {
  const rows = new Map<string, Array<{ v: number; x0: number; x1: number }>>()
  for (const half of halves) {
    const extent = stubExtent(half.segments, terminal)
    if (!extent) continue
    const key = `${topology.nodes[half.v].col}|${extent.y}`
    const list = rows.get(key) ?? []
    if (!list.some(other => other.v === half.v && other.x0 === extent.x0 && other.x1 === extent.x1)) list.push({ v: half.v, x0: extent.x0, x1: extent.x1 })
    rows.set(key, list)
  }
  const problems: string[] = []
  for (const list of rows.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let k = i + 1; k < list.length; k++) {
        const a = list[i]
        const b = list[k]
        if (a.v === b.v) continue
        const gap = Math.max(a.x0, b.x0) - Math.min(a.x1, b.x1)
        if (gap < clear - 1e-9) problems.push(`stubs of ${topology.nodes[a.v].code} and ${topology.nodes[b.v].code} are ${gap.toFixed(1)} px apart on one row`)
      }
    }
  }
  return problems
}
