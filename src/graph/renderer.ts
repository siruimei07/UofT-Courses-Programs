// Canvas 2D drawing of the course map (design-spec 3.3, 7, 8.6-8.13). buildScene() turns topology +
// presentation + geometry + routes into draw-ready lists once per state change; drawScene() paints
// one frame for a view with viewport culling, one Path2D per edge group stroked once with an opaque
// colour, and one batched fill per dot class and band parity. Pure apart from the canvas context.
import { geometryOptions } from './geometry'
import { plainEdgePaths, plainEdgeStubs } from './routes'
import type { LabelMeasurer, LabelText, PlateLayout } from './text'
import { TEXT } from './text'
import type { RenderTokens } from './tokens'
import type {
  DisplayClass,
  EdgeRole,
  Geometry,
  GeometryOptions,
  NodeRole,
  PathSegment,
  Presentation,
  RecordStatus,
  Routes,
  Topology,
} from './types'
import type { Plot, Rect, View, World } from './viewport'

export const RENDER = {
  /** Edge widths in screen px (3.3); never below one device pixel. */
  edge: {
    faint: 1,
    hover: 1.25,
    transitive: 1.15,
    direct: 1.9,
    trunk: 2.6,
    branch: 1.4,
    program: 1.4,
    unrelated: 1,
    fork: 1.9,
  },
  coreqDash: [4, 3] as readonly number[],
  knockoutAlpha: 0.9,
  glowBlur: 10,
  /** Dot radii in world px (7.1). */
  radius: {
    compact: 3.75,
    full: 4.25,
    mini: 2.25,
    direct: 5,
    transitive: 4.25,
    program: 4.25,
    programOutside: 3.75,
    focusRing: 8.5,
    focusCentre: 4,
    focusKnockout: 10.5,
  },
  minScreenRadius: { labelled: 2, mini: 1.3 },
  dotKnockout: 1.25,
  miniHalo: 1,
  hollowStroke: 1.6,
  focusRingWidth: 2,
  ring: {
    program: { offset: 3.5, width: 1.5 },
    programChain: { offset: 3.5, width: 2 },
    /** Faint amber ring of a program course drawn as a mini dot. */
    programMini: { offset: 2, width: 1, alpha: 0.55 },
    available: { offset: 3.5, width: 1.5 },
    availableOuter: { offset: 6.5, width: 1.5 },
    hover: { offset: 4, width: 1.25 },
    cursor: { offset: 6, width: 1.5 },
  },
  cursorDash: [3, 2] as readonly number[],
  cursorLabelPad: 3,
  cursorLabelRadius: 4,
  plannedDash: [2, 1.5] as readonly number[],
  recordStroke: 1.5,
  plannedCentre: 1.5,
  completedRadius: 2,
  /** Semantic zoom (8.12): titles at z ≥ 0.88, codes at z ≥ 0.73, world plate at z ≥ 0.86. */
  zoom: { titles: 0.88, codes: 0.73, worldPlate: 0.86 },
  /** Long-edge stubs (8.10): 3+ visible lanes apart or more than 320 world px apart vertically; the stub paths come from routes.ts. */
  stub: { source: 14, target: 10, terminal: 1.5, laneSpan: 3, maxDy: 320 },
  /** Below the code threshold the out-port is the dot's right edge + 1 (cx + r + 1). */
  dotPortGap: 1,
  junction: { radius: 3.5, stroke: 1.5 },
  /** Label layout (8.6), relative to the dot centre. */
  label: { codeFull: -8, titleFull: 8.5, codeCompact: 0.5, halfFull: 15.5, halfCompact: 8, knockoutPad: 3 },
  plate: { offsetX: 18, radius: 6, creditAlpha: 0.75 },
  washColumnPad: 6,
  overflowLabelMin: 30,
}

type LabelClass = Exclude<DisplayClass, 'hidden' | 'mini'>
type Glyph = 'disc' | 'hollow' | 'focus' | RecordStatus

export interface Ring {
  r: number
  width: number
  color: string
  /** Stroke opacity (1 when omitted). */
  alpha?: number
}

export interface NodeDraw {
  index: number
  visible: boolean
  cls: DisplayClass
  role: NodeRole
  /** World radius of the state glyph. */
  r: number
  glyph: Glyph
  color: string
  rings: Ring[]
  parity: 0 | 1
  labelled: boolean
  label: LabelText | null
  labelX: number
  codeColor: string
  /** Label box (world). */
  boxY0: number
  boxY1: number
}

export interface EdgeDraw {
  segs: PathSegment[]
  /**
   * Below the code threshold (z < 0.73, labels hidden) the edge starts at the source dot: a
   * straight lead from (cx + r + 1, cy) to the first point. Null for minis, the focus and paths
   * that do not start on the source row.
   */
  lead: { x: number; y: number } | null
  /** Layout edge index (Topology.edges) for edge, stub and hover draws; -1 for bundle and fork shapes. */
  edge: number
  x0: number
  y0: number
  x1: number
  y1: number
}

interface StrokeGroup {
  color: string
  width: number
  dashed: boolean
  edges: EdgeDraw[]
}

export interface Junction {
  x: number
  y: number
  members: number[]
}

export interface PlateDraw {
  index: number
  layout: PlateLayout
  /** World rect of the plate (world mode). */
  x: number
  y: number
}

export interface OverflowLabel {
  x: number
  y: number
  text: string
  parity: 0 | 1
}

export interface SceneInput {
  topology: Topology
  geometry: Geometry
  presentation: Presentation
  routes: Routes
  text: LabelMeasurer
  tokens: RenderTokens
  focus: number
  programActive: boolean
  showAllEdges: boolean
  /** Draw edges at all (false during geometry tweens). */
  edges?: boolean
  options?: GeometryOptions
}

export interface Scene {
  input: SceneInput
  options: GeometryOptions
  /** Edges of the faint picture (edges and stubs): their wrapped-track row gaps are planned together. */
  planWith: number[]
  world: World
  nodes: NodeDraw[]
  /** Visible rank of each lane in display order; -1 when collapsed. */
  laneRank: Int32Array
  /** Lanes whose top separator is a division rule. */
  divisionStart: boolean[]
  faint: StrokeGroup[]
  stubs: EdgeDraw[]
  stubDots: { x: number; y: number }[]
  /** Layer 7 (transitive, then program) and layer 8 (direct, bundles, forks). */
  routeLayers: [StrokeGroup[], StrokeGroup[]]
  junctions: Junction[]
  plate: PlateDraw | null
  wash: { row: Rect; col: Rect } | null
  programWash: boolean
  overflowLabels: OverflowLabel[]
  recordActive: boolean
}

export interface FrameState {
  view: View
  plot: Plot
  /** Canvas size in CSS px. */
  width: number
  height: number
  dpr: number
  hover: number
  cursor: number
  hoverEdges: { solid: EdgeDraw[]; dashed: EdgeDraw[] } | null
  /** Motion: label and chain-edge opacity (1 without motion). */
  labelAlpha: number
  edgeAlpha: number
}

export interface FrameStats {
  ms: number
  nodes: number
  edges: number
  labels: number
}

const isChainRole = (role: NodeRole) => role !== 'none' && role !== 'program'

/** The options the geometry was laid out with (geometry.ts owns the values), unless overridden. */
export function renderOptions(geometry: Geometry, options?: GeometryOptions): GeometryOptions {
  return options ?? geometryOptions(geometry)
}

// ---------------------------------------------------------------------------
// Node styles (7.1-7.3)

/**
 * Glyph, radius, colours and rings of one node (7.1-7.3). Program courses get the amber ring in
 * program mode and, compact, outside the chain during a selection (owner decision 19.7); program
 * courses drawn as minis keep a faint amber ring.
 */
export function nodeStyle(i: number, input: SceneInput, recordActive: boolean): Pick<NodeDraw, 'r' | 'glyph' | 'color' | 'rings' | 'codeColor'> {
  const { presentation: p, tokens: t, focus, programActive } = input
  const role = p.role[i]
  const cls = p.cls[i]
  const R = RENDER.radius
  let r = cls === 'full' ? R.full : cls === 'mini' ? R.mini : R.compact
  let glyph: Glyph = 'disc'
  let color = cls === 'mini' ? t.nodeMini : t.nodeDefault
  let codeColor = t.ink
  const rings: Ring[] = []
  if (cls === 'mini') {
    const ring = RENDER.ring.programMini
    if (programActive && p.inProgram[i]) rings.push({ r: R.mini + ring.offset, width: ring.width, color: t.nodeProgram, alpha: ring.alpha })
    return { r: R.mini, glyph: 'disc', color: t.nodeMini, rings, codeColor }
  }
  switch (role) {
    case 'focus':
      if (programActive && p.inProgram[i]) {
        rings.push({ r: R.focusKnockout + RENDER.ring.programChain.offset, width: RENDER.ring.programChain.width, color: t.nodeProgram })
      }
      return { r: R.focusRing, glyph: 'focus', color: t.nodeSelectedRing, rings, codeColor }
    case 'prereq-direct':
      r = R.direct
      color = t.nodePrereqDirect
      codeColor = t.preInk
      break
    case 'unlock-direct':
      r = R.direct
      color = t.nodeUnlockDirect
      codeColor = t.unlInk
      break
    case 'prereq':
      r = R.transitive
      glyph = 'hollow'
      color = t.nodePrereqTransitive
      break
    case 'unlock':
      r = R.transitive
      glyph = 'hollow'
      color = t.nodeUnlockTransitive
      break
    case 'program':
      // Program mode: full + ring. During a selection: compact amber + ring (7.3, 19.7).
      color = t.nodeProgram
      r = focus >= 0 && cls !== 'full' ? R.programOutside : R.program
      rings.push({ r: r + RENDER.ring.program.offset, width: RENDER.ring.program.width, color: t.nodeProgram })
      break
    default:
      break
  }
  if (programActive && focus >= 0 && p.inProgram[i] && isChainRole(role)) {
    rings.push({ r: r + RENDER.ring.programChain.offset, width: RENDER.ring.programChain.width, color: t.nodeProgram })
  }
  const record = p.record[i]
  if (record) {
    glyph = record
    if (role === 'none') color = record === 'completed' ? t.nodeCompleted : record === 'inProgress' ? t.nodeInProgress : t.nodePlanned
  }
  if (recordActive && record !== 'completed' && record !== 'inProgress' && p.eligibility[i] === 'met') {
    const ring = rings.length ? RENDER.ring.availableOuter : RENDER.ring.available
    rings.push({ r: r + ring.offset, width: ring.width, color: t.nodeAvailable })
  }
  return { r, glyph, color, rings, codeColor }
}

// ---------------------------------------------------------------------------
// Edge paths. Anchors and curves (8.7), including the wrapped-track detours, and the long-edge
// stubs (8.10) come from plainEdgePaths / plainEdgeStubs in routes.ts: the same maths as routed
// edges. This module only adds the low-zoom lead and groups paths for stroking.

type Point = { x: number; y: number }

/** Left edge of a node's track (the dot sits dotInset to its right). */
function trackLeft(scene: Pick<Scene, 'options'>, cx: number): number {
  return cx - scene.options.dotInset
}

function columnOf(input: SceneInput, i: number) {
  return input.geometry.columns[input.topology.nodes[i].col]
}

export function edgeDraw(segs: PathSegment[], lead: Point | null = null, edge = -1): EdgeDraw {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  const add = (x: number, y: number) => {
    if (x < x0) x0 = x
    if (x > x1) x1 = x
    if (y < y0) y0 = y
    if (y > y1) y1 = y
  }
  if (lead) add(lead.x, lead.y)
  for (const s of segs) {
    if (s.op === 'C') {
      add(s.x1, s.y1)
      add(s.x2, s.y2)
    }
    add(s.x, s.y)
  }
  return { segs, lead, edge, x0, y0, x1, y1 }
}

/**
 * Low-zoom out-port (finding: edges floating a track-width right of their dots when codes are
 * hidden): a lead from cx + r + 1 to the path start, for labelled sources whose path leaves on
 * their own row. The focus keeps its plate, minis already start at cx + 3.
 */
function sourceLead(scene: Pick<Scene, 'input' | 'nodes'>, from: number, first: PathSegment | undefined): Point | null {
  const n = scene.nodes[from]
  if (!first || !n?.labelled || n.glyph === 'focus') return null
  const box = scene.input.geometry.nodes[from]
  const x = box.cx + n.r + RENDER.dotPortGap
  if (Math.abs(first.y - box.cy) > 0.5 || first.x <= x + 0.5) return null
  return { x, y: box.cy }
}

/** Long overview edge (8.10): 3 or more visible lanes apart, or more than 320 world px apart vertically. */
export function isLongEdge(scene: Pick<Scene, 'input' | 'laneRank'>, e: number): boolean {
  const { topology, geometry } = scene.input
  const { from, to } = topology.edges[e]
  const ra = scene.laneRank[topology.nodes[from].lane]
  const rb = scene.laneRank[topology.nodes[to].lane]
  return Math.abs(ra - rb) >= RENDER.stub.laneSpan || Math.abs(geometry.nodes[to].cy - geometry.nodes[from].cy) > RENDER.stub.maxDy
}

function edgeColor(role: EdgeRole, t: RenderTokens): string {
  switch (role) {
    case 'prereq-direct': return t.edgePrereqDirect
    case 'prereq': return t.edgePrereqTransitive
    case 'unlock-direct': return t.edgeUnlockDirect
    case 'unlock': return t.edgeUnlockTransitive
    case 'program': return t.edgeProgram
    default: return t.edgeUnrelated
  }
}

/** Screen width of a routed path (3.3); forced colours draw transitive edges at 1 px (12). */
export function routeWidth(role: EdgeRole, shape: Routes['paths'][number]['shape'], forced = false): number {
  const E = RENDER.edge
  if (shape === 'trunk') return E.trunk
  if (shape === 'branch') return E.branch
  if (shape === 'fork') return E.fork
  if (role === 'prereq-direct' || role === 'unlock-direct') return E.direct
  if (role === 'program') return E.program
  return forced ? 1 : E.transitive
}

function lastPoint(segs: readonly PathSegment[]): Point | null {
  const s = segs[segs.length - 1]
  return s ? { x: s.x, y: s.y } : null
}

// ---------------------------------------------------------------------------
// Scene

export function labelGeometry(scene: Pick<Scene, 'options'>, box: { cx: number; cy: number }, cls: LabelClass) {
  const L = RENDER.label
  const half = cls === 'full' ? L.halfFull : L.halfCompact
  return { x: box.cx - scene.options.dotInset + scene.options.labelX, y0: box.cy - half, y1: box.cy + half }
}

export function buildScene(input: SceneInput): Scene {
  const { topology, geometry, presentation: p, tokens: t, focus } = input
  const options = renderOptions(geometry, input.options)
  const recordActive = p.record.some(r => r !== null)
  const base = { options }

  const laneRank = new Int32Array(topology.lanes.length).fill(-1)
  const divisionStart: boolean[] = []
  let rank = 0
  let lastDivision: string | null = null
  topology.lanes.forEach((lane, i) => {
    const box = geometry.lanes[i]
    divisionStart.push(false)
    if (!box || box.collapsed || box.h <= 0) return
    laneRank[i] = rank++
    if (lastDivision !== null && lane.division !== lastDivision) divisionStart[i] = true
    lastDivision = lane.division
  })

  const nodes: NodeDraw[] = topology.nodes.map((node, i) => {
    const box = geometry.nodes[i]
    const cls = box?.cls ?? 'hidden'
    const visible = cls !== 'hidden' && !box.overflow
    const labelled = visible && (cls === 'full' || cls === 'compact')
    const style = visible ? nodeStyle(i, input, recordActive) : { r: 0, glyph: 'disc' as Glyph, color: t.nodeMini, rings: [], codeColor: t.ink }
    const isFocus = i === focus
    const label = labelled ? input.text.labelText(i, cls as LabelClass, isFocus) : null
    const lg = labelled ? labelGeometry(base, box, cls as LabelClass) : { x: 0, y0: 0, y1: 0 }
    return {
      index: i,
      visible,
      cls,
      role: p.role[i],
      ...style,
      parity: (node.band & 1) as 0 | 1,
      labelled,
      label,
      labelX: lg.x,
      boxY0: lg.y0,
      boxY1: lg.y1,
    }
  })

  const scene: Scene = {
    input,
    options,
    world: { originX: options.laneHeaderWidth, originY: options.bandHeaderHeight, width: geometry.width, height: geometry.height },
    nodes,
    laneRank,
    divisionStart,
    faint: [],
    stubs: [],
    stubDots: [],
    planWith: [],
    routeLayers: [[], []],
    junctions: [],
    plate: null,
    wash: null,
    programWash: input.programActive && focus < 0,
    overflowLabels: [],
    recordActive,
  }

  if (input.edges !== false) {
    buildFaint(scene)
    buildRoutes(scene)
  }

  if (focus >= 0 && nodes[focus]?.visible) {
    const box = geometry.nodes[focus]
    const layout = input.text.plate(focus, 'world')
    const left = trackLeft(scene, box.cx)
    scene.plate = { index: focus, layout, x: left + RENDER.plate.offsetX, y: box.cy - layout.height / 2 }
    const col = columnOf(input, focus)
    const rowH = Math.max(layout.height, box.h)
    const trackW = col.trackW || col.w
    scene.wash = {
      row: { x: scene.world.originX, y: box.cy - rowH / 2, w: geometry.width - scene.world.originX, h: rowH },
      col: { x: left - RENDER.washColumnPad, y: scene.world.originY, w: trackW + 2 * RENDER.washColumnPad, h: geometry.height - scene.world.originY },
    }
  }

  buildOverflowLabels(scene)
  return scene
}

function buildFaint(scene: Scene): void {
  const { input } = scene
  const { topology, presentation: p, tokens: t, geometry } = input
  const overview = !p.dimming
  const stubsOn = overview && !input.showAllEdges
  const color = overview ? t.edgeFaint : t.edgeUnrelated
  const width = overview ? RENDER.edge.faint : RENDER.edge.unrelated
  const solid: StrokeGroup = { color, width, dashed: false, edges: [] }
  const dashed: StrokeGroup = { color, width, dashed: true, edges: [] }
  const full: number[] = []
  const long: number[] = []
  topology.edges.forEach((edge, e) => {
    if (p.edgeRole[e] !== 'faint' || !scene.nodes[edge.from].visible || !scene.nodes[edge.to].visible) return
    ;(stubsOn && isLongEdge(scene, e) ? long : full).push(e)
  })
  // Faint edges and stubs start at the out-port: no leader (8.7). Both take their wrapped-track
  // row-gap sides from the whole picture, so a gap never carries two edges that meet in one column.
  // A dense wrapped cell may have no free gap slot for an anchor: the faint edge then stops at the
  // column edge with a terminal dot rather than meet an edge of the other direction in one gap.
  const planWith = [...full, ...long]
  scene.planWith = planWith
  const cuts: Point[] = []
  const options = { presentation: p, planWith, truncateUnplaced: true, onTruncate: (_e: number, x: number, y: number) => cuts.push({ x, y }) }
  const paths = full.length ? plainEdgePaths(topology, geometry, full, options) : []
  full.forEach((e, k) => {
    const edge = topology.edges[e]
    ;(edge.kind === 'coreq' ? dashed : solid).edges.push(edgeDraw(paths[k], sourceLead(scene, edge.from, paths[k][0]), e))
  })
  const stubs = long.length ? plainEdgeStubs(topology, geometry, long, options) : []
  long.forEach((e, k) => {
    const { source, target } = stubs[k]
    if (source.length) {
      scene.stubs.push(edgeDraw(source, sourceLead(scene, topology.edges[e].from, source[0]), e))
      const end = source[source.length - 1]
      scene.stubDots.push({ x: end.x, y: end.y })
    }
    if (target.length) {
      scene.stubs.push(edgeDraw(target, null, e))
      scene.stubDots.push({ x: target[0].x, y: target[0].y })
    }
  })
  scene.stubDots.push(...cuts)
  scene.faint = [solid, dashed].filter(group => group.edges.length)
}

function buildRoutes(scene: Scene): void {
  const { routes, tokens: t, topology } = scene.input
  const layers: [Map<string, StrokeGroup>, Map<string, StrokeGroup>] = [new Map(), new Map()]
  const transitiveOrder = (role: EdgeRole) => (role === 'program' ? 1 : 0)
  const forks: { x: number; y: number }[] = []
  for (const path of routes.paths) {
    if (path.role === 'hidden' || path.role === 'faint' || !path.segments.length) continue
    const direct = path.role === 'prereq-direct' || path.role === 'unlock-direct' || path.shape !== 'edge'
    const color = edgeColor(path.role, t)
    const width = routeWidth(path.role, path.shape, t.forced)
    const dashed = path.kind === 'coreq' && path.shape !== 'fork'
    const key = `${direct ? 0 : transitiveOrder(path.role)}|${color}|${width}|${dashed}`
    const layer = layers[direct ? 1 : 0]
    let group = layer.get(key)
    if (!group) {
      group = { color, width, dashed, edges: [] }
      layer.set(key, group)
    }
    group.edges.push(edgeDraw(path.segments, routeLead(scene, path), path.edge))
    if (path.shape === 'fork') {
      const first = path.segments[0]
      forks.push({ x: first.x, y: first.y })
    }
  }
  // Layer 7: transitive groups first, then program groups.
  const sortTransitive = [...layers[0].entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([, g]) => g)
  scene.routeLayers = [sortTransitive, [...layers[1].values()]]
  scene.junctions = forks.map(fork => {
    const members: number[] = []
    for (const path of routes.paths) {
      if (path.shape !== 'edge' || path.role !== 'prereq-direct' || path.edge < 0) continue
      const end = lastPoint(path.segments)
      if (end && Math.abs(end.x - fork.x) <= 1 && Math.abs(end.y - fork.y) <= 1) members.push(topology.edges[path.edge].from)
    }
    return { x: fork.x, y: fork.y, members }
  })
}

/** Slim lanes: "+n" after a cell's single row of minis when 30 px or more stay free (8.4). */
function buildOverflowLabels(scene: Scene): void {
  const { topology, geometry } = scene.input
  topology.lanes.forEach((lane, li) => {
    if (!geometry.lanes[li]?.slim) return
    topology.cells[li].forEach((cell, col) => {
      let hidden = 0
      let last = -1
      for (const v of cell) {
        const box = geometry.nodes[v]
        if (!box || box.cls === 'hidden') continue
        if (box.overflow) hidden++
        else if (last < 0 || box.cx > geometry.nodes[last].cx) last = v
      }
      if (!hidden || last < 0) return
      const column = geometry.columns[col]
      const lastBox = geometry.nodes[last]
      const free = column.x + column.w - (lastBox.cx + RENDER.radius.mini)
      if (free < RENDER.overflowLabelMin) return
      scene.overflowLabels.push({ x: lastBox.cx + RENDER.radius.mini + 4, y: lastBox.cy, text: `+${hidden}`, parity: (topology.nodes[last].band & 1) as 0 | 1 })
    })
  })
}

/**
 * Low-zoom lead of a routed path: plain edges and prerequisite-fan branches leave their source
 * node on its row; trunks, unlock branches and forks start at bundle points or the focus.
 */
function routeLead(scene: Scene, path: Routes['paths'][number]): Point | null {
  if (path.edge < 0 || (path.shape !== 'edge' && !(path.shape === 'branch' && path.role === 'prereq-direct'))) return null
  return sourceLead(scene, scene.input.topology.edges[path.edge].from, path.segments[0])
}

/**
 * Hover preview (8.10): every visible edge of one node at full length, as plain anchored curves
 * (no corridors, for speed) with the highlighted-edge leader.
 */
export function hoverEdges(scene: Scene, index: number): FrameState['hoverEdges'] {
  if (index < 0) return null
  const { topology, presentation: p, geometry } = scene.input
  const list: number[] = []
  topology.edges.forEach((edge, e) => {
    if (edge.from !== index && edge.to !== index) return
    if (p.edgeRole[e] === 'hidden') return
    if (scene.nodes[edge.from].visible && scene.nodes[edge.to].visible) list.push(e)
  })
  if (!list.length) return null
  // Same row-gap sides as the faint picture underneath (the same plan, made once per scene), plus
  // this node's own edges where some are not in it (Show all connections off during a selection).
  const drawn = new Set(scene.planWith)
  const planWith = list.every(e => drawn.has(e)) ? scene.planWith : [...scene.planWith, ...list.filter(e => !drawn.has(e))]
  const paths = plainEdgePaths(topology, geometry, list, { presentation: p, leader: true, planWith })
  const solid: EdgeDraw[] = []
  const dashed: EdgeDraw[] = []
  list.forEach((e, k) => {
    const edge = topology.edges[e]
    ;(edge.kind === 'coreq' ? dashed : solid).push(edgeDraw(paths[k], sourceLead(scene, edge.from, paths[k][0]), e))
  })
  return { solid, dashed }
}

// ---------------------------------------------------------------------------
// Geometry helpers shared with the view (framing, pills, overlays)

/** Union of the dot box and label box of a node (plate for the focus), world px. */
export function nodeRect(scene: Scene, i: number): Rect {
  const box = scene.input.geometry.nodes[i]
  const draw = scene.nodes[i]
  if (scene.plate && scene.plate.index === i) {
    const k = RENDER.radius.focusKnockout
    const x0 = Math.min(box.cx - k, scene.plate.x)
    const y0 = Math.min(box.cy - k, scene.plate.y)
    const x1 = Math.max(box.cx + k, scene.plate.x + scene.plate.layout.width)
    const y1 = Math.max(box.cy + k, scene.plate.y + scene.plate.layout.height)
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
  }
  const r = draw.r + (draw.rings.length ? draw.rings[draw.rings.length - 1].r - draw.r : 0)
  const x0 = box.cx - r
  let y0 = box.cy - r
  let x1 = box.cx + r
  let y1 = box.cy + r
  if (draw.labelled && draw.label) {
    x1 = Math.max(x1, draw.labelX + draw.label.width)
    y0 = Math.min(y0, draw.boxY0)
    y1 = Math.max(y1, draw.boxY1)
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

export function unionRects(rects: readonly Rect[], pad = 0): Rect | null {
  if (!rects.length) return null
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const r of rects) {
    x0 = Math.min(x0, r.x)
    y0 = Math.min(y0, r.y)
    x1 = Math.max(x1, r.x + r.w)
    y1 = Math.max(y1, r.y + r.h)
  }
  return { x: x0 - pad, y: y0 - pad, w: x1 - x0 + 2 * pad, h: y1 - y0 + 2 * pad }
}

// ---------------------------------------------------------------------------
// Frame

interface Xf {
  z: number
  ox: number
  oy: number
  dpr: number
}

/** Paints the selection wash again inside `clip` (knockouts would otherwise punch holes in it). */
type Rewash = (clip: Path2D) => void

const X = (xf: Xf, x: number) => xf.ox + x * xf.z
const Y = (xf: Xf, y: number) => xf.oy + y * xf.z

/** Appends an edge; below the code threshold a lead from the source dot replaces the path's first move. */
function addEdge(path: Path2D, e: EdgeDraw, xf: Xf, lowZoom: boolean): void {
  const lead = lowZoom ? e.lead : null
  if (lead) path.moveTo(X(xf, lead.x), Y(xf, lead.y))
  e.segs.forEach((s, i) => {
    if (s.op === 'C') path.bezierCurveTo(X(xf, s.x1), Y(xf, s.y1), X(xf, s.x2), Y(xf, s.y2), X(xf, s.x), Y(xf, s.y))
    else if (s.op === 'M' && !(lead && i === 0)) path.moveTo(X(xf, s.x), Y(xf, s.y))
    else path.lineTo(X(xf, s.x), Y(xf, s.y))
  })
}

interface Cull {
  x0: number
  y0: number
  x1: number
  y1: number
}

const intersects = (e: EdgeDraw, c: Cull) => e.x1 >= c.x0 && e.x0 <= c.x1 && e.y1 >= c.y0 && e.y0 <= c.y1

/** One Path2D per group, stroked once with an opaque colour (3.3). */
function strokeEdges(ctx: CanvasRenderingContext2D, edges: readonly EdgeDraw[], color: string, width: number, dashed: boolean, xf: Xf, cull: Cull, lowZoom: boolean): number {
  const path = new Path2D()
  let count = 0
  for (const e of edges) {
    if (!intersects(e, cull)) continue
    addEdge(path, e, xf, lowZoom)
    count++
  }
  if (!count) return 0
  ctx.strokeStyle = color
  ctx.lineWidth = Math.max(width, 1 / xf.dpr)
  ctx.setLineDash(dashed ? RENDER.coreqDash : [])
  ctx.lineCap = dashed ? 'butt' : 'round'
  ctx.stroke(path)
  return count
}

/**
 * Lane separator snapped to device pixels (8.13): the centre y and stroke width of a `width` CSS px
 * rule whose bottom edge lies on the device-pixel boundary nearest `v`, so it covers the same
 * pixels as the lane column's `border-bottom` (and the division rule's ::before).
 */
export function separatorLine(v: number, width: number, dpr: number): { y: number; width: number } {
  const device = Math.max(1, Math.round(width * dpr))
  return { y: (Math.round(v * dpr) - device / 2) / dpr, width: device / dpr }
}

const snap = (v: number, dpr: number) => Math.round(v * dpr) / dpr

function screenRadius(r: number, z: number, mini: boolean): number {
  return Math.max(r * z, mini ? RENDER.minScreenRadius.mini : RENDER.minScreenRadius.labelled)
}

/** Ring offsets scale with zoom like radii, but never collapse onto the dot. */
function ringOffset(offset: number, z: number): number {
  return Math.max(offset * z, offset * 0.6)
}

export function drawScene(ctx: CanvasRenderingContext2D, scene: Scene, frame: FrameState): FrameStats {
  const started = performance.now()
  const { view, plot, dpr } = frame
  const { input, nodes } = scene
  const { geometry, tokens: t } = input
  const z = view.zoom
  const xf: Xf = { z, ox: plot.left - view.x * z, oy: plot.top - view.y * z, dpr }
  const margin = 24 / z
  const cull: Cull = { x0: view.x - margin, y0: view.y - margin, x1: view.x + plot.width / z + margin, y1: view.y + plot.height / z + margin }
  const stats: FrameStats = { ms: 0, nodes: 0, edges: 0, labels: 0 }
  const bg = [t.surface, t.band]

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, frame.width, frame.height)
  ctx.save()
  ctx.beginPath()
  ctx.rect(plot.left, plot.top, plot.width, plot.height)
  ctx.clip()

  // 1-2. Surface and odd-band washes.
  ctx.fillStyle = t.surface
  ctx.fillRect(plot.left, plot.top, plot.width, plot.height)
  ctx.fillStyle = t.band
  const contentBottom = Math.min(plot.top + plot.height, Y(xf, geometry.height))
  input.topology.bands.forEach((band, b) => {
    const box = geometry.bands[b]
    if (!box?.visible || !(band.index & 1)) return
    const x0 = snap(X(xf, box.x), dpr)
    const x1 = snap(X(xf, box.x + box.w), dpr)
    if (x1 < plot.left || x0 > plot.left + plot.width) return
    ctx.fillRect(x0, plot.top, x1 - x0, contentBottom - plot.top)
  })

  // Visible nodes (culled once for every pass).
  const visible: NodeDraw[] = []
  for (const n of nodes) {
    if (!n.visible) continue
    const box = geometry.nodes[n.index]
    const right = n.labelled && n.label ? n.labelX + n.label.width + 4 : box.cx + n.r + 8
    if (right < cull.x0 || box.cx - 16 > cull.x1 || box.cy + 20 < cull.y0 || box.cy - 20 > cull.y1) continue
    visible.push(n)
  }
  stats.nodes = visible.length
  const showCodes = z >= RENDER.zoom.codes
  const showTitles = z >= RENDER.zoom.titles

  // 3. The --prog-wash on program label boxes is painted right after the label knockouts (11),
  //    which would otherwise cover it.

  // 4. Selection row and column wash. Knockouts (mini halos, labels, dots, junctions, the focus)
  //    fill with the plain band colour, so the wash is painted again over them, clipped to them.
  const paintWash = () => {
    if (!scene.wash) return
    const { row, col } = scene.wash
    ctx.fillStyle = t.selWash
    ctx.fillRect(plot.left, Y(xf, row.y), plot.width, row.h * z)
    ctx.fillRect(X(xf, col.x), plot.top, col.w * z, contentBottom - plot.top)
  }
  const rewash: Rewash | null = scene.wash
    ? clip => {
      const alpha = ctx.globalAlpha
      ctx.save()
      ctx.globalAlpha = 1
      ctx.clip(clip)
      paintWash()
      ctx.restore()
      ctx.globalAlpha = alpha
    }
    : null
  paintWash()

  // 5. Lane separators and division rules.
  drawLaneRules(ctx, scene, xf, plot)

  // 6-9. Edges.
  stats.edges += drawEdges(ctx, scene, frame, xf, cull, !showCodes, rewash)

  // 10. Mini dots: halo then dot, batched by band parity.
  const minis = visible.filter(n => n.cls === 'mini')
  if (minis.length) {
    const r = screenRadius(RENDER.radius.mini, z, true)
    for (const parity of [0, 1] as const) {
      const path = new Path2D()
      let any = false
      for (const n of minis) {
        if (n.parity !== parity) continue
        const box = geometry.nodes[n.index]
        const x = X(xf, box.cx)
        const y = Y(xf, box.cy)
        path.moveTo(x + r + RENDER.miniHalo, y)
        path.arc(x, y, r + RENDER.miniHalo, 0, Math.PI * 2)
        any = true
      }
      if (any) {
        ctx.fillStyle = bg[parity]
        ctx.fill(path)
        rewash?.(path)
      }
    }
    const dots = new Path2D()
    for (const n of minis) {
      const box = geometry.nodes[n.index]
      const x = X(xf, box.cx)
      const y = Y(xf, box.cy)
      dots.moveTo(x + r, y)
      dots.arc(x, y, r, 0, Math.PI * 2)
    }
    ctx.fillStyle = t.nodeMini
    ctx.fill(dots)
    strokeRings(ctx, minis, r, xf, geometry)
  }

  const labelled = visible.filter(n => n.labelled && n.index !== scene.plate?.index)

  // 11. Label knockouts (two passes by parity), then the selection wash again over them. In
  //     program mode the --prog-wash of program label boxes (layer 3) goes on top of them.
  if (showCodes && labelled.length) {
    const pad = RENDER.label.knockoutPad
    const programs = scene.programWash ? new Path2D() : null
    for (const parity of [0, 1] as const) {
      const path = new Path2D()
      let any = false
      for (const n of labelled) {
        if (n.parity !== parity || !n.label) continue
        const w = labelWidth(n, showTitles)
        const y0 = showTitles || n.cls !== 'full' ? n.boxY0 : geometry.nodes[n.index].cy - RENDER.label.halfCompact - 8
        const y1 = showTitles || n.cls !== 'full' ? n.boxY1 : geometry.nodes[n.index].cy
        path.rect(X(xf, n.labelX - pad), Y(xf, y0), (w + 2 * pad) * z, (y1 - y0) * z)
        if (programs && input.presentation.inProgram[n.index]) programs.rect(X(xf, n.labelX - pad), Y(xf, n.boxY0), (w + 2 * pad) * z, (n.boxY1 - n.boxY0) * z)
        any = true
      }
      if (!any) continue
      ctx.globalAlpha = RENDER.knockoutAlpha
      ctx.fillStyle = bg[parity]
      ctx.fill(path)
      ctx.globalAlpha = 1
      rewash?.(path)
    }
    if (programs) {
      ctx.fillStyle = t.progWash
      ctx.fill(programs)
    }
  }

  // 12. Labelled dots, record glyphs and rings.
  drawLabelledDots(ctx, scene, labelled, xf, bg, rewash)

  // 13. Labels: codes, then titles; slim-lane "+n".
  if (showCodes) stats.labels = drawLabels(ctx, scene, labelled, xf, showTitles, frame.labelAlpha)

  // 14. Hover ring.
  if (frame.hover >= 0 && nodes[frame.hover]?.visible) {
    const n = nodes[frame.hover]
    const box = geometry.nodes[n.index]
    const ring = RENDER.ring.hover
    ctx.setLineDash([])
    ctx.strokeStyle = t.ink3
    ctx.lineWidth = Math.max(ring.width, 1 / dpr)
    ctx.beginPath()
    ctx.arc(X(xf, box.cx), Y(xf, box.cy), screenRadius(n.r, z, n.cls === 'mini') + ringOffset(ring.offset, z), 0, Math.PI * 2)
    ctx.stroke()
  }

  // 15. Focus glyph and plate.
  if (scene.plate) drawFocus(ctx, scene, scene.plate, xf, bg, frame, rewash)

  // 16. Keyboard cursor.
  if (frame.cursor >= 0 && nodes[frame.cursor]?.visible) drawCursor(ctx, scene, frame.cursor, xf, showCodes, showTitles)

  ctx.restore()
  stats.ms = performance.now() - started
  return stats
}

function labelWidth(n: NodeDraw, showTitles: boolean): number {
  if (!n.label) return 0
  return showTitles ? n.label.width : n.label.codeWidth
}

function drawLaneRules(ctx: CanvasRenderingContext2D, scene: Scene, xf: Xf, plot: Plot): void {
  const { geometry, tokens: t } = scene.input
  const thin = new Path2D()
  const strong = new Path2D()
  const x0 = plot.left
  const x1 = Math.min(plot.left + plot.width, X(xf, geometry.width))
  let lastBottom = -1
  geometry.lanes.forEach((lane, i) => {
    if (scene.laneRank[i] < 0) return
    const y = Y(xf, lane.y + lane.h)
    lastBottom = y
    if (scene.laneRank[i] > 0) {
      const top = Y(xf, lane.y)
      if (top >= plot.top - 2 && top <= plot.top + plot.height + 2) {
        const { y } = separatorLine(top, scene.divisionStart[i] ? 1.5 : 1, xf.dpr)
        const path = scene.divisionStart[i] ? strong : thin
        path.moveTo(x0, y)
        path.lineTo(x1, y)
      }
    }
  })
  if (lastBottom >= plot.top && lastBottom <= plot.top + plot.height + 2) {
    const { y } = separatorLine(lastBottom, 1, xf.dpr)
    thin.moveTo(x0, y)
    thin.lineTo(x1, y)
  }
  ctx.setLineDash([])
  ctx.lineCap = 'butt'
  ctx.strokeStyle = t.line
  ctx.lineWidth = separatorLine(0, 1, xf.dpr).width
  ctx.stroke(thin)
  ctx.strokeStyle = t.ruleStrong
  ctx.lineWidth = separatorLine(0, 1.5, xf.dpr).width
  ctx.stroke(strong)
}

function drawEdges(ctx: CanvasRenderingContext2D, scene: Scene, frame: FrameState, xf: Xf, cull: Cull, lowZoom: boolean, rewash: Rewash | null): number {
  const { tokens: t } = scene.input
  let count = 0
  // 6. Faint edges, stubs (with terminal dots), unrelated edges.
  for (const group of scene.faint) count += strokeEdges(ctx, group.edges, group.color, group.width, group.dashed, xf, cull, lowZoom)
  if (scene.stubs.length) {
    count += strokeEdges(ctx, scene.stubs, t.edgeFaint, RENDER.edge.faint, false, xf, cull, lowZoom)
    const dots = new Path2D()
    const r = RENDER.stub.terminal
    for (const d of scene.stubDots) {
      if (d.x < cull.x0 || d.x > cull.x1 || d.y < cull.y0 || d.y > cull.y1) continue
      const x = X(xf, d.x)
      const y = Y(xf, d.y)
      dots.moveTo(x + r, y)
      dots.arc(x, y, r, 0, Math.PI * 2)
    }
    ctx.fillStyle = t.edgeFaint
    ctx.fill(dots)
  }
  // 7-8. Chain / program routes (opacity only during the motion fade-in).
  ctx.globalAlpha = frame.edgeAlpha
  for (const layer of scene.routeLayers) {
    for (const group of layer) count += strokeEdges(ctx, group.edges, group.color, group.width, group.dashed, xf, cull, lowZoom)
  }
  if (scene.junctions.length) {
    const J = RENDER.junction
    for (const j of scene.junctions) {
      const disc = new Path2D()
      disc.arc(X(xf, j.x), Y(xf, j.y), Math.max(J.radius * xf.z, 2), 0, Math.PI * 2)
      ctx.fillStyle = t.surface
      ctx.fill(disc)
      rewash?.(disc)
      ctx.setLineDash([])
      ctx.strokeStyle = t.nodePrereqDirect
      ctx.lineWidth = J.stroke
      ctx.stroke(disc)
    }
  }
  ctx.globalAlpha = 1
  // 9. Hover preview.
  if (frame.hoverEdges) {
    count += strokeEdges(ctx, frame.hoverEdges.solid, t.edgeHover, RENDER.edge.hover, false, xf, cull, lowZoom)
    count += strokeEdges(ctx, frame.hoverEdges.dashed, t.edgeHover, RENDER.edge.hover, true, xf, cull, lowZoom)
  }
  ctx.setLineDash([])
  return count
}

function drawLabelledDots(ctx: CanvasRenderingContext2D, scene: Scene, list: readonly NodeDraw[], xf: Xf, bg: string[], rewash: Rewash | null): void {
  if (!list.length) return
  const { geometry, tokens: t } = scene.input
  const z = xf.z
  const pos = (n: NodeDraw) => ({ x: X(xf, geometry.nodes[n.index].cx), y: Y(xf, geometry.nodes[n.index].cy) })
  // Knockout discs at r + 1.25 in the band colour, so curves pass visibly behind the dots.
  for (const parity of [0, 1] as const) {
    const path = new Path2D()
    let any = false
    for (const n of list) {
      if (n.parity !== parity) continue
      const { x, y } = pos(n)
      const r = screenRadius(n.r, z, false) + RENDER.dotKnockout
      path.moveTo(x + r, y)
      path.arc(x, y, r, 0, Math.PI * 2)
      any = true
    }
    if (any) {
      ctx.fillStyle = bg[parity]
      ctx.fill(path)
      rewash?.(path)
    }
  }
  // Filled discs grouped by colour.
  const discs = new Map<string, Path2D>()
  const hollow = new Map<string, Path2D>()
  const hollowFill = new Path2D()
  const records: NodeDraw[] = []
  for (const n of list) {
    const { x, y } = pos(n)
    const r = screenRadius(n.r, z, false)
    if (n.glyph === 'disc') {
      let path = discs.get(n.color)
      if (!path) discs.set(n.color, (path = new Path2D()))
      path.moveTo(x + r, y)
      path.arc(x, y, r, 0, Math.PI * 2)
    } else if (n.glyph === 'hollow') {
      let path = hollow.get(n.color)
      if (!path) hollow.set(n.color, (path = new Path2D()))
      const rr = r - RENDER.hollowStroke / 2
      path.moveTo(x + rr, y)
      path.arc(x, y, rr, 0, Math.PI * 2)
      hollowFill.moveTo(x + r, y)
      hollowFill.arc(x, y, r, 0, Math.PI * 2)
    } else {
      records.push(n)
    }
  }
  for (const [color, path] of discs) {
    ctx.fillStyle = color
    ctx.fill(path)
  }
  if (hollow.size) {
    ctx.fillStyle = t.surface
    ctx.fill(hollowFill)
    ctx.setLineDash([])
    ctx.lineWidth = RENDER.hollowStroke
    for (const [color, path] of hollow) {
      ctx.strokeStyle = color
      ctx.stroke(path)
    }
  }
  for (const n of records) drawRecordGlyph(ctx, n, pos(n), screenRadius(n.r, z, false), t)
  // Program and available rings, grouped by colour, width and opacity.
  strokeRings(ctx, list, null, xf, geometry)
}

/** Strokes the rings of `list`, one path per colour / width / opacity; `base` fixes the screen radius (minis). */
function strokeRings(ctx: CanvasRenderingContext2D, list: readonly NodeDraw[], base: number | null, xf: Xf, geometry: Geometry): void {
  const rings = new Map<string, { ring: Ring; path: Path2D }>()
  for (const n of list) {
    if (!n.rings.length) continue
    const box = geometry.nodes[n.index]
    const x = X(xf, box.cx)
    const y = Y(xf, box.cy)
    const r0 = base ?? screenRadius(n.r, xf.z, false)
    for (const ring of n.rings) {
      const key = `${ring.color}|${ring.width}|${ring.alpha ?? 1}`
      let entry = rings.get(key)
      if (!entry) rings.set(key, (entry = { ring, path: new Path2D() }))
      const r = r0 + ringOffset(ring.r - n.r, xf.z)
      entry.path.moveTo(x + r, y)
      entry.path.arc(x, y, r, 0, Math.PI * 2)
    }
  }
  if (!rings.size) return
  ctx.setLineDash([])
  for (const { ring, path } of rings.values()) {
    ctx.globalAlpha = ring.alpha ?? 1
    ctx.strokeStyle = ring.color
    ctx.lineWidth = ring.width
    ctx.stroke(path)
  }
  ctx.globalAlpha = 1
}

function drawRecordGlyph(ctx: CanvasRenderingContext2D, n: NodeDraw, p: { x: number; y: number }, r: number, t: RenderTokens): void {
  ctx.setLineDash([])
  const w = RENDER.recordStroke
  if (n.glyph === 'completed') {
    const side = 2 * r + 1
    ctx.fillStyle = n.color
    ctx.beginPath()
    ctx.roundRect(p.x - side / 2, p.y - side / 2, side, side, RENDER.completedRadius)
    ctx.fill()
    ctx.strokeStyle = t.surface
    ctx.lineWidth = w
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.beginPath()
    ctx.moveTo(p.x - side * 0.27, p.y + side * 0.02)
    ctx.lineTo(p.x - side * 0.07, p.y + side * 0.22)
    ctx.lineTo(p.x + side * 0.28, p.y - side * 0.2)
    ctx.stroke()
    return
  }
  if (n.glyph === 'inProgress') {
    ctx.fillStyle = t.surface
    ctx.beginPath()
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = n.color
    ctx.beginPath()
    ctx.arc(p.x, p.y, r, Math.PI / 2, (Math.PI * 3) / 2)
    ctx.closePath()
    ctx.fill()
    ctx.strokeStyle = n.color
    ctx.lineWidth = w
    ctx.beginPath()
    ctx.arc(p.x, p.y, r - w / 2, 0, Math.PI * 2)
    ctx.stroke()
    return
  }
  // Planned: dashed circle plus a centre dot.
  ctx.fillStyle = t.surface
  ctx.beginPath()
  ctx.arc(p.x, p.y, r, 0, Math.PI * 2)
  ctx.fill()
  ctx.strokeStyle = n.color
  ctx.lineWidth = w
  ctx.setLineDash(RENDER.plannedDash)
  ctx.beginPath()
  ctx.arc(p.x, p.y, r - w / 2, 0, Math.PI * 2)
  ctx.stroke()
  ctx.setLineDash([])
  ctx.fillStyle = n.color
  ctx.beginPath()
  ctx.arc(p.x, p.y, RENDER.plannedCentre, 0, Math.PI * 2)
  ctx.fill()
}

function drawLabels(ctx: CanvasRenderingContext2D, scene: Scene, list: readonly NodeDraw[], xf: Xf, showTitles: boolean, alpha: number): number {
  const { geometry, tokens: t } = scene.input
  const text = scene.input.text
  const L = RENDER.label
  // Text is set at world size under a world transform, so widths match the measured labels.
  ctx.save()
  ctx.setTransform(xf.dpr * xf.z, 0, 0, xf.dpr * xf.z, xf.dpr * xf.ox, xf.dpr * xf.oy)
  ctx.globalAlpha = alpha
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  ctx.font = text.font(TEXT.code)
  let count = 0
  const byColor = new Map<string, { code: string; labelX: number; cls: DisplayClass; index: number }[]>()
  for (const n of list) {
    if (!n.label) continue
    let bucket = byColor.get(n.codeColor)
    if (!bucket) byColor.set(n.codeColor, (bucket = []))
    bucket.push({ code: n.label.code, labelX: n.labelX, cls: n.cls, index: n.index })
  }
  for (const [color, bucket] of byColor) {
    ctx.fillStyle = color
    for (const n of bucket) {
      const cy = geometry.nodes[n.index].cy
      ctx.fillText(n.code, n.labelX, cy + (n.cls === 'full' ? L.codeFull : L.codeCompact))
      count++
    }
  }
  if (showTitles) {
    ctx.font = text.font(TEXT.title)
    ctx.fillStyle = t.ink2
    for (const n of list) {
      if (!n.label?.title) continue
      ctx.fillText(n.label.title, n.labelX, geometry.nodes[n.index].cy + L.titleFull)
    }
  }
  if (scene.overflowLabels.length) {
    ctx.font = text.font(TEXT.overflow)
    ctx.fillStyle = t.ink3
    for (const o of scene.overflowLabels) ctx.fillText(o.text, o.x, o.y)
  }
  ctx.restore()
  return count
}

function drawFocus(ctx: CanvasRenderingContext2D, scene: Scene, plate: PlateDraw, xf: Xf, bg: string[], frame: FrameState, rewash: Rewash | null): void {
  const { geometry, tokens: t } = scene.input
  const box = geometry.nodes[plate.index]
  const n = scene.nodes[plate.index]
  const z = xf.z
  const x = X(xf, box.cx)
  const y = Y(xf, box.cy)
  const R = RENDER.radius
  const ringR = screenRadius(R.focusRing, z, false)
  const knock = ringR + ringOffset(R.focusKnockout - R.focusRing, z)
  ctx.setLineDash([])
  const disc = new Path2D()
  disc.arc(x, y, knock, 0, Math.PI * 2)
  ctx.fillStyle = bg[n.parity]
  ctx.fill(disc)
  rewash?.(disc)
  ctx.save()
  if (t.dark && !t.forced) {
    ctx.shadowBlur = RENDER.glowBlur
    ctx.shadowColor = t.selGlow
  }
  ctx.strokeStyle = t.nodeSelectedRing
  ctx.lineWidth = RENDER.focusRingWidth
  ctx.beginPath()
  ctx.arc(x, y, ringR - RENDER.focusRingWidth / 2, 0, Math.PI * 2)
  ctx.stroke()
  ctx.restore()
  ctx.fillStyle = t.nodeSelectedRing
  ctx.beginPath()
  ctx.arc(x, y, Math.max(R.focusCentre * z, 1.5), 0, Math.PI * 2)
  ctx.fill()
  for (const ring of n.rings) {
    ctx.strokeStyle = ring.color
    ctx.lineWidth = ring.width
    ctx.beginPath()
    ctx.arc(x, y, knock + ringOffset(ring.r - R.focusKnockout, z), 0, Math.PI * 2)
    ctx.stroke()
  }

  ctx.globalAlpha = frame.labelAlpha
  if (z >= RENDER.zoom.worldPlate) {
    ctx.save()
    ctx.setTransform(xf.dpr * z, 0, 0, xf.dpr * z, xf.dpr * xf.ox, xf.dpr * xf.oy)
    paintPlate(ctx, scene, plate.layout, plate.x, plate.y, t)
    ctx.restore()
  } else {
    const layout = scene.input.text.plate(plate.index, 'screen')
    const left = x + knock + 2
    ctx.save()
    ctx.setTransform(xf.dpr, 0, 0, xf.dpr, 0, 0)
    paintPlate(ctx, scene, layout, left, y - layout.height / 2, t)
    ctx.restore()
  }
  ctx.globalAlpha = 1
}

function paintPlate(ctx: CanvasRenderingContext2D, scene: Scene, layout: PlateLayout, x: number, y: number, t: RenderTokens): void {
  const m = layout.metrics
  const text = scene.input.text
  ctx.fillStyle = t.selPlate
  ctx.beginPath()
  ctx.roundRect(x, y, layout.width, layout.height, RENDER.plate.radius)
  ctx.fill()
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  ctx.fillStyle = t.selPlateInk
  const tx = x + m.padX
  const codeY = y + m.padY + m.codeLine / 2
  ctx.font = text.font(m.code)
  ctx.fillText(layout.code, tx, codeY)
  if (layout.credit) {
    ctx.save()
    ctx.globalAlpha *= RENDER.plate.creditAlpha
    ctx.font = text.font(m.credit)
    ctx.fillText(layout.credit, tx + layout.codeWidth + m.creditGap, codeY + 0.5)
    ctx.restore()
  }
  ctx.font = text.font(m.title)
  layout.lines.forEach((line, k) => {
    ctx.fillText(line, tx, y + m.padY + m.codeLine + m.lineHeight * k + m.lineHeight / 2)
  })
}

function drawCursor(ctx: CanvasRenderingContext2D, scene: Scene, index: number, xf: Xf, showCodes: boolean, showTitles: boolean): void {
  const { geometry, tokens: t } = scene.input
  const n = scene.nodes[index]
  const box = geometry.nodes[index]
  const ring = RENDER.ring.cursor
  const z = xf.z
  const baseR = n.glyph === 'focus' ? screenRadius(RENDER.radius.focusKnockout, z, false) : screenRadius(n.r, z, n.cls === 'mini')
  ctx.strokeStyle = t.focusRing
  ctx.lineWidth = ring.width
  ctx.setLineDash(RENDER.cursorDash)
  ctx.beginPath()
  ctx.arc(X(xf, box.cx), Y(xf, box.cy), baseR + ringOffset(ring.offset, z), 0, Math.PI * 2)
  ctx.stroke()
  ctx.setLineDash([])
  if (!showCodes || !n.labelled || !n.label || n.glyph === 'focus') return
  const pad = RENDER.cursorLabelPad
  const w = labelWidth(n, showTitles)
  const y0 = showTitles || n.cls !== 'full' ? n.boxY0 : box.cy - RENDER.label.halfCompact - 8
  const y1 = showTitles || n.cls !== 'full' ? n.boxY1 : box.cy
  ctx.beginPath()
  ctx.roundRect(X(xf, n.labelX) - pad, Y(xf, y0) - pad, w * z + 2 * pad, (y1 - y0) * z + 2 * pad, RENDER.cursorLabelRadius)
  ctx.stroke()
}

// ---------------------------------------------------------------------------
// Motion (17): node centres, boxes and lane / column / band boxes interpolate between geometries.

const mix = (a: number, b: number, t: number) => a + (b - a) * t

export function interpolateGeometry(from: Geometry, to: Geometry, t: number): Geometry {
  if (t >= 1) return to
  const nodes = to.nodes.map((b, i) => {
    const a = from.nodes[i]
    if (!a || a.cls === 'hidden' || b.cls === 'hidden') return b
    return { ...b, x: mix(a.x, b.x, t), y: mix(a.y, b.y, t), w: mix(a.w, b.w, t), h: mix(a.h, b.h, t), cx: mix(a.cx, b.cx, t), cy: mix(a.cy, b.cy, t) }
  })
  const lanes = to.lanes.map((b, i) => {
    const a = from.lanes[i]
    return a ? { ...b, y: mix(a.y, b.y, t), h: mix(a.h, b.h, t) } : b
  })
  const columns = to.columns.map((b, i) => {
    const a = from.columns[i]
    return a ? { ...b, x: mix(a.x, b.x, t), w: mix(a.w, b.w, t), trackW: mix(a.trackW, b.trackW, t) } : b
  })
  const bands = to.bands.map((b, i) => {
    const a = from.bands[i]
    return a ? { ...b, x: mix(a.x, b.x, t), w: mix(a.w, b.w, t) } : b
  })
  return { nodes, lanes, columns, bands, width: mix(from.width, to.width, t), height: mix(from.height, to.height, t) }
}
