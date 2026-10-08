import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildTopology, computeGeometry, computePresentation, computeRoutes, dotRadius, geometryOptions, plainEdgePaths, plainEdgeStubs,
  samplePath,
} from '../src/graph'
import type { EdgeRole, Eligibility, Geometry, PathSegment, Presentation, PresentationInput, RoutedPath, Routes, Topology } from '../src/graph'
import { loadGraphDataset, presentationInput, syntheticDataset } from './helpers/dataset'
import {
  anyGroupsFor, bestOf, coincidentRuns, containmentProblems, lastPoint, laterTrackReaches, obstacleBoxes, pathEnds, pathIntrusions, stubFocusLines,
  stubMeasure, wrappedMerges,
} from './helpers/graph'

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

function scene(input: PresentationInput, topo = topology, anyGroups?: number[][], options: Parameters<typeof computeGeometry>[3] = {}): Scene {
  const presentation = computePresentation(topo, input)
  const focus = presentation.role.indexOf('focus')
  const geometry = computeGeometry(topo, presentation, stubMeasure(topo), { ...options, focusLines: focus >= 0 ? stubFocusLines(topo, focus) : undefined })
  const groups = anyGroups ?? (focus >= 0 && topo === topology ? anyGroupsFor(dataset, topo, focus) : [])
  const { result: routes, ms } = bestOf(3, () => computeRoutes(topo, presentation, geometry, { anyGroups: groups }))
  return { topo, presentation, geometry, routes, focus, ms }
}

const focusScene = (code: string, extra: Partial<PresentationInput> = {}) => scene(presentationInput({ focusId: `UTM:${code}`, ...extra }))
const index = (topo: Topology, code: string) => {
  const v = topo.indexById.get(`UTM:${code}`)
  if (v === undefined) throw new Error(`Missing course ${code}`)
  return v
}
/** Index of the layout edge; a named pair that disappeared from the data fails loudly instead of passing. */
const edgeIndex = (topo: Topology, from: string, to: string) => {
  const e = topo.edges.findIndex(edge => edge.from === index(topo, from) && edge.to === index(topo, to))
  if (e < 0) throw new Error(`Missing layout edge ${from} → ${to}`)
  return e
}
const firstPoint = (segments: readonly PathSegment[]) => ({ x: segments[0].x, y: segments[0].y })
const pathName = (topo: Topology, path: RoutedPath) =>
  path.edge < 0 ? path.shape : `${topo.nodes[topo.edges[path.edge].from].code}>${topo.nodes[topo.edges[path.edge].to].code}`

/** Structural rules every routing result must satisfy (8.7-8.9). */
function routeProblems({ topo, presentation, geometry, routes, focus }: Scene): string[] {
  const problems: string[] = []
  const expected = topo.edges.map((_, e) => e).filter(e => ROUTED.has(presentation.edgeRole[e]))
  const seen = routes.paths.filter(path => path.edge >= 0).map(path => path.edge).sort((a, b) => a - b)
  if (JSON.stringify(seen) !== JSON.stringify(expected)) problems.push(`routed ${seen.length} edges, expected ${expected.length}`)
  const junctions = routes.paths.filter(path => path.shape === 'fork').map(path => firstPoint(path.segments))
  const trunkEnds = routes.paths.filter(path => path.shape === 'trunk').map(path => lastPoint(path.segments))
  for (const path of routes.paths) {
    const name = pathName(topo, path)
    if (path.segments[0]?.op !== 'M' || path.segments.slice(1).some(s => s.op === 'M')) problems.push(`${name}: must start with one M`)
    if (path.edge >= 0 && (path.role !== presentation.edgeRole[path.edge] || path.kind !== topo.edges[path.edge].kind)) problems.push(`${name}: role / kind`)
    // Direction is always left to right.
    let previous = -Infinity
    samplePath(path.segments, 2, x => {
      if (x < previous - 1e-6) problems.push(`${name} runs backwards at x=${x.toFixed(1)}`)
      previous = x
      return x < previous - 1e-6
    })
    if (path.edge < 0) continue
    const { from, to } = topo.edges[path.edge]
    const start = firstPoint(path.segments)
    const end = lastPoint(path.segments)
    const source = geometry.nodes[from]
    const target = geometry.nodes[to]
    // Starts at the leader (labelEnd + 4) or at a bundle split point.
    const atLeader = Math.abs(start.x - (source.x + source.w + 4)) < 1e-6
    const atSplit = trunkEnds.some(point => Math.abs(point.x - start.x) < 1e-6 && Math.abs(point.y - start.y) < 1e-6)
    if (!atLeader && !atSplit) problems.push(`${name} starts at ${start.x},${start.y}`)
    // Ends at the target's dot (cx − r − 1 or its entry), at a fork junction or at a merge point. A
    // target in a later wrapped track is entered straight from above or below (cx, cy ∓ (r + 1)).
    const r = dotRadius(presentation.role[to], target.cls)
    const fromSide = target.track > 0 && Math.abs(end.x - target.cx) < 1e-6 && Math.abs(Math.abs(end.y - target.cy) - (r + 1)) < 1e-6
    const atDot = fromSide || (Math.abs(end.y - target.cy) < 1e-6 && end.x <= target.cx - r + 1e-6 && end.x >= target.cx - r - 12)
    const atJunction = junctions.some(point => Math.abs(point.x - end.x) < 1e-6 && Math.abs(point.y - end.y) < 1e-6)
    const atMerge = to === focus && path.shape === 'branch'
    if (!atDot && !atJunction && !atMerge) problems.push(`${name} ends at ${end.x},${end.y}`)
  }
  return problems
}

/** Product rule in wrapped columns: no source's run meets a target's run, nothing reaches a later-track dot on its row. */
function sameColumnProblems({ topo, geometry, routes, focus }: Scene): string[] {
  const paths = routes.paths.map(path => ({ edge: path.edge, segments: path.segments, ends: pathEnds(topo, path, focus) }))
  return [...wrappedMerges(topo, geometry, paths), ...laterTrackReaches(topo, geometry, routes.paths)]
}

/** No label / dot intrusion, exactly 0 fallbacks, contained runs, no shared runs, structural rules. */
function expectClean(s: Scene, label: string) {
  expect(pathIntrusions(s.topo, s.routes.paths, obstacleBoxes(s.topo, s.presentation, s.geometry), s.focus), label).toEqual([])
  expect(s.routes.fallbacks, label).toBe(0)
  expect(containmentProblems(s.topo, s.geometry, s.routes, s.focus), label).toEqual([])
  expect(coincidentRuns(s.topo, s.routes, s.focus), label).toEqual([])
  expect(routeProblems(s), label).toEqual([])
  expect(sameColumnProblems(s), label).toEqual([])
}

const programs: Array<{ code: string; ids: Set<string> }> = (() => {
  const path = join(process.cwd(), 'public', 'data', 'utm', 'programs.json')
  if (!existsSync(path)) return []
  const raw = JSON.parse(readFileSync(path, 'utf8')) as { programs: Array<{ code: string; groups: Array<{ ids: string[] }> }> }
  return raw.programs.map(program => ({ code: program.code, ids: new Set(program.groups.flatMap(group => group.ids)) }))
})()

describe('routes on the real UTM dataset (design-spec 16.2)', () => {
  it.each(['all', 'direct'] as const)('routes the CSC148H5 chain (chain titles %s) past every label and dot', chainTitles => {
    const s = focusScene('CSC148H5', { chainTitles })
    expect(s.routes.paths.length).toBeGreaterThan(20)
    expectClean(s, `CSC148H5 ${chainTitles}`)
    // The 200-level labels CSC148H5 → CSC338H5 / CSC310H5 must pass are all on screen ...
    for (const code of ['CSC211H5', 'CSC290H5', 'CSC236H5', 'CSC263H5']) expect(s.geometry.nodes[index(topology, code)].cls, code).not.toMatch(/mini|hidden/)
    const named = ['CSC338H5', 'CSC310H5'].map(target => edgeIndex(topology, 'CSC148H5', target))
    for (const e of named) expect(s.routes.paths.filter(path => path.edge === e)).toHaveLength(1)
    // ... and the plain curves would cross labels, so the corridor routing is what keeps them clear.
    const plain = plainEdgePaths(topology, s.geometry, named, { presentation: s.presentation, leader: true })
    const plainPaths = plain.map((segments, k): RoutedPath => ({ edge: named[k], role: 'unlock-direct', kind: 'prereq', shape: 'edge', segments }))
    expect(pathIntrusions(topology, plainPaths, obstacleBoxes(topology, s.presentation, s.geometry), s.focus).length).toBeGreaterThan(0)
  })

  it.each(['all', 'direct'] as const)('routes the MAT232H5 fan (chain titles %s) past the MAT236H5 code line', chainTitles => {
    const s = focusScene('MAT232H5', { chainTitles })
    expectClean(s, `MAT232H5 ${chainTitles}`)
    expect(s.geometry.nodes[index(topology, 'MAT236H5')].cls).toBe('full')
    const direct = topology.succs[s.focus].map(to => topology.edges.findIndex(edge => edge.from === s.focus && edge.to === to))
    expect(direct.length).toBeGreaterThan(5)
    for (const e of direct) expect(s.routes.paths.some(path => path.edge === e)).toBe(true)
  })

  it('routes MAT232H5 → MAT402H5 past MAT354H5', () => {
    const s = focusScene('MAT232H5')
    const e = edgeIndex(topology, 'MAT232H5', 'MAT402H5')
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
      // One lane and one edge kind per trunk: no rail across lanes, dashes only for corequisites.
      expect(new Set(branches.map(path => topology.nodes[topology.edges[path.edge].to].lane)).size).toBe(1)
      expect(new Set(branches.map(path => topology.edges[path.edge].kind))).toEqual(new Set([trunk.kind]))
      const column = s.geometry.columns[[...cols][0]]
      expect(split.x).toBeLessThan(column.x)
      expect(split.x).toBeGreaterThanOrEqual(column.x - 22 - 1e-6)
      for (const branch of branches) expect(topology.edges[branch.edge].from).toBe(s.focus)
    }
    console.log(`[graph] ${code}: ${direct.length} direct unlocks, ${trunks.length} trunks, routes ${s.ms.toFixed(2)} ms`)
  })

  it('never bundles required prerequisites with optional corequisites (ECO200Y5, 7.4 / 8.9)', () => {
    // ECO200Y5: ECO101H5 and ECO102H5 are prerequisites on the focus row; MAT133Y5 / MAT135H5 /
    // MAT137H5 (and MAT136H5 / MAT139H5) are "1 of 5" corequisites in the MAT lane above.
    const s = focusScene('ECO200Y5', { chainTitles: 'direct' })
    expectClean(s, 'ECO200Y5 prerequisites')
    const into = s.routes.paths.filter(path => path.role === 'prereq-direct')
    const trunks = into.filter(path => path.shape === 'trunk')
    expect(trunks.length).toBeGreaterThan(0)
    for (const trunk of trunks) expect(trunk.kind).toBe('coreq')
    const focusBox = s.geometry.nodes[s.focus]
    for (const code of ['ECO101H5', 'ECO102H5']) {
      const path = into.find(candidate => candidate.edge === edgeIndex(topology, code, 'ECO200Y5'))!
      expect(path.shape, code).toBe('edge')
      expect(path.kind).toBe('prereq')
      // No detour into the MAT lane: the path stays within a row or two of the focus row.
      let farthest = 0
      samplePath(path.segments, 2, (_x, y) => {
        farthest = Math.max(farthest, Math.abs(y - focusBox.cy))
        return false
      })
      expect(farthest, code).toBeLessThan(60)
    }
    // Every corequisite branch is dashed (its own kind) and ends at a coreq trunk's merge point.
    const branches = into.filter(path => path.shape === 'branch')
    expect(branches.length).toBeGreaterThanOrEqual(3)
    for (const branch of branches) expect(branch.kind).toBe('coreq')
  })

  it('draws parsed "any one of" groups through a fork junction in front of the focus', () => {
    const s = focusScene('MAT232H5')
    const groups = anyGroupsFor(dataset, topology, s.focus)
    // MAT232H5's prerequisite rule has a parsed `any` group; without it this test would prove nothing.
    expect(groups.length).toBeGreaterThan(0)
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

  it('keeps every route of every course chain and every program clean, contained and on its own runs (full sweep)', () => {
    // Every course as focus (chain titles all and direct, and all with Hide unrelated) and every
    // program (grey dots and Hide unrelated). Exactly 0 fallbacks, no label / dot intrusion, every
    // horizontal run on an endpoint row, a row gap or a lane-padding corridor band (never a lane
    // line, a slim lane, the band header or below the plot), no run shared with an unrelated path
    // and, in wrapped columns, no source's run meeting a target's run and nothing reaching a
    // later-track dot on its row (product rule). Known limit: chains of 170+ highlighted edges in the
    // densest lanes (SOC100H5, PSY100Y5, BIO152H5, ...) exceed the row-gap capacity of their wrapped
    // cells (two 3 px slots per gap, 8.7); those scenes may share runs, and their number, and the
    // number of source / target runs meeting in them, are pinned so they cannot grow unnoticed.
    const DENSE = 170
    const DENSE_SCENES_MAX = 14
    const DENSE_MERGES_MAX = 140
    const problems: string[] = []
    const dense: string[] = []
    let denseMerges = 0
    let scenes = 0
    let paths = 0
    const check = (label: string, input: PresentationInput, focus: number) => {
      const presentation = computePresentation(topology, input)
      const geometry = computeGeometry(topology, presentation, measure, { focusLines: focus >= 0 ? stubFocusLines(topology, focus) : undefined })
      const routes = computeRoutes(topology, presentation, geometry, { anyGroups: focus >= 0 ? anyGroupsFor(dataset, topology, focus) : [] })
      const s: Scene = { topo: topology, presentation, geometry, routes, focus, ms: 0 }
      scenes++
      paths += routes.paths.length
      const found = [
        ...(routes.fallbacks ? [`${routes.fallbacks} fallbacks`] : []),
        ...pathIntrusions(topology, routes.paths, obstacleBoxes(topology, presentation, geometry), focus),
        ...containmentProblems(topology, geometry, routes, focus),
        ...routeProblems(s),
      ]
      const shared = coincidentRuns(topology, routes, focus)
      if (shared.length && routes.paths.length >= DENSE) dense.push(`${label} (${routes.paths.length} paths, ${shared.length} shared runs)`)
      else found.push(...shared)
      const sameColumn = sameColumnProblems(s)
      if (routes.paths.length >= DENSE) denseMerges += sameColumn.length
      else found.push(...sameColumn)
      for (const problem of found.slice(0, 2)) if (problems.length < 30) problems.push(`${label}: ${problem}`)
    }
    for (const node of topology.nodes) {
      check(`${node.code}/all`, presentationInput({ focusId: node.id, chainTitles: 'all' }), node.index)
      check(`${node.code}/direct`, presentationInput({ focusId: node.id, chainTitles: 'direct' }), node.index)
      check(`${node.code}/hide`, presentationInput({ focusId: node.id, hideUnrelated: true }), node.index)
    }
    for (const program of programs) {
      check(`${program.code}/grey`, presentationInput({ programIds: program.ids }), -1)
      check(`${program.code}/hide`, presentationInput({ programIds: program.ids, hideUnrelated: true }), -1)
    }
    console.log(`[graph] sweep: ${scenes} scenes, ${paths} paths; dense scenes sharing runs: ${dense.length ? dense.join(', ') : 'none'}; source / target runs meeting in dense wrapped columns: ${denseMerges}`)
    expect(problems).toEqual([])
    expect(scenes).toBe(3 * topology.nodes.length + 2 * programs.length)
    expect(dense.length).toBeLessThanOrEqual(DENSE_SCENES_MAX)
    expect(denseMerges).toBeLessThanOrEqual(DENSE_MERGES_MAX)
  }, 300_000)

  it('meets the 30 ms budget for <= 400 highlighted edges (and stays deterministic)', () => {
    const rows: Array<[string, Scene]> = ['PSY100Y5', 'STA256H5', 'SOC221H5', 'MAT102H5'].map(code => [code, focusScene(code)])
    let best: { code: string; ids: Set<string>; edges: number } | null = null
    for (const program of programs) {
      const edges = computePresentation(topology, presentationInput({ programIds: program.ids })).edgeRole.filter(role => role === 'program').length
      if (edges <= 400 && (!best || edges > best.edges)) best = { code: program.code, ids: program.ids, edges }
    }
    if (best) rows.push([`program ${best.code}`, scene(presentationInput({ programIds: best.ids }))])
    for (const [name, s] of rows) {
      const edges = s.routes.paths.filter(path => path.edge >= 0).length
      console.log(`[graph] routes (${name}): ${s.ms.toFixed(2)} ms for ${edges} edges / ${s.routes.paths.length} paths, ${s.routes.fallbacks} fallbacks`)
      if (edges <= 400) expect(s.ms).toBeLessThan(30)
      const again = computeRoutes(s.topo, s.presentation, s.geometry, { anyGroups: s.focus >= 0 ? anyGroupsFor(dataset, topology, s.focus) : [] })
      expect(again).toEqual(s.routes)
    }
  })

  it('reads lane padding, row heights and the track gap from the geometry it routes (never desyncs)', () => {
    const options = { lanePaddingY: 20, rowHeight: { full: 48, compact: 26, mini: 8 }, trackGap: 12 }
    for (const [code, chainTitles] of [['CSC148H5', 'all'], ['SOC221H5', 'direct'], ['ANT101H5', 'all']] as const) {
      const s = scene(presentationInput({ focusId: `UTM:${code}`, chainTitles }), topology, undefined, options)
      expect(geometryOptions(s.geometry)).toMatchObject(options)
      // containmentProblems reads the corridor band from geometryOptions: routes built with the
      // defaults (padding 12) would run outside the 20 px padding's band and be reported.
      expectClean(s, `${code} with custom options`)
    }
  })

  it('keeps routed curves 1 px clear of program and "available" rings', () => {
    // A record that makes every program course "available" gives each program dot a double ring
    // (r + 3.5 and r + 6.5, 7.2). Between the endpoint columns (the routed part) no sample may
    // come inside a ring of a node that is not one of the path's own ends.
    let checked = 0
    for (const program of programs.slice(0, 40)) {
      const eligibility = new Map<string, Eligibility>([...program.ids].map(id => [id, 'met']))
      const presentation = computePresentation(topology, presentationInput({ programIds: program.ids, eligibility }))
      const geometry = computeGeometry(topology, presentation, measure)
      const routes = computeRoutes(topology, presentation, geometry, { anyGroups: [] })
      expect(routes.fallbacks, program.code).toBe(0)
      const ringed = geometry.nodes.flatMap((box, v) => (presentation.inProgram[v] && box.cls === 'full' ? [{ v, box, outer: dotRadius('program', 'full') + 6.5 + 0.75 }] : []))
      for (const path of routes.paths) {
        const { from, to } = pathEnds(topology, path, -1)
        const x0 = geometry.columns[topology.nodes[from].col].x + geometry.columns[topology.nodes[from].col].w
        const x1 = geometry.columns[topology.nodes[to].col].x
        samplePath(path.segments, 1, (x, y) => {
          if (x <= x0 || x >= x1) return false
          checked++
          for (const { v, box, outer } of ringed) {
            if (v === from || v === to) continue
            if (Math.hypot(x - box.cx, y - box.cy) < outer + 1 - 1e-6) {
              throw new Error(`${program.code}: ${pathName(topology, path)} passes inside ${topology.nodes[v].code}'s ring at ${x.toFixed(1)},${y.toFixed(1)}`)
            }
          }
          return false
        })
      }
    }
    expect(checked).toBeGreaterThan(1000)
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
    // k = clamp(0.45 · dx, 16, 240), kept below dx so the short hop out of the plate never folds back.
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
    // A source in the first track leaves through a row gap: some segment ends half a (full, 40 px)
    // row off its cy, or 1.5 px nearer where the gap band leaves room for both neighbours' runs.
    const v = index(topo, middle[0])
    const path = out.routes.paths.find(candidate => candidate.edge >= 0 && topo.edges[candidate.edge].from === v)!
    const box = out.geometry.nodes[v]
    expect(box.track).toBe(0)
    expect(path.segments.some(segment => [20, 18.5, 21.5].some(off => Math.abs(Math.abs(segment.y - box.cy) - off) < 1e-6))).toBe(true)
  })

  it('never lets a wrapped cell look linked inside itself: steps right after the source label, hooks into later-track dots (product rule)', () => {
    // Two tracks of full rows: every AAA2xx course hangs off AAA101 and unlocks AAA301.
    const middle = Array.from({ length: 30 }, (_, i) => `AAA2${String(i + 10)}H5`)
    const topo = synthetic([{ code: 'AAA101H5' }, ...middle.map(code => ({ code, prereq: ['AAA101H5'] })), { code: 'AAA301H5', prereq: middle }])
    const into = scene(presentationInput({ focusId: 'UTM:AAA101H5', chainTitles: 'direct', depth: 'direct' }), topo, [])
    const out = scene(presentationInput({ focusId: 'UTM:AAA301H5', chainTitles: 'direct', depth: 'direct' }), topo, [])
    const column = into.geometry.columns[topo.nodes[index(topo, middle[0])].col]
    expect(column.tracks).toBe(2)
    let hooks = 0
    for (const path of into.routes.paths) {
      if (path.edge < 0) continue
      const to = topo.edges[path.edge].to
      const box = into.geometry.nodes[to]
      if (box.track === 0) continue
      hooks++
      // Ends straight above or below the dot (cx, cy -/+ (r + 1)), arriving vertically.
      const segs = path.segments
      const end = lastPoint(segs)
      expect(end.x).toBeCloseTo(box.cx, 9)
      expect(Math.abs(end.y - box.cy)).toBeCloseTo(dotRadius(into.presentation.role[to], box.cls) + 1, 9)
      expect(segs[segs.length - 2].x).toBeCloseTo(box.cx, 9)
    }
    expect(hooks).toBeGreaterThan(10)
    // Sources in the first track step into their gap right after their own label, at least 8 px
    // before the next track's dot column.
    let steps = 0
    for (const path of out.routes.paths) {
      if (path.edge < 0) continue
      const from = topo.edges[path.edge].from
      const box = out.geometry.nodes[from]
      if (box.track > 0) continue
      steps++
      const [start, step] = path.segments
      expect(start).toMatchObject({ op: 'M', x: box.x + box.w + 4, y: box.cy })
      expect(step.op).toBe('C')
      const nextDot = column.x + column.trackW + 8 + 8 - 5
      expect(step.x).toBeLessThanOrEqual(nextDot - 8 + 1e-6)
      expect(Math.abs(step.y - box.cy)).toBeGreaterThan(15)
    }
    expect(steps).toBeGreaterThan(10)
    expect(sameColumnProblems(into)).toEqual([])
    expect(sameColumnProblems(out)).toEqual([])
    // Not vacuous: the anchors of the previous round S-stepped from the gap into the row in the
    // 14 px before a later track's dot, which the check reports.
    const later = into.routes.paths.filter(path => path.edge >= 0 && into.geometry.nodes[topo.edges[path.edge].to].track > 0)
    const target = into.geometry.nodes[topo.edges[later[0].edge].to]
    const xIn = column.x + column.trackW + 8 - 2
    const oldTail: PathSegment[] = [
      { op: 'M', x: xIn - 14, y: target.cy - 18.5 },
      { op: 'C', x1: xIn - 7, y1: target.cy - 18.5, x2: xIn - 7, y2: target.cy, x: xIn, y: target.cy },
    ]
    expect(laterTrackReaches(topo, into.geometry, [{ edge: later[1].edge, segments: oldTail }]).length).toBeGreaterThan(0)
  })

  it('bundles a prerequisite fan of >= 6 into branches, a merge point and a trunk that ends in the focus row (mirrored 8.9)', () => {
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
    // The trunk runs on to the focus dot (cx − r − 1), like every edge entering the focus.
    expect(lastPoint(trunks[0].segments)).toEqual({ x: focusBox.cx - dotRadius('focus', 'full') - 1, y: focusBox.cy })
    expectClean(s, 'prereq fan')
  })

  it('curves staggered prerequisite trunk ends into the focus row before the entry (finding 4)', () => {
    // Two groups of four direct prerequisites in two columns (100 and 200 level) of a 400-level
    // focus (an unrelated 300-level course keeps a column between): two trunks whose ends are
    // staggered ± 1.5 px around the focus row.
    const low = Array.from({ length: 4 }, (_, i) => `AAA1${String(i + 10)}H5`)
    const high = Array.from({ length: 4 }, (_, i) => `AAA2${String(i + 10)}H5`)
    const topo = synthetic([
      ...low.map(code => ({ code })), ...high.map(code => ({ code })), { code: 'AAA301H5' }, { code: 'AAA401H5', prereq: [...low, ...high] },
    ])
    const s = scene(presentationInput({ focusId: 'UTM:AAA401H5' }), topo, [])
    const trunks = s.routes.paths.filter(path => path.shape === 'trunk')
    expect(trunks).toHaveLength(2)
    const focusBox = s.geometry.nodes[s.focus]
    const xIn = s.geometry.columns[topo.nodes[s.focus].col].x - 2
    const ends = trunks.map(trunk => {
      const segs = trunk.segments
      expect(lastPoint(segs)).toEqual({ x: focusBox.cx - dotRadius('focus', 'full') - 1, y: focusBox.cy })
      // The S-step into the row ends at the entry, on the focus row, from the staggered height.
      const step = segs[segs.length - 2]
      expect(step).toMatchObject({ op: 'C', x: xIn, y: focusBox.cy })
      return segs[segs.length - 3].y - focusBox.cy
    })
    expect(ends.map(offset => Math.abs(offset))).toEqual([1.5, 1.5])
    expect(Math.sign(ends[0])).not.toBe(Math.sign(ends[1]))
    expectClean(s, 'staggered trunks')
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

  it('gives program courses outside a selected chain the compact 3.75 radius (7.1, 7.3)', () => {
    expect(dotRadius('program', 'compact')).toBe(3.75)
    expect(dotRadius('none', 'compact')).toBe(3.75)
    expect(dotRadius('program', 'full')).toBe(4.25)
    expect(dotRadius('prereq', 'compact')).toBe(4.25)
  })
})

// ---------------------------------------------------------------------------

describe('plain anchored curves for faint edges, stubs and hover previews (8.7, 8.10)', () => {

  it.each([false, true])('keeps every faint edge out of its own columns (Titles %s): wrapped sources step into the row gap first', titles => {
    const presentation = computePresentation(topology, presentationInput({ titles }))
    const geometry = computeGeometry(topology, presentation, measure)
    const faint = topology.edges.map((_, e) => e).filter(e => presentation.edgeRole[e] === 'faint')
    const paths = plainEdgePaths(topology, geometry, faint, { presentation })
    // Label and dot boxes of the labelled nodes, per column.
    const byColumn = new Map<number, ReturnType<typeof obstacleBoxes>>()
    for (const box of obstacleBoxes(topology, presentation, geometry)) {
      const col = topology.nodes[box.owner].col
      byColumn.set(col, [...byColumn.get(col) ?? [], box])
    }
    let wrappedSources = 0
    let wrappedTargets = 0
    const problems: string[] = []
    faint.forEach((e, k) => {
      const { from, to } = topology.edges[e]
      const source = geometry.nodes[from]
      const target = geometry.nodes[to]
      const lastTrack = Math.max(...topology.cells[topology.nodes[from].lane][topology.nodes[from].col].map(v => geometry.nodes[v].track))
      const checks: Array<[number, number]> = []
      if (source.track < lastTrack) {
        wrappedSources++
        checks.push([topology.nodes[from].col, from])
      }
      if (target.track > 0) {
        wrappedTargets++
        checks.push([topology.nodes[to].col, to])
      }
      for (const [col, except] of checks) {
        const boxes = (byColumn.get(col) ?? []).filter(box => box.owner !== except)
        samplePath(paths[k], 1, (x, y) => {
          const box = boxes.find(b => x > b.x0 && x < b.x1 && y > b.y0 && y < b.y1)
          if (box && problems.length < 10) problems.push(`${topology.nodes[from].code}>${topology.nodes[to].code} crosses ${box.what}`)
          return Boolean(box)
        })
      }
    })
    expect(wrappedSources).toBeGreaterThan(50)
    expect(wrappedTargets).toBeGreaterThan(50)
    expect(problems).toEqual([])
    // Product rule: with the faint picture's row gaps planned together (as the renderer draws it),
    // no source's gap run meets a target's run and nothing reaches a later-track dot on its row; the
    // few anchors of dense cells without a free slot are cut at the column edge instead.
    let cuts = 0
    const drawn = plainEdgePaths(topology, geometry, faint, { presentation, truncateUnplaced: true, onTruncate: () => cuts++ })
    const drawnPaths = drawn.map((segments, k) => ({ edge: faint[k], segments }))
    expect(wrappedMerges(topology, geometry, drawnPaths)).toEqual([])
    expect(laterTrackReaches(topology, geometry, drawnPaths)).toEqual([])
    expect(cuts).toBeLessThan(0.01 * faint.length)
    // Not vacuous: drawn without the plan (every anchor on the side facing its far end), sources'
    // and targets' runs do meet.
    const unplanned = faint.map(e => ({ edge: e, segments: plainEdgePaths(topology, geometry, [e], { presentation })[0] }))
    expect(wrappedMerges(topology, geometry, unplanned).length).toBeGreaterThan(0)
  }, 60_000)

  it('starts faint paths at the out-port and keeps the older argument order (with leader) working', () => {
    const s = focusScene('CSC148H5')
    const edges = topology.edges.map((_, e) => e).filter(e => s.presentation.edgeRole[e] === 'unlock-direct')
    const plain = plainEdgePaths(topology, s.geometry, edges, { presentation: s.presentation })
    const legacy = plainEdgePaths(topology, s.presentation, s.geometry, edges)
    expect(plain).toHaveLength(edges.length)
    expect(legacy).toHaveLength(edges.length)
    const focusBox = s.geometry.nodes[s.focus]
    const column = s.geometry.columns[topology.nodes[s.focus].col]
    for (let k = 0; k < edges.length; k++) {
      expect(plain[k][0]).toEqual({ op: 'M', x: Math.max(column.x + column.trackW - 2, focusBox.x + focusBox.w + 2), y: focusBox.cy })
      expect(legacy[k][0]).toEqual({ op: 'M', x: focusBox.x + focusBox.w + 4, y: focusBox.cy })
      // Same entry: the curve ends at the same point and the run to the dot is identical.
      const [curveA, runA] = plain[k].slice(-2)
      const [curveB, runB] = legacy[k].slice(-2)
      expect([curveA.x, curveA.y]).toEqual([curveB.x, curveB.y])
      expect(runA).toEqual(runB)
    }
  })

  it('splits long overview edges into stubs on the same anchors', () => {
    const presentation = computePresentation(topology, presentationInput())
    const geometry = computeGeometry(topology, presentation, measure)
    const faint = topology.edges.map((_, e) => e).filter(e => presentation.edgeRole[e] === 'faint').slice(0, 400)
    const paths = plainEdgePaths(topology, geometry, faint)
    const stubs = plainEdgeStubs(topology, geometry, faint)
    faint.forEach((_, k) => {
      const { source, target } = stubs[k]
      const path = paths[k]
      // Source stub: the path's own start up to the out-port, then 14 px on.
      const head = source.slice(0, -1)
      expect(path.slice(0, head.length)).toEqual(head)
      const out = head[head.length - 1]
      expect(lastPoint(source)).toEqual({ x: out.x + 14, y: out.y })
      // Target stub: 10 px before the entry, then the path's own approach to the dot.
      const tail = target.slice(2)
      expect(path.slice(path.length - tail.length)).toEqual(tail)
      expect(target[1].x - target[0].x).toBe(10)
      expect(target[0].y).toBe(target[1].y)
    })
  })
})
