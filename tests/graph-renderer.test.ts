import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  buildTopology, classifyOverviewEdge, computeGeometry, computePresentation, computeRoutes, dotRadius, geometryOptions, innerTrackEnds, plainEdgeBlocked,
  plainEdgePaths, plainEdgeStubs, routedEdgePaths, samplePath,
} from '../src/graph'
import type { DisplayClass, Geometry, NodeRole, PathSegment, Presentation, PresentationInput, RecordStatus } from '../src/graph'
import {
  RENDER, buildScene, drawScene, hoverEdges, interpolateGeometry, isLongEdge, nodeStyle, overlayGeometry, overlayRowsChange, routeWidth,
  separatorLine, tweenScene, type EdgeDraw, type FrameState, type Scene, type SceneInput,
} from '../src/graph/renderer'
import { bandCounts, chainLaneCount, laneCounts } from '../src/graph/overlays/counts'
import { pillText, placePills } from '../src/graph/overlays/EdgePills'
import { buildLaneRows, placeLane } from '../src/graph/overlays/LaneColumn'
import { anyOfParts } from '../src/graph/overlays/Tooltip'
import { DIVISION_STRINGS, GRAPH_STRINGS } from '../src/graph/strings'
import { createLabelMeasure } from '../src/graph/text'
import { forcedTokens, type RenderTokens } from '../src/graph/tokens'
import { laneTone } from '../src/graph/topology'
import { subjectTones } from '../src/ui/SubjectBullet'
import { loadGraphDataset, presentationInput } from './helpers/dataset'
import { anyGroupsFor, facingStubs, obstacleBoxes, otherTrackCrossings, pathIntrusions, stubMeasure } from './helpers/graph'

const { dataset } = loadGraphDataset()
const topology = buildTopology(dataset)
const text = createLabelMeasure(topology, dataset, {
  measureText: (value, font) => value.length * Number(/([\d.]+)px/.exec(font)?.[1] ?? 13) * 0.55,
  creditLabel: '{n} cr',
})
const idx = (code: string) => topology.indexById.get(`UTM:${code}`)!

const TOKEN_KEYS = [
  'surface', 'band', 'line', 'ruleStrong', 'ink', 'ink2', 'ink3', 'focusRing', 'preInk', 'unlInk', 'progWash', 'selWash', 'selGlow',
  'selPlate', 'selPlateInk', 'nodeDefault', 'nodeMini', 'nodeSelectedRing', 'nodePrereqDirect', 'nodePrereqTransitive',
  'nodeUnlockDirect', 'nodeUnlockTransitive', 'nodeProgram', 'nodeCompleted', 'nodeInProgress', 'nodePlanned', 'nodeAvailable',
  'edgeFaint', 'edgeHover', 'edgePrereqDirect', 'edgePrereqTransitive', 'edgeUnlockDirect', 'edgeUnlockTransitive', 'edgeProgram',
  'edgeUnrelated',
] as const
const tokens = {
  ...Object.fromEntries(TOKEN_KEYS.map(key => [key, `#${key}`])),
  lanes: {},
  forced: false,
  dark: false,
} as unknown as RenderTokens
const EDGE_COLOURS = new Set(TOKEN_KEYS.filter(key => key.startsWith('edge')).map(key => `#${key}`))

interface Model {
  presentation: Presentation
  geometry: Geometry
  scene: Scene
}

/** Real data; geometry with the shared stub measure (tests/helpers/graph.ts) unless `measured`. */
function model(input: Partial<PresentationInput> = {}, programActive = false, measured = false, tok: RenderTokens = tokens): Model {
  const presentation = computePresentation(topology, presentationInput(input))
  const geometry = computeGeometry(topology, presentation, measured ? text : stubMeasure(topology))
  const focus = presentation.role.indexOf('focus')
  const routes = computeRoutes(topology, presentation, geometry, { anyGroups: focus >= 0 ? anyGroupsFor(dataset, topology, focus) : [] })
  const scene = buildScene({ topology, geometry, presentation, routes, text, tokens: tok, focus, programActive, showAllEdges: input.showAllEdges ?? false })
  return { presentation, geometry, scene }
}

// ---------------------------------------------------------------------------
// Canvas stand-ins: a Path2D that records its ops and a context that records its calls.

type Op = [string, ...number[]]

class FakePath2D {
  ops: Op[] = []
  moveTo(x: number, y: number) { this.ops.push(['M', x, y]) }
  lineTo(x: number, y: number) { this.ops.push(['L', x, y]) }
  bezierCurveTo(...a: number[]) { this.ops.push(['C', ...a]) }
  arc(...a: number[]) { this.ops.push(['A', ...a.slice(0, 3)]) }
  rect(...a: number[]) { this.ops.push(['R', ...a]) }
  roundRect(...a: number[]) { this.ops.push(['RR', ...a.slice(0, 4)]) }
  closePath() { this.ops.push(['Z']) }
}

interface Call {
  name: string
  args: unknown[]
  state: Record<string, unknown>
}

function mockContext(): { ctx: CanvasRenderingContext2D; calls: Call[] } {
  const state: Record<string, unknown> = { globalAlpha: 1 }
  const calls: Call[] = []
  const ctx = new Proxy(state, {
    get: (target, key) => (typeof key === 'string' && !(key in target)
      ? (...args: unknown[]) => { calls.push({ name: key, args, state: { ...target } }) }
      : target[key as string]),
    set: (target, key, value) => {
      target[key as string] = value
      return true
    },
  })
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls }
}

/** One frame showing the whole world at `zoom` (nothing culled). */
function frameOf(m: Model, zoom = 1, extra: Partial<FrameState> = {}): FrameState {
  const plot = { left: 176, top: 60, width: m.geometry.width * zoom, height: m.geometry.height * zoom }
  return {
    view: { zoom, x: 176, y: 60 },
    plot,
    width: plot.left + plot.width,
    height: plot.top + plot.height,
    dpr: 1,
    hover: -1,
    cursor: -1,
    hoverEdges: null,
    labelAlpha: 1,
    edgeAlpha: 1,
    ...extra,
  }
}

const edgeStrokes = (calls: readonly Call[]) => calls.filter(c => c.name === 'stroke' && EDGE_COLOURS.has(c.state.strokeStyle as string))
const moves = (path: unknown) => (path as FakePath2D).ops.filter(op => op[0] === 'M').length

const realPath2D = (globalThis as { Path2D?: unknown }).Path2D
beforeAll(() => {
  (globalThis as { Path2D?: unknown }).Path2D = FakePath2D
})
afterAll(() => {
  (globalThis as { Path2D?: unknown }).Path2D = realPath2D
})

// ---------------------------------------------------------------------------

describe('node styles (design-spec 7.1-7.3)', () => {
  /** A one-node-per-case presentation, so nodeStyle can be read for every role / class / record. */
  function styles(cases: Array<{ cls: DisplayClass; role: NodeRole; record?: RecordStatus; met?: boolean; inProgram?: boolean }>, focus: number, programActive: boolean) {
    const presentation: Presentation = {
      cls: cases.map(c => c.cls),
      role: cases.map(c => c.role),
      record: cases.map(c => c.record ?? null),
      eligibility: cases.map(c => (c.met ? 'met' : null)),
      inProgram: cases.map(c => c.inProgram ?? false),
      edgeRole: [],
      dimming: focus >= 0 || programActive,
    }
    const input = { presentation, tokens, focus, programActive } as unknown as SceneInput
    const recordActive = presentation.record.some(r => r !== null)
    return cases.map((_, i) => nodeStyle(i, input, recordActive))
  }

  it('uses the 7.1 radii, glyphs and colours, matching the routing radii', () => {
    const cases = [
      { cls: 'compact', role: 'none' },
      { cls: 'full', role: 'none' },
      { cls: 'mini', role: 'none' },
      { cls: 'full', role: 'focus' },
      { cls: 'full', role: 'prereq-direct' },
      { cls: 'full', role: 'prereq' },
      { cls: 'compact', role: 'prereq' },
      { cls: 'full', role: 'unlock-direct' },
      { cls: 'full', role: 'unlock' },
    ] as const
    const out = styles([...cases], 3, false)
    expect(out.map(s => s.r)).toEqual([3.75, 4.25, 2.25, 8.5, 5, 4.25, 4.25, 5, 4.25])
    expect(out.map(s => s.glyph)).toEqual(['disc', 'disc', 'disc', 'focus', 'disc', 'hollow', 'hollow', 'disc', 'hollow'])
    expect(out.map(s => s.color)).toEqual([
      '#nodeDefault', '#nodeDefault', '#nodeMini', '#nodeSelectedRing', '#nodePrereqDirect', '#nodePrereqTransitive',
      '#nodePrereqTransitive', '#nodeUnlockDirect', '#nodeUnlockTransitive',
    ])
    expect(out[4].codeColor).toBe('#preInk')
    expect(out[7].codeColor).toBe('#unlInk')
    // Routing (routes.ts dotRadius) must use the same radii for its entries and obstacles.
    cases.forEach((c, i) => expect(out[i].r, `${c.role}/${c.cls}`).toBe(dotRadius(c.role, c.cls)))
    for (const s of out) expect(s.rings).toEqual([])
  })

  it('rings program courses in program mode and, compact amber, outside the chain during a selection', () => {
    const [programMode] = styles([{ cls: 'full', role: 'program', inProgram: true }], -1, true)
    expect(programMode).toMatchObject({ r: 4.25, glyph: 'disc', color: '#nodeProgram' })
    expect(programMode.rings).toEqual([{ r: 4.25 + 3.5, width: 1.5, color: '#nodeProgram' }])

    const out = styles([
      { cls: 'full', role: 'focus', inProgram: true },
      { cls: 'compact', role: 'program', inProgram: true },
      { cls: 'full', role: 'prereq-direct', inProgram: true },
      { cls: 'mini', role: 'none', inProgram: true },
      { cls: 'mini', role: 'none' },
    ], 0, true)
    // Outside the chain (19.7): compact amber disc r 3.75 with the 1.5 px program ring.
    expect(out[1]).toMatchObject({ r: 3.75, glyph: 'disc', color: '#nodeProgram' })
    expect(out[1].rings).toEqual([{ r: 3.75 + 3.5, width: 1.5, color: '#nodeProgram' }])
    // Chain members of the program: chain glyph + 2 px amber outer ring; the focus rings its knockout.
    expect(out[2].color).toBe('#nodePrereqDirect')
    expect(out[2].rings).toEqual([{ r: 5 + 3.5, width: 2, color: '#nodeProgram' }])
    expect(out[0].rings).toEqual([{ r: 10.5 + 3.5, width: 2, color: '#nodeProgram' }])
    // Program courses that are minis keep a faint amber ring; other minis have none.
    expect(out[3].rings).toEqual([{ r: 2.25 + 2, width: 1, color: '#nodeProgram', alpha: RENDER.ring.programMini.alpha }])
    expect(out[4].rings).toEqual([])
    // Without an active program nothing is ringed.
    expect(styles([{ cls: 'mini', role: 'none', inProgram: true }], -1, false)[0].rings).toEqual([])
  })

  it('draws record glyphs by shape and puts the available ring outside a program ring (7.2)', () => {
    const out = styles([
      { cls: 'compact', role: 'none', record: 'completed' },
      { cls: 'compact', role: 'none', record: 'inProgress' },
      { cls: 'full', role: 'prereq', record: 'planned' },
      { cls: 'compact', role: 'none', met: true },
      { cls: 'full', role: 'program', inProgram: true, met: true },
    ], -1, true)
    expect(out.map(s => s.glyph)).toEqual(['completed', 'inProgress', 'planned', 'disc', 'disc'])
    expect(out[0].color).toBe('#nodeCompleted')
    expect(out[1].color).toBe('#nodeInProgress')
    expect(out[2].color).toBe('#nodePrereqTransitive')
    expect(out[3].rings).toEqual([{ r: 3.75 + 3.5, width: 1.5, color: '#nodeAvailable' }])
    expect(out[4].rings.map(r => r.r)).toEqual([4.25 + 3.5, 4.25 + 6.5])
  })

  it('keeps the record active when it holds only failed attempts (drawn as not taken, still evaluated)', () => {
    // A failed course is left out of `presentation.record` (app-shell), but the engine still
    // evaluated the record: "available" rings (the retake of the failed course among them) apply.
    const eligibility = new Map([['UTM:CSC108H5', 'met' as const], ['UTM:CSC148H5', 'unmet' as const]])
    const { scene, presentation } = model({ eligibility })
    expect(presentation.record.every(r => r === null)).toBe(true)
    expect(scene.recordActive).toBe(true)
    expect(scene.nodes[idx('CSC108H5')].rings.map(r => r.color)).toEqual(['#nodeAvailable'])
    expect(scene.nodes[idx('CSC148H5')].rings).toEqual([])
    expect(model().scene.recordActive).toBe(false)
  })
})

/** Stub halves per stubbed edge, as the scene drew them (a half is empty where graph-core drew nothing at that end). */
function stubHalves(scene: Scene): Map<number, { source?: EdgeDraw; target?: EdgeDraw }> {
  const halves = new Map<number, { source?: EdgeDraw; target?: EdgeDraw }>()
  for (const d of scene.stubs) {
    const entry = halves.get(d.edge) ?? {}
    if (d.half === 'source') entry.source = d
    else entry.target = d
    halves.set(d.edge, entry)
  }
  return halves
}

/** Left edge of track k of a column (world px). */
const trackLeftOf = (geometry: Geometry, col: number, k: number) => {
  const column = geometry.columns[col]
  return column.x + k * (column.trackW + geometryOptions(geometry).trackGap)
}

/** Every faint stroke of a scene (full edges and stub halves) with its layout edge. */
const faintItems = (scene: Scene) => [...scene.faint.flatMap(group => group.edges), ...scene.stubs].map(d => ({ edge: d.edge, segments: d.segs }))

/**
 * Product rule, wrapped tracks (19.11), on the drawn scene: no faint stroke or terminal dot lies in
 * another track of a wrapped column of either end, inside that end's lane, and no two stubs of
 * different courses face each other on one row closer than 6 px.
 */
function wrappedTrackViolations(scene: Scene): string[] {
  const { geometry, topology: topo } = scene.input
  const problems: string[] = [...otherTrackCrossings(topo, geometry, faintItems(scene))]
  // Terminal dots (r 1.5) of every stub half: inside the x-range of a track other than their own
  // node's, within that node's lane, they would read as a tick towards a neighbour in the column.
  const terminal = RENDER.stub.terminal
  for (const d of scene.stubs) {
    const { from, to } = topo.edges[d.edge]
    const v = d.half === 'source' ? from : to
    const dot = d.half === 'source' ? d.segs[d.segs.length - 1] : d.segs[0]
    const node = topo.nodes[v]
    const column = geometry.columns[node.col]
    const lane = geometry.lanes[node.lane]
    if (column.tracks < 2 || dot.y < lane.y || dot.y > lane.y + lane.h) continue
    for (let k = 0; k < column.tracks; k++) {
      if (k === geometry.nodes[v].track) continue
      const left = trackLeftOf(geometry, node.col, k)
      if (dot.x + terminal > left + 1e-9 && dot.x - terminal < left + column.trackW - 1e-9) {
        problems.push(`${node.code}'s ${d.half} stub dot sits in track ${k} at ${dot.x.toFixed(1)},${dot.y.toFixed(1)}`)
      }
    }
  }
  const halves = scene.stubs.map(d => ({ v: d.half === 'source' ? topo.edges[d.edge].from : topo.edges[d.edge].to, segments: d.segs }))
  problems.push(...facingStubs(topo, halves.filter(h => geometry.columns[topo.nodes[h.v].col].tracks > 1)))
  return problems
}

describe('faint edges, stubs and hover previews (design-spec 8.7, 8.10, owner decision 19.11)', () => {
  const overview = model()
  const formOf = (m: Model, e: number) => classifyOverviewEdge(topology, m.geometry, e, { longStubs: !m.scene.input.showAllEdges && !m.presentation.dimming })
  const drawnFaint = (m: Model) => m.presentation.edgeRole.flatMap((role, e) =>
    role === 'faint' && m.scene.nodes[topology.edges[e].from].visible && m.scene.nodes[topology.edges[e].to].visible ? [e] : [])

  it('draws full edges whole and long and inner-track edges as stubs, by the graph-core classification', () => {
    const { scene, geometry, presentation } = overview
    const full = new Set(scene.faint.flatMap(group => group.edges.map(d => d.edge)))
    const halves = stubHalves(scene)
    const forms = { full: 0, 'long-stub': 0, 'inner-stub': 0 }
    let byDy = 0
    // A 'full' edge whose plain curve passes a course it does not connect is drawn as stubs too.
    const candidates = drawnFaint(overview).filter(e => formOf(overview, e) === 'full')
    const hits = plainEdgeBlocked(topology, geometry, candidates, { presentation, planWith: scene.planWith })
    const blocked = new Set(candidates.filter((_, k) => hits[k]))
    expect(blocked.size).toBeGreaterThan(100)
    for (const e of drawnFaint(overview)) {
      const form = formOf(overview, e)
      forms[form]++
      expect(full.has(e), `${e} ${form}`).toBe(form === 'full' && !blocked.has(e))
      if (form === 'full' && !blocked.has(e)) {
        expect(halves.has(e)).toBe(false)
        continue
      }
      // Each end outside a wrapped cell's inner tracks always gets its stub; an inner end gets one
      // unless its own track gap is too narrow (graph-core leaves it empty then).
      const inner = innerTrackEnds(topology, geometry, e)
      if (!inner.source) expect(halves.get(e)?.source, `source of ${e}`).toBeDefined()
      if (!inner.target) expect(halves.get(e)?.target, `target of ${e}`).toBeDefined()
      if (form === 'long-stub') {
        expect(isLongEdge(scene, e)).toBe(true)
        const { from, to } = topology.edges[e]
        const lanes = Math.abs(scene.laneRank[topology.nodes[from].lane] - scene.laneRank[topology.nodes[to].lane])
        if (lanes < RENDER.stub.laneSpan && Math.abs(geometry.nodes[to].cy - geometry.nodes[from].cy) > RENDER.stub.maxDy) byDy++
      }
    }
    // Not vacuous: the overview wraps (ENG, ...), has long edges, long by distance alone, and full edges.
    expect(forms['inner-stub']).toBeGreaterThan(0)
    expect(forms['long-stub']).toBeGreaterThan(0)
    expect(forms.full).toBeGreaterThan(forms['long-stub'])
    expect(byDy).toBeGreaterThan(0)
    // Every stub half ends in its terminal dot.
    expect(scene.stubDots.length).toBe(scene.stubs.length)
  })

  it('Show all connections draws long edges in full but keeps inner-track links as stubs (19.11)', () => {
    const all = model({ showAllEdges: true })
    const full = new Set(all.scene.faint.flatMap(group => group.edges.map(d => d.edge)))
    const stubbed = new Set(all.scene.stubs.map(d => d.edge))
    let inner = 0
    for (const e of drawnFaint(all)) {
      const ends = innerTrackEnds(topology, all.geometry, e)
      const isInner = ends.source || ends.target
      if (isInner) inner++
      expect(full.has(e), `${e}`).toBe(!isInner)
      if (stubbed.has(e)) expect(isInner).toBe(true)
    }
    expect(inner).toBeGreaterThan(0)
    // Edges whose plain curve passes another course are drawn in full, routed around labels and dots.
    const drawnFull = all.scene.faint.flatMap(group => group.edges)
    const blocked = plainEdgeBlocked(topology, all.geometry, drawnFull.map(d => d.edge), { presentation: all.presentation, planWith: all.scene.planWith })
    // (plainEdgeBlocked reports the plain curve; the drawn, routed path clears every course.) The
    // renderer routes them in layout edge order.
    const routed = drawnFull.filter((_, k) => blocked[k]).sort((a, b) => a.edge - b.edge)
    expect(routed.length).toBeGreaterThan(100)
    const expected = routedEdgePaths(topology, all.geometry, routed.map(d => d.edge), { presentation: all.presentation, planWith: all.scene.planWith })
    routed.forEach((d, k) => expect(d.segs).toEqual(expected[k]))
    // The long edges of the default overview are among the full ones now.
    const long = drawnFaint(overview).filter(e => formOf(overview, e) === 'long-stub')
    expect(long.length).toBeGreaterThan(0)
    for (const e of long) expect(full.has(e)).toBe(true)
  })

  it('draws each stub end in its own form: long-edge port stubs, inner stubs inside their own track gap', () => {
    const { scene, geometry } = overview
    const opt = geometryOptions(geometry)
    const dots = new Set(scene.stubDots.map(dot => `${dot.x},${dot.y}`))
    let innerSources = 0
    let innerTargets = 0
    let portSources = 0
    let portTargets = 0
    for (const [e, { source, target }] of stubHalves(scene)) {
      const { from, to } = topology.edges[e]
      const inner = innerTrackEnds(topology, geometry, e)
      if (source) {
        const a = geometry.nodes[from]
        const col = topology.nodes[from].col
        const segs = source.segs
        const end = segs[segs.length - 1]
        expect(dots.has(`${end.x},${end.y}`)).toBe(true)
        for (const seg of segs) expect(seg.y).toBeCloseTo(a.cy, 9)
        if (inner.source) {
          innerSources++
          // Straight along its row from the label end, at most 14 px, its terminal dot clear of the
          // next track (whose left edge it never reaches); only where no course of the next track
          // sits on its row.
          expect(topology.cells[topology.nodes[from].lane][col].some(u => geometry.nodes[u].track === a.track + 1 && geometry.nodes[u].cy === a.cy)).toBe(false)
          expect(segs[0].x).toBeCloseTo(a.x + a.w + 2, 9)
          expect(end.x - segs[0].x).toBeLessThanOrEqual(RENDER.stub.source + 1e-9)
          expect(end.x + RENDER.stub.terminal).toBeLessThan(trackLeftOf(geometry, col, a.track + 1))
        } else {
          portSources++
          // The 14 px stub from the column out-port.
          const column = geometry.columns[col]
          const stubStart = segs[segs.length - 2]
          expect(end.x - stubStart.x).toBeCloseTo(RENDER.stub.source, 9)
          expect(stubStart.x).toBeGreaterThanOrEqual(column.x + column.w - 2 - 1e-9)
        }
      }
      if (target) {
        const b = geometry.nodes[to]
        const col = topology.nodes[to].col
        const segs = target.segs
        const tail = segs[segs.length - 1]
        expect(dots.has(`${segs[0].x},${segs[0].y}`)).toBe(true)
        expect(tail.x).toBeLessThanOrEqual(b.cx)
        if (inner.target) {
          innerTargets++
          // A hook from the row gap next to its row: its terminal dot in the track gap before its
          // track, then down (or up) onto the dot; never along its row from the previous track.
          const left = trackLeftOf(geometry, col, b.track)
          expect(segs[0].x).toBeGreaterThan(left - opt.trackGap)
          expect(segs[0].x).toBeLessThan(left)
          expect(Math.abs(segs[0].y - b.cy)).toBeGreaterThan(scene.nodes[to].r + 1)
          expect(tail.x).toBeCloseTo(b.cx, 9)
          expect(Math.abs(tail.y - b.cy)).toBeCloseTo(scene.nodes[to].r + 1, 9)
        } else {
          for (const seg of segs) expect(seg.y).toBeCloseTo(b.cy, 9)
          portTargets++
          expect(b.track).toBe(0)
          expect(segs[1].x - segs[0].x).toBeCloseTo(RENDER.stub.target, 9)
        }
      }
    }
    expect(Math.min(innerTargets, portSources, portTargets)).toBeGreaterThan(0)
    // Inner source stubs are drawn only where nothing in the next track faces them: few or none.
    expect(innerSources).toBeLessThan(innerTargets)
  })

  it('never lets a faint stroke cross another track of its column, in any overview or with Show all connections (19.11)', () => {
    let wrappedCells = 0
    for (const input of [{}, { titles: true }, { showAllEdges: true }, { titles: true, showAllEdges: true }, { focusId: 'UTM:CSC148H5', showAllEdges: true }, { subjects: new Set(['ENG', 'ENV', 'CCT']) }]) {
      const m = model(input)
      wrappedCells += m.geometry.columns.filter(c => c.tracks > 1).length
      expect(wrappedTrackViolations(m.scene), JSON.stringify(input, (_, v: unknown) => (v instanceof Set ? [...v] : v))).toEqual([])
    }
    expect(wrappedCells).toBeGreaterThan(0)
    // The check bites: the full plain paths of the inner-stub edges (what the overview drew before
    // 19.11: through the row gaps, across the later tracks) do cross other tracks.
    const { scene, geometry, presentation } = overview
    const inner = drawnFaint(overview).filter(e => formOf(overview, e) === 'inner-stub')
    const before = plainEdgePaths(topology, geometry, inner, { presentation, planWith: scene.planWith })
    expect(otherTrackCrossings(topology, geometry, inner.map((edge, k) => ({ edge, segments: before[k] }))).length).toBeGreaterThan(0)
  })

  it('routes hover previews and full faint edges around the courses they do not connect (visual QA)', () => {
    // A plain curve skipping a column ran straight through the courses on its row (CSC209H5 →
    // CSC379H5 read as CSC318H5 → CSC338H5): previews are routed, full faint edges are only drawn
    // when their curve is clear (else stubs, or routed with Show all connections).
    for (const input of [{}, { titles: true }, { showAllEdges: true }]) {
      const m = model(input)
      const boxes = obstacleBoxes(topology, m.presentation, m.geometry)
      const asPaths = (list: readonly EdgeDraw[]) => list.map(d => ({ edge: d.edge, role: 'faint' as const, kind: topology.edges[d.edge].kind, shape: 'edge' as const, segments: d.segs }))
      expect(pathIntrusions(topology, asPaths(m.scene.faint.flatMap(group => group.edges)), boxes, -1), JSON.stringify(input)).toEqual([])
      if (Object.keys(input).length) continue
      const degree = new Map<number, number>()
      for (const edge of topology.edges) for (const v of [edge.from, edge.to]) degree.set(v, (degree.get(v) ?? 0) + 1)
      const busiest = [...degree].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([v]) => v)
      for (const v of [...busiest, idx('CSC209H5'), idx('BIO152H5'), idx('SOC205H5')]) {
        const hover = hoverEdges(m.scene, v)!
        expect(pathIntrusions(topology, asPaths([...hover.solid, ...hover.dashed]), boxes, -1), topology.nodes[v].code).toEqual([])
      }
    }
    // Not vacuous: CSC209H5's plain previews do run through other courses.
    const { scene, geometry, presentation } = overview
    const v = idx('CSC209H5')
    const own = topology.edges.flatMap((edge, e) => (edge.from === v || edge.to === v ? [e] : []))
    const plain = plainEdgePaths(topology, geometry, own, { presentation, leader: true, planWith: scene.planWith })
    const plainPaths = own.map((edge, k) => ({ edge, role: 'faint' as const, kind: topology.edges[edge].kind, shape: 'edge' as const, segments: plain[k] }))
    expect(pathIntrusions(topology, plainPaths, obstacleBoxes(topology, presentation, geometry), -1).length).toBeGreaterThan(0)
  })

  it('previews a hovered node in an inner track with all its links in full, crossing its column only transiently', () => {
    const { scene, geometry, presentation } = overview
    const inner = drawnFaint(overview).filter(e => formOf(overview, e) === 'inner-stub')
    const v = topology.edges[inner[0]].from
    const hover = hoverEdges(scene, v)!
    const list = [...hover.solid, ...hover.dashed]
    const own = topology.edges.flatMap((edge, e) => (edge.from === v || edge.to === v) && scene.nodes[edge.from].visible && scene.nodes[edge.to].visible ? [e] : [])
    expect(list.map(d => d.edge).sort((a, b) => a - b)).toEqual(own)
    const expected = routedEdgePaths(topology, geometry, list.map(d => d.edge), { presentation, leader: true, planWith: scene.planWith })
    list.forEach((d, k) => expect(d.segs).toEqual(expected[k]))
    // Full length: every preview reaches its far end (the target's dot or the source's label).
    for (const d of list) {
      const { from, to } = topology.edges[d.edge]
      const last = d.segs[d.segs.length - 1]
      const b = geometry.nodes[to]
      expect(Math.hypot(last.x - b.cx, last.y - b.cy)).toBeLessThan(scene.nodes[to].r + 2)
      expect(d.segs[0].x).toBeCloseTo(geometry.nodes[from].x + geometry.nodes[from].w + 4, 9)
    }
  })

  it('never draws a faint edge or stub through a label or dot of its own columns (real data, stub measure)', () => {
    for (const input of [{}, { titles: true }, { showAllEdges: true }]) {
      const { scene, geometry } = model(input)
      const byCol = new Map<number, number[]>()
      geometry.nodes.forEach((box, v) => {
        if (box.cls !== 'full' && box.cls !== 'compact') return
        const list = byCol.get(topology.nodes[v].col)
        if (list) list.push(v)
        else byCol.set(topology.nodes[v].col, [v])
      })
      const inside = (v: number, x: number, y: number) => {
        const b = geometry.nodes[v]
        const r = scene.nodes[v].r
        return (x > b.x && x < b.x + b.w && y > b.y && y < b.y + b.h) || (Math.abs(x - b.cx) < r && Math.abs(y - b.cy) < r)
      }
      const problems: string[] = []
      const check = (d: EdgeDraw, segs: readonly PathSegment[]) => {
        const { from, to } = topology.edges[d.edge]
        const others = [...new Set([topology.nodes[from].col, topology.nodes[to].col])]
          .flatMap(col => byCol.get(col) ?? [])
          .filter(v => {
            const b = geometry.nodes[v]
            return v !== from && v !== to && b.x - 8 <= d.x1 && b.x + b.w >= d.x0 && b.y <= d.y1 && b.y + b.h >= d.y0
          })
        samplePath(segs, 1, (x, y) => {
          const hit = others.find(v => inside(v, x, y))
          if (hit === undefined) return false
          problems.push(`${topology.nodes[from].code}>${topology.nodes[to].code} crosses ${topology.nodes[hit].code}`)
          return true
        })
      }
      for (const d of [...scene.faint.flatMap(group => group.edges), ...scene.stubs]) check(d, d.segs)
      expect(problems, JSON.stringify(input)).toEqual([])

      // Not vacuous: the old stub (14 px straight from the track's own out-port) ran into the next
      // track's dot on the same row for some wrapped sources.
      if (Object.keys(input).length) continue
      let naiveHits = 0
      for (const e of drawnFaint(overview)) {
        if (!innerTrackEnds(topology, geometry, e).source) continue
        const from = topology.edges[e].from
        const a = geometry.nodes[from]
        const column = geometry.columns[topology.nodes[from].col]
        if (a.track >= column.tracks - 1) continue
        const trackOut = column.x + a.track * (column.trackW + 8) + column.trackW - 2
        const naive: PathSegment[] = [{ op: 'M', x: trackOut, y: a.cy }, { op: 'L', x: trackOut + RENDER.stub.source + RENDER.stub.terminal, y: a.cy }]
        const others = (byCol.get(topology.nodes[from].col) ?? []).filter(v => v !== from)
        if (samplePath(naive, 1, (x, y) => others.some(v => inside(v, x, y)))) naiveHits++
      }
      expect(naiveHits).toBeGreaterThan(0)
    }
  })

  it('draws faint edges and stubs from the out-port and hover previews with the leader, all on the routing anchors', () => {
    const { scene, presentation, geometry } = overview
    const v = idx('CSC148H5')
    const hover = hoverEdges(scene, v)!
    const list = [...hover.solid, ...hover.dashed]
    expect(list.length).toBe(topology.edges.filter(e => e.from === v || e.to === v).length)
    // Faint edges and stubs are planned over the whole picture (one plan per scene); the hover
    // preview uses the same plan (its node's edges are all part of the picture in the overview).
    const picture = scene.planWith
    expect(new Set(picture)).toEqual(new Set([...scene.faint.flatMap(group => group.edges.map(d => d.edge)), ...scene.stubs.map(d => d.edge)]))
    const highlighted = routedEdgePaths(topology, geometry, list.map(d => d.edge), { presentation, leader: true, planWith: picture })
    list.forEach((d, k) => expect(d.segs).toEqual(highlighted[k]))
    // Faint: no leader (8.7), so the edge starts past the label end + 4 where the hover leader starts.
    const faint = scene.faint.flatMap(group => group.edges).find(d => topology.edges[d.edge].from === v)!
    expect(faint.segs).toEqual(plainEdgePaths(topology, geometry, [faint.edge], { presentation, planWith: picture })[0])
    const leader = highlighted.find((_, k) => list[k].edge === faint.edge)!
    expect(leader[0].x).toBeCloseTo(geometry.nodes[v].x + geometry.nodes[v].w + 4, 9)
    expect(faint.segs[0].x).toBeGreaterThan(leader[0].x)
    // Stubs are graph-core's stub halves, unchanged.
    const halves = stubHalves(scene)
    const stubbed = [...halves.keys()]
    const stubs = plainEdgeStubs(topology, geometry, stubbed, { presentation, planWith: picture })
    stubbed.forEach((e, k) => {
      expect(halves.get(e)!.source?.segs ?? []).toEqual(stubs[k].source)
      expect(halves.get(e)!.target?.segs ?? []).toEqual(stubs[k].target)
    })
  })

  it('starts edges at cx + r + 1 below the code threshold (labels hidden)', () => {
    const { scene, geometry } = overview
    const faint = scene.faint.flatMap(group => group.edges)
    for (const d of faint.slice(0, 200)) {
      const from = topology.edges[d.edge].from
      expect(d.lead).toEqual({ x: geometry.nodes[from].cx + scene.nodes[from].r + RENDER.dotPortGap, y: geometry.nodes[from].cy })
    }
    const zoom = 0.5
    const { ctx, calls } = mockContext()
    const frame = frameOf(overview, zoom)
    drawScene(ctx, scene, frame)
    const solid = edgeStrokes(calls).find(c => c.state.strokeStyle === '#edgeFaint')!
    const ops = (solid.args[0] as FakePath2D).ops
    const first = scene.faint[0].edges[0]
    const sx = (x: number) => frame.plot.left + (x - frame.view.x) * zoom
    expect(ops[0]).toEqual(['M', sx(first.lead!.x), expect.any(Number)])
    expect(ops[1][0]).toBe('L')
    expect(ops[1][1]).toBeCloseTo(sx(first.segs[0].x), 9)
    // At zoom 1 the same edge starts at its out-port.
    const normal = mockContext()
    drawScene(normal.ctx, scene, frameOf(overview, 1))
    const at1 = (edgeStrokes(normal.calls).find(c => c.state.strokeStyle === '#edgeFaint')!.args[0] as FakePath2D).ops
    expect(at1[0]).toEqual(['M', first.segs[0].x, expect.any(Number)])
  })
})

describe('drawing (design-spec 3.3, 7.5, 8.11, 8.13)', () => {
  it('strokes each edge group once (one Path2D per group)', () => {
    for (const m of [model(), model({ focusId: 'UTM:CSC148H5' }), model({ focusId: 'UTM:ECO200Y5' })]) {
      const { ctx, calls } = mockContext()
      drawScene(ctx, m.scene, frameOf(m))
      const strokes = edgeStrokes(calls)
      const groups = [...m.scene.faint, ...m.scene.routeLayers.flat()]
      expect(strokes.length).toBe(groups.length + (m.scene.stubs.length ? 1 : 0))
      const drawn = strokes.reduce((n, c) => n + moves(c.args[0]), 0)
      expect(drawn).toBe(groups.reduce((n, g) => n + g.edges.length, 0) + m.scene.stubs.length)
      for (const c of strokes) expect(c.state.globalAlpha).toBe(1)
    }
  })

  it('paints the selection wash again over every knockout, and only with a selection', () => {
    const rewashes = (m: Model) => {
      const { ctx, calls } = mockContext()
      drawScene(ctx, m.scene, frameOf(m))
      return calls.filter((c, i) => c.name === 'clip' && c.args[0] instanceof FakePath2D &&
        calls[i + 1]?.name === 'fillRect' && calls[i + 1].state.fillStyle === '#selWash').length
    }
    const selected = model({ focusId: 'UTM:CSC148H5' })
    // Mini halos and label knockouts (both parities), dot knockouts, the fork-free focus knockout.
    expect(rewashes(selected)).toBeGreaterThanOrEqual(4)
    expect(rewashes(model())).toBe(0)
  })

  it('uses 1 px transitive edges in forced colours (12)', () => {
    expect(routeWidth('prereq', 'edge')).toBe(1.15)
    expect(routeWidth('unlock', 'edge', true)).toBe(1)
    expect(routeWidth('prereq-direct', 'edge', true)).toBe(1.9)
    const forced = forcedTokens(tokens)
    const m = model({ focusId: 'UTM:CSC148H5' }, false, false, forced)
    const { ctx, calls } = mockContext()
    drawScene(ctx, m.scene, frameOf(m))
    const transitive = calls.filter(c => c.name === 'stroke' && c.state.strokeStyle === 'Highlight' && c.state.lineWidth === 1)
    expect(transitive.length).toBeGreaterThan(0)
    expect(calls.some(c => c.name === 'stroke' && c.state.lineWidth === 1.15)).toBe(false)
  })

  it('maps forced colours onto system colours', () => {
    const forced = forcedTokens(tokens)
    expect(forced.forced).toBe(true)
    expect([forced.surface, forced.band]).toEqual(['Canvas', 'Canvas'])
    expect([forced.nodeDefault, forced.ink, forced.edgeProgram]).toEqual(['CanvasText', 'CanvasText', 'CanvasText'])
    expect([forced.nodeSelectedRing, forced.nodePrereqDirect, forced.edgeUnlockDirect, forced.edgePrereqTransitive]).toEqual(['Highlight', 'Highlight', 'Highlight', 'Highlight'])
    expect([forced.nodeMini, forced.edgeFaint]).toEqual(['GrayText', 'GrayText'])
    expect([forced.selWash, forced.progWash]).toEqual(['transparent', 'transparent'])
  })

  it('snaps lane separators so they end on the lane boundary, like the lane column border-bottom', () => {
    for (const dpr of [1, 1.25, 1.5, 2, 4]) {
      for (const v of [100, 100.3, 100.5, 257.81]) {
        for (const width of [1, 1.5]) {
          const line = separatorLine(v, width, dpr)
          const bottom = (line.y + line.width / 2) * dpr
          expect(bottom).toBeCloseTo(Math.round(v * dpr), 9)
          expect(line.width * dpr).toBe(Math.max(1, Math.round(width * dpr)))
        }
      }
    }
  })

  it('lists the members of each fork junction and interpolates geometry for motion', () => {
    const m = model({ focusId: 'UTM:MAT232H5' })
    expect(m.scene.junctions.length).toBeGreaterThan(0)
    const groups = anyGroupsFor(dataset, topology, idx('MAT232H5'))
    for (const junction of m.scene.junctions) {
      expect(groups.some(group => junction.members.length >= 2 && junction.members.every(v => group.includes(v)))).toBe(true)
    }
    const tip = anyOfParts(GRAPH_STRINGS.zh.tipAnyOf, 'MAT134H5, MAT135H5')
    expect(tip[0]).toBe('多选一：')
    expect(tip[1]).toMatchObject({ props: { lang: 'en', children: 'MAT134H5, MAT135H5' } })

    const a = model().geometry
    const b = model({ titles: true }).geometry
    expect(interpolateGeometry(a, b, 1)).toBe(b)
    const half = interpolateGeometry(a, b, 0.5)
    const v = idx('CSC148H5')
    expect(half.nodes[v].cy).toBeCloseTo((a.nodes[v].cy + b.nodes[v].cy) / 2, 9)
    expect(half.height).toBeCloseTo((a.height + b.height) / 2, 9)
  })
})

describe('geometry tweens (design-spec 17)', () => {
  const overview = model()
  const selected = model({ focusId: 'UTM:CSC148H5' })
  const hidden = model({ focusId: 'UTM:CSC148H5', hideUnrelated: true })
  const mix = (a: number, b: number, t: number) => a + (b - a) * t
  const f = idx('CSC148H5')

  it('moves nodes between layouts and lets appearing or disappearing ones ride with their lane and column', () => {
    const a = selected.geometry
    const b = hidden.geometry
    expect(interpolateGeometry(a, b, 1, topology)).toBe(b)
    const half = interpolateGeometry(a, b, 0.5, topology)
    // Visible in both: halfway between the two boxes.
    expect(half.nodes[f].cx).toBeCloseTo((a.nodes[f].cx + b.nodes[f].cx) / 2, 9)
    // A grey dot of a lane that "Hide unrelated" collapses: kept, in its shrinking lane.
    const v = topology.nodes.findIndex((_, i) => a.nodes[i].cls === 'mini' && !a.nodes[i].overflow && b.nodes[i].cls === 'hidden' && b.lanes[topology.nodes[i].lane].h === 0)
    expect(v).toBeGreaterThanOrEqual(0)
    const lane = topology.nodes[v].lane
    expect(half.nodes[v].cls).toBe('mini')
    expect(half.lanes[lane]).toMatchObject({ collapsed: false, h: (a.lanes[lane].h + b.lanes[lane].h) / 2 })
    expect(half.nodes[v].cy).toBeGreaterThanOrEqual(half.lanes[lane].y - 1e-9)
    expect(half.nodes[v].cy).toBeLessThanOrEqual(half.lanes[lane].y + half.lanes[lane].h + 1e-9)
    // ... and the same dot coming back grows out of the reopening lane.
    const back = interpolateGeometry(b, a, 0.25, topology)
    expect(back.nodes[v].cls).toBe('mini')
    expect(back.nodes[v].cy).toBeGreaterThanOrEqual(back.lanes[lane].y - 1e-9)
    expect(back.nodes[v].cy).toBeLessThanOrEqual(back.lanes[lane].y + back.lanes[lane].h + 1e-9)
    // Without the topology such a node simply takes its next box.
    expect(interpolateGeometry(a, b, 0.5).nodes[v]).toBe(b.nodes[v])
    // Bands hidden by a level filter stay visible until the end of the tween.
    const levels = model({ levels: new Set([300]) }).geometry
    const bands = interpolateGeometry(overview.geometry, levels, 0.5, topology).bands
    expect(bands.every((band, i) => band.visible === (overview.geometry.bands[i].visible || levels.bands[i].visible))).toBe(true)
  })

  it('builds tween frames without edges: next styles, interpolated radii, the labels of one layout', () => {
    const from = overview.scene
    const to = selected.scene
    const early = tweenScene(from, to, 0.3, 'from')
    const late = tweenScene(from, to, 0.3, 'to')
    for (const frame of [early, late]) {
      expect(frame.tween).toBe(true)
      expect([frame.faint, frame.stubs, frame.stubDots, frame.routeLayers.flat(), frame.junctions]).toEqual([[], [], [], [], []])
    }
    // A course that becomes a grey dot: mini style at once, radius on its way from 3.75 to 2.25, and
    // its code label only while the previous labels are shown.
    const v = topology.nodes.findIndex((_, i) => from.nodes[i].cls === 'compact' && to.nodes[i].cls === 'mini' && to.nodes[i].visible)
    expect(early.nodes[v]).toMatchObject({ cls: 'mini', color: '#nodeMini', r: mix(3.75, 2.25, 0.3), labelled: false })
    expect(early.nodes[v].label?.code).toBe(topology.nodes[v].code)
    expect(late.nodes[v].label).toBeNull()
    // A direct prerequisite: blue, radius 3.75 → 5, its new full label (blue code) placed at its interpolated position.
    const p = idx('CSC108H5')
    expect(late.nodes[p]).toMatchObject({ color: '#nodePrereqDirect', codeColor: '#preInk', r: mix(3.75, 5, 0.3) })
    expect(late.nodes[p].label?.title).toBeTruthy()
    expect(late.nodes[p].boxY0).toBeCloseTo(late.input.geometry.nodes[p].cy - RENDER.label.halfFull, 9)
    // The new focus has its plate (and wash) at its interpolated position from the first frame.
    const layout = to.plate!.layout
    expect(early.plate).toMatchObject({ index: f, y: early.input.geometry.nodes[f].cy - layout.height / 2 })
    expect(early.wash!.row.y).toBeCloseTo(early.input.geometry.nodes[f].cy - Math.max(layout.height, early.input.geometry.nodes[f].h) / 2, 9)
    // Clearing: no plate; the old one fades out with the old labels; the old focus shrinks as a dot.
    const clearing = tweenScene(to, from, 0.3, 'from')
    expect(clearing.plate).toBeNull()
    expect(clearing.wash).toBeNull()
    expect(clearing.fadingPlate?.index).toBe(f)
    expect(clearing.nodes[f]).toMatchObject({ glyph: 'disc', r: mix(RENDER.radius.focusCentre, 3.75, 0.3) })
    expect(tweenScene(to, from, 0.3, 'to').fadingPlate).toBeNull()
    // Hide unrelated: grey dots shrink away; their lanes keep a rank (separators) until the end.
    const hiding = tweenScene(to, hidden.scene, 0.5, 'to')
    const gone = topology.nodes.findIndex((_, i) => to.nodes[i].visible && to.nodes[i].cls === 'mini' && !hidden.scene.nodes[i].visible)
    expect(hiding.nodes[gone]).toMatchObject({ visible: true, cls: 'mini', r: RENDER.radius.mini * 0.5, rings: [] })
    expect([...hiding.laneRank].filter(r => r >= 0).length).toBe([...to.laneRank].filter(r => r >= 0).length)
    // Slim-lane "+n" labels follow their dot.
    const overflow = tweenScene(to, hidden.scene, 0.5, 'from').overflowLabels
    for (const o of overflow) expect(o.y).toBeCloseTo(hiding.input.geometry.nodes[o.index].cy, 9)
  })

  it('draws tween frames without edges or knockouts, with label, plate and focus-ring motion', () => {
    const frame = tweenScene(overview.scene, selected.scene, 0.5, 'to')
    const { ctx, calls } = mockContext()
    drawScene(ctx, frame, frameOf(selected, 1, { labelAlpha: 0.4, focusScale: 0.6, plateAlpha: 0.5 }))
    expect(edgeStrokes(calls)).toEqual([])
    expect(calls.some(c => c.name === 'fill' && c.state.globalAlpha === RENDER.knockoutAlpha)).toBe(false)
    const texts = calls.filter(c => c.name === 'fillText')
    const plate = texts.filter(c => c.state.fillStyle === '#selPlateInk')
    const labels = texts.filter(c => c.state.fillStyle !== '#selPlateInk')
    expect(labels.length).toBeGreaterThan(10)
    for (const c of labels) expect(c.state.globalAlpha).toBe(0.4)
    expect(plate.length).toBeGreaterThan(0)
    expect(plate[0].state.globalAlpha).toBe(0.5)
    // The focus ring at 0.6 of its size (2 px stroke centred on the ring).
    const ring = calls.findIndex(c => c.name === 'stroke' && c.state.strokeStyle === '#nodeSelectedRing')
    const arc = calls.slice(0, ring).reverse().find(c => c.name === 'arc')!
    expect(arc.args[2]).toBeCloseTo(RENDER.radius.focusRing * 0.6 - RENDER.focusRingWidth / 2, 9)
    // Nothing of the edges' layers is drawn at zero opacity either.
    const hidden0 = mockContext()
    drawScene(hidden0.ctx, selected.scene, frameOf(selected, 1, { edgeAlpha: 0, transitiveAlpha: 0 }))
    expect(edgeStrokes(hidden0.calls)).toEqual([])
  })

  it('fades chain edges in by opacity only: direct (and faint) edges first, transitive and program edges after', () => {
    const { ctx, calls } = mockContext()
    drawScene(ctx, selected.scene, frameOf(selected, 1, { edgeAlpha: 0.5, transitiveAlpha: 0.25 }))
    const strokes = edgeStrokes(calls)
    const transitive = strokes.filter(c => c.state.strokeStyle === '#edgePrereqTransitive' || c.state.strokeStyle === '#edgeUnlockTransitive')
    const direct = strokes.filter(c => c.state.strokeStyle === '#edgePrereqDirect' || c.state.strokeStyle === '#edgeUnlockDirect')
    expect(transitive.length).toBeGreaterThan(0)
    expect(direct.length).toBeGreaterThan(0)
    for (const c of transitive) expect(c.state.globalAlpha).toBe(0.25)
    for (const c of direct) expect(c.state.globalAlpha).toBe(0.5)
    // One stroke per group still (overlaps never darken), at the group's opacity.
    expect(strokes.length).toBe(selected.scene.routeLayers.flat().length)
    const faint = mockContext()
    drawScene(faint.ctx, overview.scene, frameOf(overview, 1, { edgeAlpha: 0.3, transitiveAlpha: 0 }))
    const faintStrokes = edgeStrokes(faint.calls)
    expect(faintStrokes.length).toBeGreaterThan(0)
    for (const c of faintStrokes) expect(c.state.globalAlpha).toBe(0.3)
  })

  it('keeps the overlay rows of lanes, bands and columns a tween hides until it ends', () => {
    const a = selected.geometry
    const b = hidden.geometry
    expect(overlayRowsChange(a, b)).toBe(true)
    expect(overlayRowsChange(b, a)).toBe(true)
    expect(overlayRowsChange(a, a)).toBe(false)
    const kept = overlayGeometry(a, b)
    const rowsOf = (geometry: Geometry) => buildLaneRows({
      topology, geometry, counts: laneCounts(topology, hidden.presentation), focus: f, programActive: false,
      strings: GRAPH_STRINGS.en, divisionLabels: DIVISION_STRINGS.en, lang: 'en',
    }).map(row => row.lane)
    expect(rowsOf(kept)).toEqual(rowsOf(a))
    expect(rowsOf(b).length).toBeLessThan(rowsOf(a).length)
    // Positions still come from the frame's (interpolated) geometry; only visibility is kept.
    b.lanes.forEach((box, i) => {
      if (!box.collapsed) expect(kept.lanes[i]).toBe(box)
    })
    const levels = model({ levels: new Set([300]) }).geometry
    const keptBands = overlayGeometry(overview.geometry, levels).bands
    expect(keptBands.filter(band => band.visible).length).toBe(overview.geometry.bands.filter(band => band.visible).length)
    expect(overlayGeometry(overview.geometry, levels).columns.filter(c => c.w > 0).length).toBe(overview.geometry.columns.filter(c => c.w > 0).length)
  })
})

describe('counts, pills and lane rows (design-spec 7.5, 7.7, 9.1, 10.3)', () => {
  it('sizes a lane row whenever it is placed, not only on zoom frames (lane bars after a scroll)', () => {
    // A lane off screen at the last zoom / geometry frame was skipped; once it scrolls in, an
    // ordinary frame must still give it its height (it used to stay 0 px: no bar, no hover area).
    const el = { style: { transform: '', height: '' } } as unknown as HTMLElement
    placeLane(el, 120, 90)
    expect(el.style.height).toBe('90px')
    expect(el.style.transform).toBe('translate(0px, 120px)')
    placeLane(el, 40, 108)
    expect(el.style.height).toBe('108px')
  })

  it('counts chain courses per lane and band', () => {
    const m = model({ focusId: 'UTM:CSC148H5' })
    const lanes = laneCounts(topology, m.presentation)
    const bands = bandCounts(topology, m.presentation, m.geometry)
    const roles = m.presentation.role
    const needed = roles.filter(r => r === 'prereq' || r === 'prereq-direct').length
    const unlocked = roles.filter(r => r === 'unlock' || r === 'unlock-direct').length
    expect(lanes.reduce((n, c) => n + c.needed, 0)).toBe(needed)
    expect(bands.reduce((n, c) => n + c.unlocked, 0)).toBe(unlocked)
    expect(lanes.reduce((n, c) => n + c.total, 0)).toBe(topology.nodes.length)
    expect(lanes.filter(c => c.focus)).toHaveLength(1)
    expect(chainLaneCount(lanes)).toBe(lanes.filter(c => c.needed + c.unlocked > 0 || c.focus).length)
    expect(bands.every(c => c.columns >= 0)).toBe(true)
  })

  it('words pills in singular and plural, in both languages', () => {
    const en = GRAPH_STRINGS.en
    const count = (pre: number, unl: number, prog = 0) => ({ pre, unl, prog, total: pre + unl + prog })
    expect(pillText('left', count(1, 0), en, 'en')).toBe('← 1 earlier prerequisite')
    expect(pillText('left', count(2, 0), en, 'en')).toBe('← 2 earlier prerequisites')
    expect(pillText('right', count(0, 1), en, 'en')).toBe('1 later unlock →')
    expect(pillText('right', count(0, 1234), en, 'en')).toBe('1,234 later unlocks →')
    expect(pillText('bottom', count(4, 2), en, 'en')).toBe('↓ 4 prerequisites, 2 unlocks below')
    expect(pillText('top', count(0, 1, 1), en, 'en')).toBe('↑ 1 unlock, 1 program course above')
    expect(pillText('top', count(0, 3), en, 'en')).toBe('↑ 3 unlocks above')
    expect(pillText('right', count(0, 19), GRAPH_STRINGS.zh, 'zh')).toBe('后续 19 门 →')
  })

  it('slides pills along their edge off chain labels, the focus and each other (10.3)', () => {
    const hit = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
      a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
    // A right pill centred on the focus row would cover a direct unlock's label there.
    const label = { x: 1300, y: 300, w: 160, h: 32 }
    const [right] = placePills([{ side: 'right', w: 150, h: 24, x: 1340, y: 304, min: 70, max: 820 }], [label])
    expect(right.x).toBe(1340)
    expect(hit({ ...right, w: 150, h: 24 }, label)).toBe(false)
    // ... and moves no further than needed (just above or below the label, 4 px clear).
    expect(Math.min(Math.abs(right.y - (300 + 32 + 4)), Math.abs(right.y + 24 - (300 - 4)))).toBeLessThanOrEqual(6)
    // Zoomed in with the focus off the top-left corner, the left and top pills both clamp to the
    // corner; the second slides along its edge instead of drawing over the first.
    const pills = placePills([
      { side: 'left', w: 170, h: 24, x: 186, y: 70, min: 70, max: 820 },
      { side: 'top', w: 150, h: 24, x: 186, y: 70, min: 186, max: 1500 },
    ], [])
    expect(hit({ ...pills[0], w: 170, h: 24 }, { ...pills[1], w: 150, h: 24 })).toBe(false)
    expect(pills[0]).toEqual({ side: 'left', x: 186, y: 70 })
    // Nothing in the way: the preferred spot.
    expect(placePills([{ side: 'bottom', w: 120, h: 24, x: 500, y: 800, min: 186, max: 1500 }], [label])).toEqual([{ side: 'bottom', x: 500, y: 800 }])
  })

  it('keeps every lane tone stable under filters and equal to the app-wide subject bullet', () => {
    const app = subjectTones(topology)
    topology.lanes.forEach((lane, i) => expect(laneTone(topology, i), lane.subject).toBe(app.get(lane.subject)?.tone))
    const rowsOf = (input: Partial<PresentationInput>) => {
      const m = model(input)
      return buildLaneRows({
        topology, geometry: m.geometry, counts: laneCounts(topology, m.presentation), focus: m.presentation.role.indexOf('focus'),
        programActive: false, strings: GRAPH_STRINGS.en, divisionLabels: DIVISION_STRINGS.en, lang: 'en',
      })
    }
    const all = rowsOf({})
    const hidden = rowsOf({ focusId: 'UTM:CSC148H5', hideUnrelated: true })
    expect(hidden.length).toBeLessThan(all.length)
    for (const row of hidden) expect(row.tone, row.subject).toBe(all.find(r => r.lane === row.lane)!.tone)
    const filtered = rowsOf({ subjects: new Set(['CSC', 'MAT', 'STA']) })
    expect(filtered.map(r => r.subject)).toEqual(['CSC', 'MAT', 'STA'])
    for (const row of filtered) expect(row.tone).toBe(laneTone(topology, row.lane))
  })

  it('puts division labels on the lanes geometry reserved them for (LaneBox.divisionLabel)', () => {
    const m = model({ focusId: 'UTM:CSC148H5' })
    // Mark one labelled lane per division explicitly, so the test does not depend on geometry's choice.
    const marked = new Set<number>()
    const seen = new Set<string>()
    topology.lanes.forEach((lane, i) => {
      const box = m.geometry.lanes[i]
      if (box.collapsed || box.slim || seen.has(lane.division)) return
      seen.add(lane.division)
      marked.add(i)
    })
    const geometry: Geometry = { ...m.geometry, lanes: m.geometry.lanes.map((box, i) => ({ ...box, divisionLabel: marked.has(i) })) }
    const rows = buildLaneRows({
      topology, geometry, counts: laneCounts(topology, m.presentation), focus: idx('CSC148H5'), programActive: false,
      strings: GRAPH_STRINGS.en, divisionLabels: DIVISION_STRINGS.en, lang: 'en',
    })
    for (const row of rows) {
      expect(row.division !== null, topology.lanes[row.lane].subject).toBe(marked.has(row.lane))
      if (row.division) expect(row.division).toBe(DIVISION_STRINGS.en[topology.lanes[row.lane].division as keyof typeof DIVISION_STRINGS.en])
    }
    // The strong rule follows division boundaries in display order, labelled or not.
    rows.forEach((row, k) => {
      const previous = rows[k - 1]
      expect(row.divisionStart).toBe(k > 0 && topology.lanes[previous.lane].division !== topology.lanes[row.lane].division)
    })
    expect(rows.some(row => row.slim && row.divisionStart)).toBe(true)
  })
})
