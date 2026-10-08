// Static layout skeleton, computed once per dataset: layout edges, bands, columns, lanes, cell order.
import type { GraphCourse, GraphDataset } from '../data/schema'
import type { Band, EdgeKind, ExcludedEdge, Lane, LayoutEdge, TopoNode, Topology } from './types'

/** 100/200/300/400 bands always exist so headers stay stable even when a level is empty. */
const MIN_BANDS = 4

/** Barycentre keys are compared after rounding so float noise never decides an order. */
const KEY_SCALE = 1e6

/** 000/100 → 0, 200 → 1, 300 → 2, 400 → 3 (any higher level keeps counting up). */
export function bandOfLevel(level: number): number {
  return Math.max(0, Math.floor(level / 100) - 1)
}

/**
 * Builds the static layout. The result depends only on the set of courses, not on their order in
 * `dataset.courses` (node indices follow the input order; every derived field is order-free).
 */
export function buildTopology(dataset: GraphDataset): Topology {
  const courses = dataset.courses
  const n = courses.length
  const indexById = new Map<string, number>()
  courses.forEach((course, index) => indexById.set(course.id, index))

  // Every course sits in the band of its own level.
  const band = courses.map(course => bandOfLevel(course.level))
  const { forward, backward } = splitBackward(collectEdges(courses, indexById), band)
  const { edges, broken } = breakCycles(courses, forward)
  const excludedEdges = [...backward, ...broken].sort(compareEdges)
  const { preds, succs } = buildAdjacency(n, edges)
  const topoOrder = topologicalOrder(preds, succs)

  const depth = localDepths(topoOrder, band, preds)
  const bands = buildBands(band, depth)
  const col = band.map((b, v) => bands[b].startCol + depth[v])
  const columnCount = bands.length ? bands[bands.length - 1].endCol + 1 : 0

  const lanes = buildLanes(dataset)
  const laneBySubject = new Map(lanes.map(lane => [lane.subject, lane.index]))
  const laneOf = courses.map(course => laneBySubject.get(course.subject) ?? 0)

  const cells: number[][][] = lanes.map(() => Array.from({ length: columnCount }, () => []))
  for (let v = 0; v < n; v++) cells[laneOf[v]][col[v]].push(v)
  const order = orderCells(cells, preds, succs, courses)
  for (const lane of lanes) for (const cell of cells[lane.index]) lane.nodes.push(...cell)

  const nodes: TopoNode[] = courses.map((course, index) => ({
    index,
    id: course.id,
    code: course.code,
    title: course.title,
    subject: course.subject,
    level: course.level,
    lane: laneOf[index],
    band: band[index],
    col: col[index],
    order: order[index],
  }))

  return { nodes, indexById, edges, excludedEdges, preds, succs, lanes, bands, columnCount, cells }
}

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const compareEdges = (a: LayoutEdge, b: LayoutEdge) => a.from - b.from || a.to - b.to

/** Prerequisite then corequisite references between loaded courses; one edge per pair, no self-loops. */
function collectEdges(courses: readonly GraphCourse[], indexById: ReadonlyMap<string, number>): LayoutEdge[] {
  const n = courses.length
  const seen = new Set<number>()
  const edges: LayoutEdge[] = []
  const add = (ids: readonly string[] | undefined, to: number, kind: EdgeKind) => {
    for (const id of ids ?? []) {
      const from = indexById.get(id)
      if (from === undefined || from === to || seen.has(from * n + to)) continue
      seen.add(from * n + to)
      edges.push({ from, to, kind })
    }
  }
  courses.forEach((course, to) => add(course.prereq?.ids, to, 'prereq'))
  courses.forEach((course, to) => add(course.coreq?.ids, to, 'coreq'))
  return edges.sort(compareEdges)
}

/** A reference from a higher band to a lower one ("… or 77% in FSL406H5") never shapes the layout. */
function splitBackward(candidates: readonly LayoutEdge[], band: readonly number[]) {
  const forward: LayoutEdge[] = []
  const backward: ExcludedEdge[] = []
  for (const edge of candidates) {
    if (band[edge.from] > band[edge.to]) backward.push({ ...edge, reason: 'backward' })
    else forward.push(edge)
  }
  return { forward, backward }
}

function buildAdjacency(n: number, edges: readonly LayoutEdge[]) {
  const preds: number[][] = Array.from({ length: n }, () => [])
  const succs: number[][] = Array.from({ length: n }, () => [])
  for (const { from, to } of edges) {
    preds[to].push(from)
    succs[from].push(to)
  }
  return { preds, succs }
}

const compareRank = (a: GraphCourse, b: GraphCourse) =>
  a.level - b.level || compareText(a.code, b.code) || compareText(a.id, b.id)

/**
 * Inside each strongly connected component keep only edges that follow (level, code) order; the
 * rest are cycle breakers (e.g. LIN105H5 → LIN104H5). Components and ranks are order-free.
 */
function breakCycles(courses: readonly GraphCourse[], candidates: readonly LayoutEdge[]) {
  const component = stronglyConnected(buildAdjacency(courses.length, candidates).succs)
  const edges: LayoutEdge[] = []
  const broken: ExcludedEdge[] = []
  for (const edge of candidates) {
    const sameComponent = component[edge.from] === component[edge.to]
    if (!sameComponent || compareRank(courses[edge.from], courses[edge.to]) < 0) edges.push(edge)
    else broken.push({ ...edge, reason: 'cycle' })
  }
  return { edges, broken }
}

/** Iterative Tarjan; returns a component id per node. */
function stronglyConnected(succs: readonly number[][]): Int32Array {
  const n = succs.length
  const index = new Int32Array(n).fill(-1)
  const low = new Int32Array(n)
  const component = new Int32Array(n).fill(-1)
  const nextEdge = new Int32Array(n)
  const onStack = new Uint8Array(n)
  const stack: number[] = []
  let counter = 0
  let components = 0

  const visit = (v: number, call: number[]) => {
    index[v] = low[v] = counter++
    stack.push(v)
    onStack[v] = 1
    call.push(v)
  }

  for (let root = 0; root < n; root++) {
    if (index[root] >= 0) continue
    const call: number[] = []
    visit(root, call)
    while (call.length) {
      const v = call[call.length - 1]
      if (nextEdge[v] < succs[v].length) {
        const w = succs[v][nextEdge[v]++]
        if (index[w] < 0) visit(w, call)
        else if (onStack[w]) low[v] = Math.min(low[v], index[w])
        continue
      }
      call.pop()
      if (call.length) {
        const parent = call[call.length - 1]
        low[parent] = Math.min(low[parent], low[v])
      }
      if (low[v] !== index[v]) continue
      let w: number
      do {
        w = stack.pop()!
        onStack[w] = 0
        component[w] = components
      } while (w !== v)
      components++
    }
  }
  return component
}

function topologicalOrder(preds: readonly number[][], succs: readonly number[][]): number[] {
  const indegree = Int32Array.from(preds, list => list.length)
  const order: number[] = []
  for (let v = 0; v < preds.length; v++) if (indegree[v] === 0) order.push(v)
  for (let head = 0; head < order.length; head++) {
    for (const w of succs[order[head]]) if (--indegree[w] === 0) order.push(w)
  }
  if (order.length !== preds.length) throw new Error('Layout edges still contain a cycle')
  return order
}

/** Longest chain of predecessors inside the same band (layout edges never point to a lower band). */
function localDepths(topoOrder: readonly number[], band: readonly number[], preds: readonly number[][]): number[] {
  const depth = new Array<number>(band.length).fill(0)
  for (const v of topoOrder) {
    for (const p of preds[v]) if (band[p] === band[v] && depth[p] + 1 > depth[v]) depth[v] = depth[p] + 1
  }
  return depth
}

function buildBands(band: readonly number[], depth: readonly number[]): Band[] {
  const count = band.reduce((max, b) => Math.max(max, b + 1), MIN_BANDS)
  const deepest = new Array<number>(count).fill(0)
  const courseCount = new Array<number>(count).fill(0)
  band.forEach((b, v) => {
    deepest[b] = Math.max(deepest[b], depth[v])
    courseCount[b]++
  })
  let startCol = 0
  return deepest.map((maxDepth, index) => {
    const result: Band = { index, level: (index + 1) * 100, startCol, endCol: startCol + maxDepth, courseCount: courseCount[index] }
    startCol += maxDepth + 1
    return result
  })
}

/** One lane per subject present, ordered by division (dataset order, unknown last) then subject code. */
function buildLanes(dataset: GraphDataset): Lane[] {
  const info = new Map(dataset.subjects.map(subject => [subject.code, subject]))
  const divisionRank = new Map(dataset.divisions.map((division, rank) => [division.id, rank]))
  const rank = (division: string) => divisionRank.get(division) ?? dataset.divisions.length
  const subjects = [...new Set(dataset.courses.map(course => course.subject))]
  return subjects
    .map(subject => {
      const entry = info.get(subject)
      return { subject, name: entry?.name || subject, department: entry?.department ?? '', division: entry?.division ?? '' }
    })
    .sort((a, b) => rank(a.division) - rank(b.division) || compareText(a.subject, b.subject))
    .map((entry, index) => ({ index, key: `${dataset.campus}:${entry.subject}`, ...entry, nodes: [] }))
}

/**
 * Sorts every cell in place and returns each node's position in its cell.
 *
 * Pass 1 walks the columns left → right and orders each cell by the barycentre of its nodes'
 * predecessor positions (a position is lane index + relative slot inside the cell, so it compares
 * across lanes). Roots have no predecessors, so after pass 1 every root that has successors takes
 * the barycentre of those successors' pass-1 positions, and pass 2 repeats the left → right walk
 * with these keys. This pulls a root such as BBB103H5 towards the row its dependents ended up on.
 * Keyless nodes (isolated courses) go last.
 *
 * Keys are rounded to 1e-6 and summed in sorted order, and ties fall back to code then id, so the
 * order never depends on float noise or on the order of the input courses.
 */
function orderCells(
  cells: number[][][],
  preds: readonly number[][],
  succs: readonly number[][],
  courses: readonly GraphCourse[],
): number[] {
  const n = courses.length
  const order = new Array<number>(n).fill(0)
  const position = new Float64Array(n)
  const key = new Float64Array(n)
  const columnCount = cells[0]?.length ?? 0
  const scratch: number[] = []
  const barycentre = (list: readonly number[]) => {
    if (!list.length) return NaN
    scratch.length = 0
    for (const v of list) scratch.push(position[v])
    scratch.sort((a, b) => a - b)
    let sum = 0
    for (const value of scratch) sum += value
    return Math.round((sum / list.length) * KEY_SCALE)
  }
  const compare = (a: number, b: number) => {
    const missingA = Number.isNaN(key[a])
    const missingB = Number.isNaN(key[b])
    if (missingA !== missingB) return missingA ? 1 : -1
    if (!missingA && key[a] !== key[b]) return key[a] - key[b]
    return compareText(courses[a].code, courses[b].code) || compareText(courses[a].id, courses[b].id)
  }
  const sweep = (keyOf: (v: number) => number) => {
    for (let col = 0; col < columnCount; col++) {
      cells.forEach((row, lane) => {
        const cell = row[col]
        if (!cell.length) return
        for (const v of cell) key[v] = keyOf(v)
        cell.sort(compare)
        cell.forEach((v, k) => {
          order[v] = k
          position[v] = lane + (k + 0.5) / cell.length
        })
      })
    }
  }

  sweep(v => barycentre(preds[v]))
  const rootKey = Float64Array.from(preds, (list, v) => (list.length ? NaN : barycentre(succs[v])))
  sweep(v => (preds[v].length ? barycentre(preds[v]) : rootKey[v]))
  return order
}
