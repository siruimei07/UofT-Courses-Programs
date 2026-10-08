import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildTopology, classifyOverviewEdge, computeGeometry, computePresentation, computeRoutes, dotRadius, geometryOptions, INNER_CLEAR, innerTrackEnds,
  isLongOverviewEdge, plainEdgeBlocked, plainEdgePaths, plainEdgeStubs, routedEdgePaths, samplePath, STUB_TERMINAL,
} from '../src/graph'
import type {
  EdgeRole, Eligibility, Geometry, OverviewEdgeForm, PathSegment, Presentation, PresentationInput, RoutedPath, Routes, Topology,
} from '../src/graph'
import { loadGraphDataset, presentationInput, syntheticDataset } from './helpers/dataset'
import {
  anyGroupsFor, bestOf, coincidentRuns, containmentProblems, facingStubs, lastPoint, laterTrackReaches, obstacleBoxes, otherTrackCrossings, pathEnds,
  pathIntrusions, stubFocusLines, stubMeasure, wrappedMerges,
} from './helpers/graph'
import { budget } from './helpers/perf'

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

  it('never merges corequisites into a prerequisite bundle (ECO200Y5, 7.4 / 8.9)', () => {
    // ECO200Y5: ECO101H5 and ECO102H5 are prerequisites on the focus row; MAT133Y5 / MAT135H5 /
    // MAT137H5 (and MAT136H5 / MAT139H5) are "1 of 5" corequisites in the MAT lane above. Merged,
    // their dashed branches met in a dashed bracket along the MAT column's exits, which read as those
    // courses being corequisites of each other (visual QA): each is drawn as its own dashed edge.
    const s = focusScene('ECO200Y5', { chainTitles: 'direct' })
    expectClean(s, 'ECO200Y5 prerequisites')
    const into = s.routes.paths.filter(path => path.role === 'prereq-direct')
    expect(into.filter(path => path.shape === 'trunk' || path.shape === 'branch')).toEqual([])
    const coreqs = into.filter(path => path.kind === 'coreq')
    expect(coreqs.length).toBeGreaterThanOrEqual(3)
    for (const path of coreqs) expect(path.shape).toBe('edge')
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
  })

  it('keeps routed paths clear of other courses\' exits and entries where it can (port zones, visual QA)', () => {
    // A path running past the end of another course's leader, or the start of its entry, reads as
    // joining that course's own edge there: a vertical run down a column's exits read as a bracket
    // linking its courses (CSC148H5: CSC207H5 → LIN447H5 past CSC258H5 and CSC236H5).
    const passes = (s: Scene) => {
      const out: string[] = []
      const ports = new Map<number, Array<{ x0: number; x1: number; y: number }>>()
      const add = (v: number, x0: number, x1: number, y: number) => ports.set(v, [...(ports.get(v) ?? []), { x0, x1, y }])
      for (const path of s.routes.paths) {
        if (path.edge < 0) continue
        const { from, to } = topology.edges[path.edge]
        const a = s.geometry.nodes[from]
        const column = s.geometry.columns[topology.nodes[from].col]
        const colOut = column.x + column.w - 2
        if (path.shape !== 'branch' || to === s.focus) add(from, colOut - 2, colOut + 5, a.cy)
        const b = s.geometry.nodes[to]
        if (path.shape !== 'branch' || from === s.focus) add(to, s.geometry.columns[topology.nodes[to].col].x - 2 - 5, b.cx - 6, b.cy)
      }
      for (const path of s.routes.paths) {
        const { from, to } = pathEnds(topology, path, s.focus)
        const members = path.shape === 'branch' ? s.routes.paths.filter(other => other.shape === 'branch').map(other => pathEnds(topology, other, s.focus)) : []
        samplePath(path.segments, 0.5, (x, y) => {
          for (const [v, zones] of ports) {
            if (v === from || v === to || v === s.focus || members.some(m => m.from === v || m.to === v)) continue
            if (zones.some(z => x > z.x0 && x < z.x1 && Math.abs(y - z.y) < 1.5)) {
              out.push(`${pathName(topology, path)} passes ${topology.nodes[v].code}'s port at ${x.toFixed(1)},${y.toFixed(1)}`)
              return true
            }
          }
          return false
        })
      }
      return out
    }
    for (const [code, input] of [
      ['CSC148H5', { chainTitles: 'all' }], ['CSC148H5', { chainTitles: 'direct' }], ['CSC148H5', { hideUnrelated: true }],
      ['MAT232H5', { chainTitles: 'all' }], ['ECO200Y5', { chainTitles: 'direct' }],
    ] as const) {
      expect(passes(focusScene(code, input)), `${code} ${JSON.stringify(input)}`).toEqual([])
    }
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

  it('keeps every route of every course chain and every program clean, unwrapped, contained and on its own runs (full sweep)', () => {
    // Every course as focus (chain titles all and direct, and all with Hide unrelated) and every
    // program (grey dots and Hide unrelated). While a course or program is selected nothing wraps
    // (owner decision 19.10): no labelled node in a track > 0. Exactly 0 fallbacks, no label / dot
    // intrusion, every horizontal run on an endpoint row, a row gap or a lane-padding corridor band
    // (never a lane line, a slim lane, the band header or below the plot), no run shared with an
    // unrelated path and no source / target runs meeting in one column (product rule). No known
    // limits remain: the dense-scene pins existed only because wrapped chain cells had two 3 px
    // row-gap slots per gap; the tallest unwrapped chain cell (SOC100H5 "direct", 65 rows in the SOC
    // 300-level cell) routes cleanly too.
    const problems: string[] = []
    let scenes = 0
    let dimmed = 0
    let paths = 0
    let shared = 0
    let meeting = 0
    const check = (label: string, input: PresentationInput, focus: number) => {
      const presentation = computePresentation(topology, input)
      const geometry = computeGeometry(topology, presentation, measure, { focusLines: focus >= 0 ? stubFocusLines(topology, focus) : undefined })
      const routes = computeRoutes(topology, presentation, geometry, { anyGroups: focus >= 0 ? anyGroupsFor(dataset, topology, focus) : [] })
      const s: Scene = { topo: topology, presentation, geometry, routes, focus, ms: 0 }
      scenes++
      paths += routes.paths.length
      const wrapped = presentation.dimming ? geometry.nodes.filter(box => (box.cls === 'full' || box.cls === 'compact') && box.track > 0).length : 0
      if (presentation.dimming) dimmed++
      const sharedRuns = coincidentRuns(topology, routes, focus)
      const sameColumn = sameColumnProblems(s)
      shared += sharedRuns.length
      meeting += sameColumn.length
      const found = [
        ...(wrapped ? [`${wrapped} labelled nodes wrapped while dimming`] : []),
        ...(routes.fallbacks ? [`${routes.fallbacks} fallbacks`] : []),
        ...pathIntrusions(topology, routes.paths, obstacleBoxes(topology, presentation, geometry), focus),
        ...containmentProblems(topology, geometry, routes, focus),
        ...routeProblems(s),
        ...sharedRuns,
        ...sameColumn,
      ]
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
    console.log(`[graph] sweep: ${scenes} scenes (${dimmed} dimming), ${paths} paths; shared runs ${shared}, source / target runs meeting in one column ${meeting}`)
    expect(problems).toEqual([])
    expect([shared, meeting]).toEqual([0, 0])
    expect(scenes).toBe(3 * topology.nodes.length + 2 * programs.length)
    // Every scene dims except programs without a course on this campus (they leave the overview as is).
    expect(dimmed).toBe(3 * topology.nodes.length + 2 * programs.filter(program => program.ids.size > 0).length)
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
      if (edges <= 400) expect(s.ms).toBeLessThan(budget(30))
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

  it('never wraps a tall chain cell while dimming: every routed edge enters its dot on its row (owner decision 19.10)', () => {
    // 30 AAA2xx courses in one cell: each hangs off AAA101 and unlocks AAA301. The overview wraps the
    // cell (30 compact rows = 660 px > 440); a selection or a program never does.
    const middle = Array.from({ length: 30 }, (_, i) => `AAA2${String(i + 10)}H5`)
    const topo = synthetic([{ code: 'AAA101H5' }, ...middle.map(code => ({ code, prereq: ['AAA101H5'] })), { code: 'AAA301H5', prereq: middle }])
    const col = topo.nodes[index(topo, middle[0])].col
    const overview = computeGeometry(topo, computePresentation(topo, presentationInput()), stubMeasure(topo))
    expect(overview.columns[col].tracks).toBe(2)
    const inputs: Array<[string, PresentationInput]> = [
      ['into, all', presentationInput({ focusId: 'UTM:AAA101H5', depth: 'direct' })],
      ['into, direct', presentationInput({ focusId: 'UTM:AAA101H5', chainTitles: 'direct', depth: 'direct' })],
      ['out of, direct', presentationInput({ focusId: 'UTM:AAA301H5', chainTitles: 'direct', depth: 'direct' })],
      ['through, all', presentationInput({ focusId: `UTM:${middle[17]}` })],
      ['program', presentationInput({ programIds: new Set(topo.nodes.map(n => n.id)) })],
    ]
    for (const [label, input] of inputs) {
      const s = scene(input, topo, [])
      expect(s.geometry.columns[col].tracks, label).toBe(1)
      expect(s.geometry.nodes.every(box => box.track === 0), label).toBe(true)
      // The tall cell makes a tall lane (8.5) instead.
      const rows = topo.cells[0][col].map(v => s.geometry.nodes[v]).filter(box => box.cls === 'full' || box.cls === 'compact')
      expect(s.geometry.lanes[0].h, label).toBeGreaterThanOrEqual(24 + rows.reduce((sum, box) => sum + (box.cls === 'full' ? 40 : 22), 0) - 1e-6)
      expectClean(s, label)
      let entries = 0
      for (const path of s.routes.paths) {
        // A prerequisite trunk carries its branches into the focus; branches end at its merge point.
        const prerequisiteTrunk = path.shape === 'trunk' && path.role === 'prereq-direct'
        if ((path.edge < 0 && !prerequisiteTrunk) || (path.shape === 'branch' && topo.edges[path.edge].to === s.focus)) continue
        const to = prerequisiteTrunk ? s.focus : topo.edges[path.edge].to
        const box = s.geometry.nodes[to]
        const end = lastPoint(path.segments)
        entries++
        expect(end.y, `${label} ${pathName(topo, path)}`).toBeCloseTo(box.cy, 9)
        expect(end.x).toBeLessThan(box.cx)
      }
      expect(entries, label).toBeGreaterThan(0)
    }
  })

  it('keeps the wrapped-track anchors for hover previews: a row-gap step right after the source label, a hook into a later-track dot (8.7)', () => {
    // The overview with titles wraps the 30 full rows (1200 px > 720) into two tracks. Hovering
    // AAA101H5 or AAA301H5 previews every edge in full on the same anchors as before 19.11.
    const middle = Array.from({ length: 30 }, (_, i) => `AAA2${String(i + 10)}H5`)
    const topo = synthetic([{ code: 'AAA101H5' }, ...middle.map(code => ({ code, prereq: ['AAA101H5'] })), { code: 'AAA301H5', prereq: middle }])
    const presentation = computePresentation(topo, presentationInput({ titles: true }))
    const geometry = computeGeometry(topo, presentation, stubMeasure(topo))
    const column = geometry.columns[topo.nodes[index(topo, middle[0])].col]
    expect(column.tracks).toBe(2)
    const hover = (code: string) => {
      const v = index(topo, code)
      const list = topo.edges.map((_, e) => e).filter(e => topo.edges[e].from === v || topo.edges[e].to === v)
      const paths = plainEdgePaths(topo, geometry, list, { presentation, leader: true })
      return list.map((edge, k): RoutedPath => ({ edge, role: 'faint', kind: 'prereq', shape: 'edge', segments: paths[k] }))
    }
    const into = hover('AAA101H5')
    const out = hover('AAA301H5')
    let hooks = 0
    for (const path of into) {
      const to = topo.edges[path.edge].to
      const box = geometry.nodes[to]
      if (box.track === 0) continue
      hooks++
      // Ends straight above or below the dot (cx, cy -/+ (r + 1)), arriving vertically.
      const segs = path.segments
      const end = lastPoint(segs)
      expect(end.x).toBeCloseTo(box.cx, 9)
      expect(Math.abs(end.y - box.cy)).toBeCloseTo(dotRadius('none', box.cls) + 1, 9)
      expect(segs[segs.length - 2].x).toBeCloseTo(box.cx, 9)
    }
    expect(hooks).toBeGreaterThan(10)
    // Sources in the first track step into their gap right after their own label, at least 8 px
    // before the next track's dot column.
    let steps = 0
    for (const path of out) {
      const from = topo.edges[path.edge].from
      const box = geometry.nodes[from]
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
    for (const paths of [into, out]) {
      expect(pathIntrusions(topo, paths, obstacleBoxes(topo, presentation, geometry), -1)).toEqual([])
      expect(wrappedMerges(topo, geometry, paths)).toEqual([])
      expect(laterTrackReaches(topo, geometry, paths)).toEqual([])
    }
    // Not vacuous: the anchors of an earlier round S-stepped from the gap into the row in the 14 px
    // before a later track's dot, which the check reports.
    const later = into.filter(path => geometry.nodes[topo.edges[path.edge].to].track > 0)
    const target = geometry.nodes[topo.edges[later[0].edge].to]
    const xIn = column.x + column.trackW + 8 - 2
    const oldTail: PathSegment[] = [
      { op: 'M', x: xIn - 14, y: target.cy - 18.5 },
      { op: 'C', x1: xIn - 7, y1: target.cy - 18.5, x2: xIn - 7, y2: target.cy, x: xIn, y: target.cy },
    ]
    expect(laterTrackReaches(topo, geometry, [{ edge: later[1].edge, segments: oldTail }]).length).toBeGreaterThan(0)
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

describe('the overview picture: full faint edges, long-edge stubs and inner-track stubs (8.7, 8.10, owner decision 19.11)', () => {
  const synthetic = (courses: Parameters<typeof syntheticDataset>[0]) => buildTopology(syntheticDataset(courses))

  /**
   * Faint overview edges by form, drawn as the renderer draws them: one plan (`planWith`) for the whole
   * picture; a 'full' edge whose plain curve passes a course it does not connect (plainEdgeBlocked) is
   * drawn as stubs, or routed around labels and dots with Show all connections.
   */
  function overviewPicture(input: Partial<PresentationInput>, topo = topology) {
    const presentation = computePresentation(topo, presentationInput(input))
    const geometry = computeGeometry(topo, presentation, stubMeasure(topo))
    const visible = (v: number) => presentation.cls[v] !== 'hidden'
    const faint = topo.edges.map((_, e) => e).filter(e => presentation.edgeRole[e] === 'faint' && visible(topo.edges[e].from) && visible(topo.edges[e].to))
    const forms = new Map<OverviewEdgeForm, number[]>([['full', []], ['long-stub', []], ['inner-stub', []]])
    for (const e of faint) forms.get(classifyOverviewEdge(topo, geometry, e, { longStubs: !input.showAllEdges }))!.push(e)
    const options = { presentation, planWith: faint }
    const blocked = plainEdgeBlocked(topo, geometry, forms.get('full')!, options)
    const through = forms.get('full')!.filter((_, k) => blocked[k])
    const plain = forms.get('full')!.filter((_, k) => !blocked[k])
    const routed = input.showAllEdges ? through : []
    const full = [...plain, ...routed]
    const stubbed = [...forms.get('long-stub')!, ...forms.get('inner-stub')!, ...(input.showAllEdges ? [] : through)]
    let cuts = 0
    const paths = [
      ...plainEdgePaths(topo, geometry, plain, { ...options, truncateUnplaced: true, onTruncate: () => cuts++ }),
      ...routedEdgePaths(topo, geometry, routed, options),
    ]
    const stubs = plainEdgeStubs(topo, geometry, stubbed, options)
    return { presentation, geometry, faint, forms, full, stubbed, paths, stubs, cuts, through }
  }

  /** The labelled node `dt` tracks to the right of v, `dy` px below its row (same lane and column), or -1. */
  const rowNeighbour = (topo: Topology, geometry: Geometry, v: number, dt: number, dy = 0) => {
    const { lane, col } = topo.nodes[v]
    return topo.cells[lane][col].find(u => geometry.nodes[u].track === geometry.nodes[v].track + dt && Math.abs(geometry.nodes[u].cy - geometry.nodes[v].cy - dy) < 1e-6
      && (geometry.nodes[u].cls === 'full' || geometry.nodes[u].cls === 'compact')) ?? -1
  }

  it.each([[false, false], [false, true], [true, false], [true, true]] as const)(
    'never draws a faint edge or stub across another track of its column, or one that seems to link two of its courses (Titles %s, Show all %s)', (titles, showAllEdges) => {
      const { presentation, geometry, faint, forms, full, stubbed, paths, stubs, cuts, through } = overviewPicture({ titles, showAllEdges })
      const opt = geometryOptions(geometry)
      // A full path never has an end inside a wrapped cell's inner tracks, so none is ever cut at an
      // unplaced row-gap anchor; Show all connections only turns long stubs into full edges.
      expect(cuts).toBe(0)
      for (const e of full) expect(innerTrackEnds(topology, geometry, e)).toEqual({ source: false, target: false })
      if (showAllEdges) expect(forms.get('long-stub')).toEqual([])
      const drawn = [
        ...full.map((edge, k) => ({ edge, segments: paths[k] })),
        ...stubbed.flatMap((edge, k) => [{ edge, segments: stubs[k].source }, { edge, segments: stubs[k].target }]),
      ]
      // 1. Nothing drawn lies in another track of an end's column at the row of a node of that track.
      expect(otherTrackCrossings(topology, geometry, drawn)).toEqual([])
      // 1b. No full edge passes a label or the dot of a course it does not connect (visual QA: a
      //     same-row edge skipping a column ran through every course on its row).
      const asPaths = full.map((edge, k): RoutedPath => ({ edge, role: 'faint', kind: topology.edges[edge].kind, shape: 'edge', segments: paths[k] }))
      expect(pathIntrusions(topology, asPaths, obstacleBoxes(topology, presentation, geometry), -1)).toEqual([])
      expect(through.length).toBeGreaterThan(300)

      // 2. Every stub half has its form. Outer ends: the long-edge stub (14 px past the out-port, 10 px
      //    before the entry). Inner targets: a hook from the row gap next to their row (never along
      //    their row from the previous track's label), one per row gap of a track. Inner sources:
      //    straight along their row, and only where nothing in the next track faces them.
      const problems: string[] = []
      const report = (ok: boolean, message: () => string) => {
        if (!ok && problems.length < 20) problems.push(message())
      }
      const halves: Array<{ v: number; segments: PathSegment[] }> = []
      const sources = new Set<number>()
      const drawnSources = new Set<number>()
      const targets = new Set<number>()
      const hooks = new Map<string, number>()
      stubbed.forEach((e, k) => {
        const { from, to } = topology.edges[e]
        const name = `${topology.nodes[from].code}>${topology.nodes[to].code}`
        const ends = innerTrackEnds(topology, geometry, e)
        const { source, target } = stubs[k]
        const a = geometry.nodes[from]
        const b = geometry.nodes[to]
        if (ends.source) {
          sources.add(from)
          if (source.length) {
            drawnSources.add(from)
            const column = geometry.columns[topology.nodes[from].col]
            const nextLeft = column.x + (a.track + 1) * (column.trackW + opt.trackGap)
            report(rowNeighbour(topology, geometry, from, 1) < 0, () => `${name}: inner source stub faces a course of the next track`)
            const length = source[source.length - 1].x - source[0].x
            report(source.length === 2 && source.every(s => s.y === a.cy) && source[0].x >= a.x + a.w, () => `${name}: inner source stub ${JSON.stringify(source)}`)
            report(length >= 4 - 1e-9 && length <= 14 + 1e-9, () => `${name}: inner source stub of ${length} px`)
            // Its terminal dot keeps INNER_CLEAR px from the next track's dot (largest radius 5).
            report(source[1].x + STUB_TERMINAL + INNER_CLEAR <= nextLeft + opt.dotInset - 5 + 1e-9, () => `${name}: inner source stub reaches for the next track's dot`)
            halves.push({ v: from, segments: source })
          }
        } else {
          const [stubStart, end] = source.slice(-2)
          report(end.y === a.cy && stubStart.y === a.cy && Math.abs(end.x - stubStart.x - 14) < 1e-9, () => `${name}: source stub ${JSON.stringify(source)}`)
        }
        if (ends.target) {
          targets.add(to)
          if (!target.length) return
          const column = geometry.columns[topology.nodes[to].col]
          const trackLeft = column.x + b.track * (column.trackW + opt.trackGap)
          const r = dotRadius(presentation.role[to], b.cls)
          const start = target[0]
          const end = lastPoint(target)
          // Starts in the track gap before its track, in a row gap next to its row, and ends on top of
          // (or under) its dot; no point of it lies on its row.
          report(start.x > trackLeft - opt.trackGap && start.x < trackLeft, () => `${name}: inner target stub starts outside the track gap at ${start.x}`)
          report(Math.abs(end.x - b.cx) < 1e-9 && Math.abs(Math.abs(end.y - b.cy) - (r + 1)) < 1e-9, () => `${name}: inner target stub ends at ${JSON.stringify(end)}`)
          samplePath(target, 0.5, (_x, y) => {
            const on = Math.abs(y - b.cy) < r + 1 - 1e-6
            report(!on, () => `${name}: inner target stub runs on its row`)
            return on
          })
          const key = `${topology.nodes[to].lane}|${topology.nodes[to].col}|${b.track}|${Math.round(start.y)}`
          const owner = hooks.get(key)
          report(owner === undefined || owner === to, () => `${name}: two inner target stubs share the row gap at y=${start.y}`)
          hooks.set(key, to)
        } else {
          report(target[0].y === b.cy && target[1].y === b.cy && Math.abs(target[1].x - target[0].x - 10) < 1e-9, () => `${name}: target stub ${JSON.stringify(target)}`)
        }
      })
      expect(problems).toEqual([])
      // 3. Straight stubs of different courses on one row of a column never face each other.
      expect(facingStubs(topology, halves, INNER_CLEAR, STUB_TERMINAL)).toEqual([])
      const inner = forms.get('inner-stub')!
      console.log(`[graph] overview (titles ${titles}, show all ${showAllEdges}): ${full.length} full (${showAllEdges ? through.length : 0} routed), `
        + `${forms.get('long-stub')!.length} long-stub, ${showAllEdges ? 0 : through.length} through other courses as stubs, ${inner.length} inner-stub edges; `
        + `${sources.size} inner sources (${drawnSources.size} with a stub), ${targets.size} inner targets (${new Set(hooks.values()).size} hooks)`)
      expect(inner.length).toBeGreaterThan(1000)
      expect(sources.size).toBeGreaterThan(100)
      expect(targets.size).toBeGreaterThan(300)
      expect(new Set(hooks.values()).size).toBeGreaterThan(300)
      // Not vacuous: drawn in full (the faint form before 19.11: row-gap runs out of inner tracks and
      // into later ones), nearly every inner-stub edge crosses another track of its column.
      const before = plainEdgePaths(topology, geometry, inner, { presentation, planWith: faint })
      expect(otherTrackCrossings(topology, geometry, inner.map((edge, k) => ({ edge, segments: before[k] })), Infinity).length).toBeGreaterThan(0.9 * inner.length)
    }, 60_000)

  it('classifies overview edges and builds the inner-track stub forms exactly (synthetic wrapped cell)', () => {
    // 29 AAA2xx courses in one cell: each hangs off AAA101 and unlocks AAA301. The overview wraps them
    // into two tracks of compact rows, the first one row longer. AAA101 also unlocks DDD201, three
    // visible lanes down.
    const middle = Array.from({ length: 29 }, (_, i) => `AAA2${String(i + 10)}H5`)
    const topo = synthetic([
      { code: 'AAA101H5' }, ...middle.map(code => ({ code, prereq: ['AAA101H5'] })), { code: 'AAA301H5', prereq: middle },
      { code: 'BBB101H5' }, { code: 'CCC101H5' }, { code: 'DDD201H5', prereq: ['AAA101H5'] },
    ])
    const presentation = computePresentation(topo, presentationInput())
    const geometry = computeGeometry(topo, presentation, stubMeasure(topo))
    const opt = geometryOptions(geometry)
    const column = geometry.columns[topo.nodes[index(topo, middle[0])].col]
    expect(column.tracks).toBe(2)
    const box = (code: string) => geometry.nodes[index(topo, code)]
    const e = (from: string, to: string) => edgeIndex(topo, from, to)
    const first = middle.filter(code => box(code).track === 0)
    const second = middle.filter(code => box(code).track === 1)
    expect(first.length).toBe(second.length + 1)
    // a0 / b0: row 0 of each track; aLast: the last row of the first track, with nothing beside it.
    const [a0, b0, aLast, bLast] = [first[0], second[0], first[first.length - 1], second[second.length - 1]]
    expect(box(b0).cy).toBe(box(a0).cy)

    expect(classifyOverviewEdge(topo, geometry, e('AAA101H5', a0))).toBe('full')
    expect(classifyOverviewEdge(topo, geometry, e(bLast, 'AAA301H5'))).toBe('full')
    expect(innerTrackEnds(topo, geometry, e('AAA101H5', b0))).toEqual({ source: false, target: true })
    expect(innerTrackEnds(topo, geometry, e(a0, 'AAA301H5'))).toEqual({ source: true, target: false })
    for (const longStubs of [true, false]) {
      expect(classifyOverviewEdge(topo, geometry, e('AAA101H5', b0), { longStubs })).toBe('inner-stub')
      expect(classifyOverviewEdge(topo, geometry, e(a0, 'AAA301H5'), { longStubs })).toBe('inner-stub')
    }
    expect(isLongOverviewEdge(topo, geometry, e('AAA101H5', 'DDD201H5'))).toBe(true)
    expect(isLongOverviewEdge(topo, geometry, e('AAA101H5', b0))).toBe(false)
    expect(classifyOverviewEdge(topo, geometry, e('AAA101H5', 'DDD201H5'))).toBe('long-stub')
    expect(classifyOverviewEdge(topo, geometry, e('AAA101H5', 'DDD201H5'), { longStubs: false })).toBe('full')

    const picture = topo.edges.map((_, k) => k)
    const [fromA0, fromALast, intoB0] = plainEdgeStubs(topo, geometry, [e(a0, 'AAA301H5'), e(aLast, 'AAA301H5'), e('AAA101H5', b0)], { presentation, planWith: picture })
    const secondLeft = column.x + column.trackW + opt.trackGap
    // Row 0: b0 faces a0 on its row, so a0 draws no source stub (a stub between two courses of one
    // column reads as a link between them).
    expect(fromA0.source).toEqual([])
    // The last row of the first track has nothing beside it: a straight stub from labelEnd + 2, its
    // terminal dot 6 px clear of where the next track's dot (r 5) would be.
    expect(fromALast.source).toEqual([
      { op: 'M', x: box(aLast).x + box(aLast).w + 2, y: box(aLast).cy },
      { op: 'L', x: secondLeft + opt.dotInset - 5 - INNER_CLEAR - STUB_TERMINAL, y: box(aLast).cy },
    ])
    // Inner target stub: from its terminal dot in the track gap (4 px before the track) along the row
    // gap above (AAA101 lies above), a quarter turn down onto the dot; nothing on its row.
    const r = dotRadius('none', 'compact')
    const gap = box(b0).cy - (11 - 1.5)
    expect(intoB0.target[0]).toEqual({ op: 'M', x: secondLeft - 4, y: gap })
    // The turn's radius is the drop from the gap to the dot's top (4.75 px for compact rows, at most 6).
    expect(intoB0.target[1]).toEqual({ op: 'L', x: box(b0).cx - (box(b0).cy - r - 1 - gap), y: gap })
    expect(lastPoint(intoB0.target)).toEqual({ x: box(b0).cx, y: box(b0).cy - r - 1 })
    // One hook per row gap of a track: every node of the second track has its own.
    const hooks = plainEdgeStubs(topo, geometry, second.map(code => e('AAA101H5', code)), { presentation, planWith: picture })
    expect(new Set(hooks.map(h => h.target[0].y)).size).toBe(second.length)
    // Outer ends keep the long-edge stub form: 14 px past AAA101's out-port, 10 px before AAA301's entry.
    const out = geometry.columns[topo.nodes[index(topo, 'AAA101H5')].col]
    expect(intoB0.source).toEqual([
      { op: 'M', x: out.x + out.w - 2, y: box('AAA101H5').cy },
      { op: 'L', x: out.x + out.w - 2 + 14, y: box('AAA101H5').cy },
    ])
    const xIn = geometry.columns[topo.nodes[index(topo, 'AAA301H5')].col].x - 2
    expect(fromA0.target).toEqual([
      { op: 'M', x: xIn - 10, y: box('AAA301H5').cy },
      { op: 'L', x: xIn, y: box('AAA301H5').cy },
      { op: 'L', x: box('AAA301H5').cx - r - 1, y: box('AAA301H5').cy },
    ])
    // A hover preview still gets the full path of an inner-stub edge, plain or routed: through the
    // row gap and down (or up) into b0's dot.
    for (const [hover] of [
      plainEdgePaths(topo, geometry, [e('AAA101H5', b0)], { presentation, leader: true, planWith: picture }),
      routedEdgePaths(topo, geometry, [e('AAA101H5', b0)], { presentation, leader: true, planWith: picture }),
    ]) {
      const end = lastPoint(hover)
      expect(end.x).toBeCloseTo(box(b0).cx, 9)
      expect(Math.abs(end.y - box(b0).cy)).toBeCloseTo(r + 1, 9)
    }
    // While a course is selected nothing wraps, so no edge has an inner-track end.
    const focus = computePresentation(topo, presentationInput({ focusId: 'UTM:AAA101H5' }))
    const focused = computeGeometry(topo, focus, stubMeasure(topo))
    expect(topo.edges.every((_, k) => classifyOverviewEdge(topo, focused, k) !== 'inner-stub')).toBe(true)
  })

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
    const faint = topology.edges.map((_, e) => e).filter(e => presentation.edgeRole[e] === 'faint')
    const long = faint.filter(e => classifyOverviewEdge(topology, geometry, e) === 'long-stub')
    expect(long.length).toBeGreaterThan(400)
    const paths = plainEdgePaths(topology, geometry, long, { presentation, planWith: faint })
    const stubs = plainEdgeStubs(topology, geometry, long, { presentation, planWith: faint })
    long.forEach((_, k) => {
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
