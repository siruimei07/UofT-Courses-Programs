// Deterministic stand-ins for the renderer's text module plus shared graph checks for the tests.
import type { GraphDataset } from '../../src/data/schema'
import type { Rule } from '../../src/domain/types'
import { DEFAULT_GEOMETRY_OPTIONS, dotRadius, samplePath } from '../../src/graph'
import type { Geometry, LabelMeasure, PathSegment, Presentation, RoutedPath, Topology } from '../../src/graph'

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
  for (const path of paths) {
    const owners = pathOwners(topology, path, focus)
    const label = path.edge < 0 ? `${path.shape}` : `${topology.nodes[topology.edges[path.edge].from].code}>${topology.nodes[topology.edges[path.edge].to].code}`
    samplePath(path.segments, 1, (x, y) => {
      for (const box of boxes) {
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
