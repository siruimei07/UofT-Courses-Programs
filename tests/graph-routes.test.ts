import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildTopology, computeGeometry, computePresentation, computeRoutes, dotRadius, plainEdgePaths, samplePath } from '../src/graph'
import type { EdgeRole, Geometry, PathSegment, Presentation, PresentationInput, RoutedPath, Routes, Topology } from '../src/graph'
import { loadGraphDataset, presentationInput, syntheticDataset } from './helpers/dataset'
import { anyGroupsFor, bestOf, lastPoint, obstacleBoxes, pathIntrusions, stubFocusLines, stubMeasure } from './helpers/graph'

const { dataset } = loadGraphDataset()
const topology = buildTopology(dataset)
const measure = stubMeasure(topology)
const ROUTED: ReadonlySet<EdgeRole> = new Set<EdgeRole>(['prereq-direct', 'prereq', 'unlock-direct', 'unlock', 'program'])

interface Scene {
  topo: Topology
  presentation: Presentation
  geometry: Geometry
  routes: Routes
  focus: number
  ms: number
}

function scene(input: PresentationInput, topo = topology, anyGroups?: number[][]): Scene {
  const presentation = computePresentation(topo, input)
  const focus = presentation.role.indexOf('focus')
  const geometry = computeGeometry(topo, presentation, stubMeasure(topo), { focusLines: focus >= 0 ? stubFocusLines(topo, focus) : undefined })
  const groups = anyGroups ?? (focus >= 0 && topo === topology ? anyGroupsFor(dataset, topo, focus) : [])
  const { result: routes, ms } = bestOf(3, () => computeRoutes(topo, presentation, geometry, { anyGroups: groups }))
  return { topo, presentation, geometry, routes, focus, ms }
}

const focusScene = (code: string, extra: Partial<PresentationInput> = {}) => scene(presentationInput({ focusId: `UTM:${code}`, ...extra }))
const index = (topo: Topology, code: string) => topo.indexById.get(`UTM:${code}`)!
const edgeIndex = (topo: Topology, from: string, to: string) =>
  topo.edges.findIndex(edge => edge.from === index(topo, from) && edge.to === index(topo, to))
const firstPoint = (segments: readonly PathSegment[]) => ({ x: segments[0].x, y: segments[0].y })

/** Structural rules every routing result must satisfy (8.7-8.9). */
function routeProblems({ topo, presentation, geometry, routes, focus }: Scene): string[] {
  const problems: string[] = []
  const name = (path: RoutedPath) => (path.edge < 0 ? path.shape : `${topo.nodes[topo.edges[path.edge].from].code}>${topo.nodes[topo.edges[path.edge].to].code}`)
  const expected = topo.edges.map((_, e) => e).filter(e => ROUTED.has(presentation.edgeRole[e]))
  const seen = routes.paths.filter(path => path.edge >= 0).map(path => path.edge).sort((a, b) => a - b)
  if (JSON.stringify(seen) !== JSON.stringify(expected)) problems.push(`routed ${seen.length} edges, expected ${expected.length}`)
  const junctions = routes.paths.filter(path => path.shape === 'fork').map(path => firstPoint(path.segments))
  const trunkEnds = routes.paths.filter(path => path.shape === 'trunk').map(path => lastPoint(path.segments))
  for (const path of routes.paths) {
    if (path.segments[0]?.op !== 'M' || path.segments.slice(1).some(s => s.op === 'M')) problems.push(`${name(path)}: must start with one M`)
    if (path.edge >= 0 && (path.role !== presentation.edgeRole[path.edge] || path.kind !== topo.edges[path.edge].kind)) problems.push(`${name(path)}: role / kind`)
    // Direction is always left to right.
    let previous = -Infinity
    samplePath(path.segments, 2, x => {
      if (x < previous - 1e-6) problems.push(`${name(path)} runs backwards at x=${x.toFixed(1)}`)
      previous = x
      return x < previous - 1e-6
    })
    if (path.edge < 0) continue
    const { from, to } = topo.edges[path.edge]
    const start = firstPoint(path.segments)
    const end = lastPoint(path.segments)
    const source = geometry.nodes[from]
    const target = geometry.nodes[to]
    // Starts at the leader (labelEnd + 4), at a bundle split point, or at the source's own row.
    const atLeader = Math.abs(start.x - (source.x + source.w + 4)) < 1e-6
    const atSplit = trunkEnds.some(point => Math.abs(point.x - start.x) < 1e-6 && Math.abs(point.y - start.y) < 1e-6)
    if (!atLeader && !atSplit) problems.push(`${name(path)} starts at ${start.x},${start.y}`)
    // Ends at the target's dot (cx − r − 1 or its entry), or at a fork junction / merge point.
    const r = dotRadius(presentation.role[to], target.cls)
    const atDot = Math.abs(end.y - target.cy) < 1e-6 && end.x <= target.cx - r + 1e-6 && end.x >= target.cx - r - 12
    const atJunction = junctions.some(point => Math.abs(point.x - end.x) < 1e-6 && Math.abs(point.y - end.y) < 1e-6)
    const atMerge = to === focus && path.shape === 'branch'
    if (!atDot && !atJunction && !atMerge) problems.push(`${name(path)} ends at ${end.x},${end.y}`)
  }
  return problems
}

function expectClean(s: Scene, label: string) {
  const intrusions = pathIntrusions(s.topo, s.routes.paths, obstacleBoxes(s.topo, s.presentation, s.geometry), s.focus)
  expect(intrusions, label).toEqual([])
  expect(s.routes.fallbacks, label).toBe(0)
  expect(routeProblems(s), label).toEqual([])
}

describe('routes on the real UTM dataset (design-spec 16.2)', () => {
  it.each(['all', 'direct'] as const)('routes the CSC148H5 chain (chain titles %s) past every label and dot', chainTitles => {
    const s = focusScene('CSC148H5', { chainTitles })
    expect(s.routes.paths.length).toBeGreaterThan(20)
    expectClean(s, `CSC148H5 ${chainTitles}`)
    // CSC148H5 → CSC338H5 / CSC310H5 run past the 200-level CSC labels.
    for (const target of ['CSC338H5', 'CSC310H5']) {
      const e = edgeIndex(topology, 'CSC148H5', target)
      if (e < 0) continue
      expect(s.routes.paths.filter(path => path.edge === e)).toHaveLength(1)
    }
    const passed = ['CSC211H5', 'CSC290H5', 'CSC236H5', 'CSC263H5'].filter(code => s.geometry.nodes[index(topology, code)].cls !== 'mini')
    expect(passed.length).toBeGreaterThan(0)
  })

  it.each(['all', 'direct'] as const)('routes the MAT232H5 fan (chain titles %s) past the MAT236H5 code line', chainTitles => {
    const s = focusScene('MAT232H5', { chainTitles })
    expectClean(s, `MAT232H5 ${chainTitles}`)
    expect(s.geometry.nodes[index(topology, 'MAT236H5')].cls).toBe('full')
    const direct = topology.succs[s.focus].map(to => topology.edges.findIndex(edge => edge.from === s.focus && edge.to === to))
    for (const e of direct) expect(s.routes.paths.some(path => path.edge === e)).toBe(true)
  })

  it('routes MAT232H5 → MAT402H5 past MAT354H5', () => {
    const s = focusScene('MAT232H5')
    const e = edgeIndex(topology, 'MAT232H5', 'MAT402H5')
    expect(e).toBeGreaterThanOrEqual(0)
    const paths = s.routes.paths.filter(path => path.edge === e)
    expect(paths).toHaveLength(1)
    const mat354 = obstacleBoxes(topology, s.presentation, s.geometry).filter(box => box.owner === index(topology, 'MAT354H5'))
    expect(mat354).toHaveLength(2)
    expect(pathIntrusions(topology, paths, mat354, s.focus)).toEqual([])
    // The trunk that carries the branch avoids MAT354H5 as well.
    expect(pathIntrusions(topology, s.routes.paths.filter(path => path.shape === 'trunk'), mat354, s.focus)).toEqual([])
  })

  it.each(['ECO200Y5', 'PSY100Y5', 'STA256H5', 'SOC221H5'])('bundles the %s unlock fan into trunks and branches', code => {
    const s = focusScene(code, { chainTitles: 'direct' })
    expectClean(s, code)
    const direct = s.routes.paths.filter(path => path.edge >= 0 && path.role === 'unlock-direct')
    expect(direct.length).toBeGreaterThanOrEqual(6)
    const trunks = s.routes.paths.filter(path => path.shape === 'trunk' && path.role === 'unlock-direct')
    expect(trunks.length).toBeGreaterThan(0)
    const focusBox = s.geometry.nodes[s.focus]
    const starts = trunks.map(trunk => firstPoint(trunk.segments).y - focusBox.cy)
    // Trunk starts are staggered 3 px per group around the focus row, at most ± 9 px.
    expect(starts.every(offset => Math.abs(offset) <= 9 + 1e-6)).toBe(true)
    if (trunks.length <= 7) expect(new Set(starts.map(offset => offset.toFixed(3))).size).toBe(trunks.length)
    for (const trunk of trunks) {
      const split = lastPoint(trunk.segments)
      const branches = s.routes.paths.filter(path => path.shape === 'branch' && Math.abs(firstPoint(path.segments).x - split.x) < 1e-6 && Math.abs(firstPoint(path.segments).y - split.y) < 1e-6)
      expect(branches.length).toBeGreaterThanOrEqual(3)
      const cols = new Set(branches.map(path => topology.nodes[topology.edges[path.edge].to].col))
      expect(cols.size).toBe(1)
      const column = s.geometry.columns[[...cols][0]]
      expect(split.x).toBeLessThan(column.x)
      expect(split.x).toBeGreaterThanOrEqual(column.x - 22 - 1e-6)
      for (const branch of branches) expect(topology.edges[branch.edge].from).toBe(s.focus)
    }
    console.log(`[graph] ${code}: ${direct.length} direct unlocks, ${trunks.length} trunks, routes ${s.ms.toFixed(2)} ms`)
  })

  it('draws parsed "any one of" groups through a fork junction in front of the focus', () => {
    const s = focusScene('MAT232H5')
    const groups = anyGroupsFor(dataset, topology, s.focus)
    const forks = s.routes.paths.filter(path => path.shape === 'fork')
    expect(forks).toHaveLength(groups.length)
    const focusBox = s.geometry.nodes[s.focus]
    const xIn = s.geometry.columns[topology.nodes[s.focus].col].x - 2
    for (const fork of forks) {
      const junction = firstPoint(fork.segments)
      expect(junction.x).toBeGreaterThanOrEqual(xIn - 28 - 1e-6)
      expect(junction.x).toBeLessThan(xIn)
      expect(lastPoint(fork.segments).y).toBe(focusBox.cy)
      expect(fork).toMatchObject({ edge: -1, role: 'prereq-direct', kind: 'prereq' })
    }
    for (const group of groups) {
      for (const source of group) {
        const path = s.routes.paths.find(candidate => candidate.edge >= 0 && topology.edges[candidate.edge].from === source && topology.edges[candidate.edge].to === s.focus)!
        const end = lastPoint(path.segments)
        // Members end at the junction centre, which is the fork stub's first point (the renderer matches them there).
        expect(forks.some(fork => Math.abs(firstPoint(fork.segments).x - end.x) < 1e-6 && firstPoint(fork.segments).y === end.y)).toBe(true)
      }
    }
    expectClean(s, 'MAT232H5 forks')
  })

  it('routes program edges in program mode and nothing in the overview', () => {
    expect(scene(presentationInput()).routes).toEqual({ paths: [], fallbacks: 0 })
    expect(scene(presentationInput({ titles: true, showAllEdges: true })).routes.paths).toHaveLength(0)
    const programIds = new Set(topology.nodes.filter(n => ['CSC', 'MAT', 'STA'].includes(n.subject) && n.level < 300).map(n => n.id))
    const s = scene(presentationInput({ programIds }))
    expect(s.routes.paths.length).toBeGreaterThan(20)
    expect(new Set(s.routes.paths.map(path => path.role))).toEqual(new Set(['program']))
    expectClean(s, 'program')
  })

  it('routes a sample of every 5th course chain with (almost) no fallbacks', () => {
    let edges = 0
    let fallbacks = 0
    const offenders: string[] = []
    topology.nodes.forEach((node, v) => {
      if (v % 5) return
      for (const chainTitles of ['all', 'direct'] as const) {
        const presentation = computePresentation(topology, presentationInput({ focusId: node.id, chainTitles }))
        const geometry = computeGeometry(topology, presentation, measure, { focusLines: stubFocusLines(topology, v) })
        const routes = computeRoutes(topology, presentation, geometry, { anyGroups: anyGroupsFor(dataset, topology, v) })
        edges += routes.paths.length
        fallbacks += routes.fallbacks
        if (routes.fallbacks) offenders.push(`${node.code}/${chainTitles}:${routes.fallbacks}`)
      }
    })
    console.log(`[graph] sweep: ${fallbacks} fallbacks over ${edges} paths${offenders.length ? ` (${offenders.join(', ')})` : ''}`)
    // 0 on the 2026-27 data; a little slack so a regenerated dataset does not need this test edited.
    expect(fallbacks).toBeLessThanOrEqual(edges * 0.002)
  })

  it('meets the 30 ms budget for <= 400 highlighted edges (and stays deterministic)', () => {
    const rows: Array<[string, Scene]> = ['PSY100Y5', 'STA256H5', 'SOC221H5', 'MAT102H5'].map(code => [code, focusScene(code)])
    const programsPath = join(process.cwd(), 'public', 'data', 'utm', 'programs.json')
    if (existsSync(programsPath)) {
      try {
        const programs = (JSON.parse(readFileSync(programsPath, 'utf8')) as { programs: Array<{ code: string; groups: Array<{ ids: string[] }> }> }).programs
        let best: { code: string; ids: Set<string>; edges: number } | null = null
        for (const program of programs) {
          const ids = new Set(program.groups.flatMap(group => group.ids))
          const edges = computePresentation(topology, presentationInput({ programIds: ids })).edgeRole.filter(role => role === 'program').length
          if (edges <= 400 && (!best || edges > best.edges)) best = { code: program.code, ids, edges }
        }
        if (best) rows.push([`program ${best.code}`, scene(presentationInput({ programIds: best.ids }))])
      } catch {
        // The pipeline may be rewriting programs.json; the focus cases still cover the budget.
      }
    }
    for (const [name, s] of rows) {
      const edges = s.routes.paths.filter(path => path.edge >= 0).length
      console.log(`[graph] routes (${name}): ${s.ms.toFixed(2)} ms for ${edges} edges / ${s.routes.paths.length} paths, ${s.routes.fallbacks} fallbacks`)
      if (edges <= 400) expect(s.ms).toBeLessThan(30)
      const again = computeRoutes(s.topo, s.presentation, s.geometry, { anyGroups: s.focus >= 0 ? anyGroupsFor(dataset, topology, s.focus) : [] })
      expect(again).toEqual(s.routes)
    }
  })
})

// ---------------------------------------------------------------------------

describe('routing rules on synthetic layouts', () => {
  const synthetic = (courses: Parameters<typeof syntheticDataset>[0]) => buildTopology(syntheticDataset(courses))

  it('anchors a plain curve at the leader and the dot with k = clamp(0.45 · dx, 16, 240)', () => {
    const topo = synthetic([{ code: 'AAA101H5' }, { code: 'AAA102H5', prereq: ['AAA101H5'] }])
    const s = scene(presentationInput({ focusId: 'UTM:AAA101H5' }), topo, [])
    expect(s.routes.paths).toHaveLength(1)
    const [path] = s.routes.paths
    const source = s.geometry.nodes[0]
    const target = s.geometry.nodes[1]
    const column0 = s.geometry.columns[0]
    const xOut = Math.max(column0.x + column0.w - 2, source.x + source.w + 4)
    const xIn = s.geometry.columns[1].x - 2
    // k = clamp(0.45 · dx, 16, 240), kept below dx so the 14 px hop out of the plate never folds back.
    const k = Math.min(Math.max(0.45 * (xIn - xOut), 16), 240, 0.9 * (xIn - xOut))
    expect(path).toMatchObject({ edge: 0, role: 'unlock-direct', kind: 'prereq', shape: 'edge' })
    expect(path.segments).toEqual([
      { op: 'M', x: source.x + source.w + 4, y: source.cy },
      ...(xOut > source.x + source.w + 4 ? [{ op: 'L', x: xOut, y: source.cy }] : []),
      { op: 'C', x1: xOut + k, y1: source.cy, x2: xIn - k, y2: target.cy, x: xIn, y: target.cy },
      { op: 'L', x: target.cx - 5 - 1, y: target.cy },
    ])
  })

  it('never takes the plain curve for a same-row link that skips a column, and avoids labels in between', () => {
    // AAA101 → AAA102 → AAA103 and AAA101 → AAA103: the long edge would cross AAA102's label.
    const topo = synthetic([{ code: 'AAA101H5' }, { code: 'AAA102H5', prereq: ['AAA101H5'] }, { code: 'AAA103H5', prereq: ['AAA102H5', 'AAA101H5'] }])
    const s = scene(presentationInput({ programIds: new Set(topo.nodes.map(n => n.id)) }), topo, [])
    const long = s.routes.paths.find(path => path.edge === edgeIndex(topo, 'AAA101H5', 'AAA103H5'))!
    expect(s.geometry.nodes[0].cy).toBe(s.geometry.nodes[2].cy)
    const ys = new Set<number>()
    samplePath(long.segments, 2, (_x, y) => {
      ys.add(Math.round(y))
      return false
    })
    expect(ys.size).toBeGreaterThan(1)
    expectClean(s, 'same row')
  })

  it('S-steps through the row gap out of and into wrapped tracks', () => {
    // 30 compact AAA2xx courses in one cell wrap into two tracks; each hangs off AAA101 and unlocks AAA301.
    const middle = Array.from({ length: 30 }, (_, i) => `AAA2${String(i + 10)}H5`)
    const topo = synthetic([
      { code: 'AAA101H5' },
      ...middle.map(code => ({ code, prereq: ['AAA101H5'] })),
      { code: 'AAA301H5', prereq: middle },
    ])
    const s = scene(presentationInput({ focusId: 'UTM:AAA101H5', chainTitles: 'direct', depth: 'direct' }), topo, [])
    expect(s.geometry.columns[topo.nodes[index(topo, middle[0])].col].tracks).toBeGreaterThan(1)
    expectClean(s, 'wrapped targets')
    const out = scene(presentationInput({ focusId: 'UTM:AAA301H5', chainTitles: 'direct', depth: 'direct' }), topo, [])
    expectClean(out, 'wrapped sources')
    // A source in the first track leaves through a row gap: some segment ends half a (full, 40 px) row off its cy.
    const v = index(topo, middle[0])
    const path = out.routes.paths.find(candidate => candidate.edge >= 0 && topo.edges[candidate.edge].from === v)
      ?? out.routes.paths.find(candidate => candidate.shape === 'branch' && topo.edges[candidate.edge].from === v)!
    const box = out.geometry.nodes[v]
    expect(box.track).toBe(0)
    expect(path.segments.some(segment => Math.abs(Math.abs(segment.y - box.cy) - 20) < 1e-6)).toBe(true)
  })

  it('bundles a prerequisite fan of >= 6 into branches, a merge point and a trunk (mirrored 8.9)', () => {
    const sources = Array.from({ length: 7 }, (_, i) => `AAA1${String(i + 10)}H5`)
    const topo = synthetic([...sources.map(code => ({ code })), { code: 'AAA301H5', prereq: sources }])
    const s = scene(presentationInput({ focusId: 'UTM:AAA301H5' }), topo, [])
    const trunks = s.routes.paths.filter(path => path.shape === 'trunk')
    expect(trunks).toHaveLength(1)
    expect(trunks[0]).toMatchObject({ edge: -1, role: 'prereq-direct', kind: 'prereq' })
    const merge = firstPoint(trunks[0].segments)
    const branches = s.routes.paths.filter(path => path.shape === 'branch')
    expect(branches).toHaveLength(7)
    for (const branch of branches) expect(lastPoint(branch.segments)).toEqual(merge)
    const focusBox = s.geometry.nodes[s.focus]
    expect(lastPoint(trunks[0].segments)).toEqual({ x: s.geometry.columns[topo.nodes[s.focus].col].x - 2, y: focusBox.cy })
    expectClean(s, 'prereq fan')
  })

  it('keeps fans of fewer than 6 edges, and groups of fewer than 3 per column, unbundled', () => {
    const targets = Array.from({ length: 5 }, (_, i) => `AAA2${String(i + 10)}H5`)
    const small = synthetic([{ code: 'AAA101H5' }, ...targets.map(code => ({ code, prereq: ['AAA101H5'] }))])
    expect(scene(presentationInput({ focusId: 'UTM:AAA101H5' }), small, []).routes.paths.every(path => path.shape === 'edge')).toBe(true)
    // 6 targets, but split 2 / 2 / 2 over three columns.
    const spread = synthetic([
      { code: 'AAA101H5' }, { code: 'AAA201H5', prereq: ['AAA101H5'] }, { code: 'AAA202H5', prereq: ['AAA101H5'] },
      { code: 'AAA301H5', prereq: ['AAA101H5'] }, { code: 'AAA302H5', prereq: ['AAA101H5'] },
      { code: 'AAA401H5', prereq: ['AAA101H5'] }, { code: 'AAA402H5', prereq: ['AAA101H5'] },
    ])
    expect(scene(presentationInput({ focusId: 'UTM:AAA101H5' }), spread, []).routes.paths.every(path => path.shape === 'edge')).toBe(true)
  })

  it('stacks several fork junctions and keeps the entry line free for other direct prerequisites', () => {
    const topo = synthetic([
      { code: 'AAA101H5' }, { code: 'AAA102H5' }, { code: 'AAA103H5' }, { code: 'AAA104H5' }, { code: 'AAA105H5' },
      { code: 'AAA201H5', prereq: ['AAA101H5', 'AAA102H5', 'AAA103H5', 'AAA104H5', 'AAA105H5'] },
    ])
    const groups = [[index(topo, 'AAA101H5'), index(topo, 'AAA102H5')], [index(topo, 'AAA103H5'), index(topo, 'AAA104H5')]]
    const s = scene(presentationInput({ focusId: 'UTM:AAA201H5' }), topo, groups)
    const forks = s.routes.paths.filter(path => path.shape === 'fork').map(path => firstPoint(path.segments))
    const cy = s.geometry.nodes[s.focus].cy
    expect(forks.map(point => point.y - cy).sort((a, b) => a - b)).toEqual([-10, 10])
    const other = s.routes.paths.find(path => path.edge === edgeIndex(topo, 'AAA105H5', 'AAA201H5'))!
    expect(lastPoint(other.segments).y).toBe(cy)
    expectClean(s, 'forks')
    // One group and no other direct prerequisite: the junction sits on the focus row.
    const single = scene(presentationInput({ focusId: 'UTM:AAA201H5' }), topo, [[0, 1, 2, 3, 4]])
    expect(single.routes.paths.filter(path => path.shape === 'fork').map(path => firstPoint(path.segments).y)).toEqual([cy])
  })

  it('offers plain anchored curves for hover previews', () => {
    const s = focusScene('CSC148H5')
    const edges = topology.edges.map((_, e) => e).filter(e => s.presentation.edgeRole[e] === 'unlock-direct')
    const plain = plainEdgePaths(topology, s.presentation, s.geometry, edges)
    expect(plain).toHaveLength(edges.length)
    for (const segments of plain) expect(segments[0].op).toBe('M')
  })
})
