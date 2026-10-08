import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildTopology, computeGeometry, computePresentation, computeRoutes, dotRadius, plainEdgePaths, plainEdgeStubs, samplePath } from '../src/graph'
import type { DisplayClass, Geometry, NodeRole, PathSegment, Presentation, PresentationInput, RecordStatus } from '../src/graph'
import {
  RENDER, buildScene, drawScene, hoverEdges, interpolateGeometry, isLongEdge, nodeStyle, routeWidth, separatorLine,
  type EdgeDraw, type FrameState, type Scene, type SceneInput,
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
import { anyGroupsFor, stubMeasure } from './helpers/graph'

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
})

/**
 * Stub halves per long edge. A half is missing only where a dense wrapped cell left its anchor
 * without a free row-gap slot (PlainEdgeOptions.truncateUnplaced): the source half starts on its
 * source's row, the target half at its terminal dot 10 px before the entry.
 */
function stubHalves(scene: Scene, geometry: Geometry): Map<number, { source?: EdgeDraw; target?: EdgeDraw }> {
  const halves = new Map<number, { source?: EdgeDraw; target?: EdgeDraw }>()
  for (const d of scene.stubs) {
    const { from } = topology.edges[d.edge]
    const entry = halves.get(d.edge) ?? {}
    const onSourceRow = Math.abs(d.segs[0].y - geometry.nodes[from].cy) < 1e-9 && d.segs[0].x <= geometry.nodes[from].x + geometry.nodes[from].w + 20
    if (onSourceRow && !entry.source) entry.source = d
    else entry.target = d
    halves.set(d.edge, entry)
  }
  return halves
}

describe('faint edges, stubs and hover previews (design-spec 8.7, 8.10)', () => {
  const overview = model()

  it('stubs exactly the long overview edges: 3+ visible lanes apart or more than 320 px apart vertically', () => {
    const { scene, presentation, geometry } = overview
    const faint = scene.faint.flatMap(group => group.edges)
    const stubbed = new Set(scene.stubs.map(d => d.edge))
    // Every stub half ends in a terminal dot (cut faint edges add theirs too).
    expect(scene.stubDots.length).toBeGreaterThanOrEqual(scene.stubs.length)
    // Halves are missing only in dense wrapped cells: a handful at most.
    expect(2 * stubbed.size - scene.stubs.length).toBeLessThan(0.01 * scene.stubs.length)
    let byDy = 0
    topology.edges.forEach((edge, e) => {
      if (presentation.edgeRole[e] !== 'faint') return
      const long = isLongEdge(scene, e)
      if (long && !stubbed.has(e)) return // both halves cut (dense wrapped cells)
      expect(stubbed.has(e)).toBe(long)
      const lanes = Math.abs(scene.laneRank[topology.nodes[edge.from].lane] - scene.laneRank[topology.nodes[edge.to].lane])
      if (lanes < 3 && Math.abs(geometry.nodes[edge.to].cy - geometry.nodes[edge.from].cy) > RENDER.stub.maxDy) byDy++
    })
    expect(byDy).toBeGreaterThan(0)
    expect(faint.length + stubbed.size).toBeLessThanOrEqual(presentation.edgeRole.filter(role => role === 'faint').length)
    expect(faint.length + stubbed.size).toBeGreaterThan(0.995 * presentation.edgeRole.filter(role => role === 'faint').length)
    // Show all connections draws every faint edge at full length.
    const all = model({ showAllEdges: true })
    expect(all.scene.stubs).toEqual([])
    expect(all.scene.faint.flatMap(group => group.edges).length).toBe(faint.length + stubbed.size)
  })

  it('starts every source stub at the column out-port, stepping wrapped tracks through the row gap first', () => {
    const { scene, geometry } = overview
    // Highest labelled track of each node's cell: only nodes with tracks to their right detour.
    const cellMaxTrack = (v: number) => Math.max(...topology.cells[topology.nodes[v].lane][topology.nodes[v].col].map(u => geometry.nodes[u].track))
    let wrapped = 0
    let last = 0
    const dots = new Set(scene.stubDots.map(dot => `${dot.x},${dot.y}`))
    for (const [e, { source, target }] of stubHalves(scene, geometry)) {
      const { from, to } = topology.edges[e]
      const a = geometry.nodes[from]
      if (source) {
      const column = geometry.columns[topology.nodes[from].col]
      const colOut = column.x + column.w - 2
      const segs = source.segs
      const end = segs[segs.length - 1]
      const stubStart = segs[segs.length - 2]
      // The 14 px stub itself: horizontal, from the column out-port, ending at the terminal dot.
      expect(end.op).toBe('L')
      expect(end.y).toBeCloseTo(stubStart.y, 9)
      expect(end.x - stubStart.x).toBeCloseTo(RENDER.stub.source, 9)
      expect(stubStart.x).toBeGreaterThanOrEqual(colOut - 1e-9)
      expect(dots.has(`${end.x},${end.y}`)).toBe(true)
      if (a.track < cellMaxTrack(from)) {
        wrapped++
        // Leaves its own track on its row, then runs in the row gap (half a row away) to the out-port.
        const trackRight = column.x + a.track * (column.trackW + 8) + column.trackW
        expect(segs[0].y).toBeCloseTo(a.cy, 9)
        expect(segs[0].x).toBeLessThanOrEqual(trackRight)
        expect(Math.abs(stubStart.y - a.cy)).toBeGreaterThan(8)
        expect(stubStart.x).toBeCloseTo(colOut, 9)
      } else {
        last++
        expect(segs[0].op).toBe('M')
        for (const seg of segs) expect(seg.y).toBeCloseTo(a.cy, 9)
      }
      }
      if (!target) continue
      // Target stub: 10 px into the entry, then into the dot: from the left on its row, or (a later
      // wrapped track) straight down or up from the row gap at cx, so nothing lies on its row
      // between the previous track's label and its dot.
      const b = geometry.nodes[to]
      const tail = target.segs[target.segs.length - 1]
      if (b.track > 0) {
        expect(tail.x).toBeCloseTo(b.cx, 9)
        expect(Math.abs(tail.y - b.cy)).toBeCloseTo(scene.nodes[to].r + 1, 9)
      } else {
        expect(tail.y).toBeCloseTo(b.cy, 9)
        expect(tail.x).toBeLessThanOrEqual(b.cx)
      }
      expect(target.segs[1].x - target.segs[0].x).toBeCloseTo(RENDER.stub.target, 9)
      expect(dots.has(`${target.segs[0].x},${target.segs[0].y}`)).toBe(true)
    }
    expect(wrapped).toBeGreaterThan(0)
    expect(last).toBeGreaterThan(0)
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
      for (const [e, { source }] of stubHalves(scene, geometry)) {
        if (!source) continue
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
    // Faint edges and stubs plan their wrapped-track row gaps over the whole picture; the hover
    // preview plans over the same picture plus its own edges.
    const picture = [...new Set([...scene.faint.flatMap(group => group.edges.map(d => d.edge)), ...scene.stubs.map(d => d.edge)])]
    const highlighted = plainEdgePaths(topology, geometry, list.map(d => d.edge), { presentation, leader: true, planWith: [...new Set([...picture, ...list.map(d => d.edge)])] })
    list.forEach((d, k) => expect(d.segs).toEqual(highlighted[k]))
    // Faint: no leader (8.7), so the edge starts past the label end + 4 where the hover leader starts.
    const faint = scene.faint.flatMap(group => group.edges).find(d => topology.edges[d.edge].from === v)!
    expect(faint.segs).toEqual(plainEdgePaths(topology, geometry, [faint.edge], { presentation, planWith: picture, truncateUnplaced: true })[0])
    const leader = highlighted.find((_, k) => list[k].edge === faint.edge)!
    expect(leader[0].x).toBeCloseTo(geometry.nodes[v].x + geometry.nodes[v].w + 4, 9)
    expect(faint.segs[0].x).toBeGreaterThan(leader[0].x)
    // Stubs are graph-core's stub halves, unchanged.
    const halves = stubHalves(scene, geometry)
    const stubbed = [...halves.keys()]
    const stubs = plainEdgeStubs(topology, geometry, stubbed, { presentation, planWith: picture, truncateUnplaced: true })
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
