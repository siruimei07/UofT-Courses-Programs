// The graph view (contract: src/graph/canvas-types.ts). Owns the canvas, the DOM overlays (lane
// column, band bar, corner, scrollbars + ruler, edge-of-view pills, tooltip), pointer / wheel /
// keyboard interaction, the keyboard cursor and the live region. View state lives in refs and
// every change is coalesced into one requestAnimationFrame redraw; React re-renders only when the
// data or the language changes.
import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { FocusEvent as ReactFocusEvent, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react'
import { actions, appStore, useApp } from '../app/store'
import { format, formatNumber, useLang, useStrings } from '../i18n'
import type { GraphCanvasHandle, GraphCanvasProps } from './canvas-types'
import { DEFAULT_GEOMETRY_OPTIONS } from './geometry'
import { buildHitGrid, cursorCandidates, hitTest, laneEdgeCursor, moveCursor, startCursor, type Direction, type NavContext } from './hittest'
import { bandCounts, laneCounts } from './overlays/counts'
import { BandBar } from './overlays/BandBar'
import { Corner } from './overlays/Corner'
import { EdgePills } from './overlays/EdgePills'
import { createFrameBus } from './overlays/frame'
import { LaneColumn, type LaneAction } from './overlays/LaneColumn'
import { Scrollbars } from './overlays/Scrollbars'
import { Tooltip, type RelationTone, type TooltipState } from './overlays/Tooltip'
import {
  buildScene, drawScene, hoverEdges, nodeRect, overlayGeometry, overlayRowsChange, tweenScene, unionRects,
  type FrameStats, type Scene, type SceneInput,
} from './renderer'
import { DIVISION_STRINGS, GRAPH_STRINGS, type GraphStrings } from './strings'
import { createLabelMeasure, isLabelMeasurer, useTextMetricsVersion } from './text'
import { readTokens, type RenderTokens } from './tokens'
import type { Geometry, NodeRole } from './types'
import * as V from './viewport'
import './graph.css'

const OPT = DEFAULT_GEOMETRY_OPTIONS
const DRAG_SLOP = 3
const ANCHOR_TTL = 1500
const FRAME_TTL = 1000
const CURSOR_MARGIN = 48
const KEY_PAN = 80
const LANE_JUMP_TOP = 8
const LANE_MARK_TOP = 24
const CHAIN_PAD = 12
const MOTION = V.MOTION
/** One frame at 60 Hz: the first animation frame of a motion shows at most this much of it. */
const FRAME_MS = 1000 / 60

const CHAIN_ROLES: ReadonlySet<NodeRole> = new Set<NodeRole>(['focus', 'prereq-direct', 'prereq', 'unlock-direct', 'unlock'])

interface Anchor {
  kind: 'select' | 'clear' | 'frame'
  /** Node whose screen position is kept. */
  index: number
  /** Expected focus after the change (-1 for clear). */
  target: number
  screen: V.Point
  until: number
}

interface Drag {
  id: number
  x: number
  y: number
  lastX: number
  lastY: number
  moved: boolean
}

/** A geometry change in flight (17): the scene it started from and the scene it ends on. */
interface GeometryTween {
  start: number
  from: Scene
  to: Scene
  /** Opacity of the labels on screen when it started (an interrupting tween fades them from there). */
  labelStart: number
}

/** Which part of a motion sequence a frame belongs to (development diagnostics). */
type FramePhase = 'geometry' | 'fade' | 'view' | 'idle'

interface Mutable {
  view: V.View
  width: number
  height: number
  dpr: number
  hover: number
  hoverJunction: number
  hoverEdges: ReturnType<typeof hoverEdges>
  cursor: number
  keyboard: boolean
  pointer: V.Point | null
  drag: Drag | null
  anchor: Anchor | null
  pendingFrame: { target: 'chain' | 'program'; until: number } | null
  raf: number
  scaleKey: string
  sceneVersion: number
  tipTimer: number
  /** Geometry tween with its label and edge fades; animated pan / zoom; focus glyph and hover ring fades. */
  geo: GeometryTween | null
  pan: V.ViewMotion | null
  focusAt: number | null
  hoverAt: number | null
  /**
   * Motions started since the last animation frame. A state change keeps the main thread busy after
   * its commit (panels, effects); their clocks start on the first animation frame instead (at most
   * one frame in), so a slow commit never swallows the start of a tween.
   */
  unarmed: Set<'geo' | 'pan' | 'focus'>
  /** Geometry is still interpolating (edges hidden, pills held). */
  moving: boolean
  /**
   * The first view request (landing: lane, hash course or program) and everything before it is
   * instant, so the map never opens with a pan across other lanes; so is everything before the
   * first user input. Set by that request or by any pointer, key or wheel input.
   */
  landed: boolean
  /** Overlay rows are being kept for lanes / bands / columns that change visibility in a tween. */
  overlayHeld: boolean
  prevScene: Scene | null
  prevFocus: number | null
  /** Scene of the last drawn frame (a tween scene while geometry interpolates) and its label opacity. */
  shown: Scene | null
  shownLabels: number
}

/** Development-only diagnostics (frame timings and the current view) for harnesses and perf tests. */
type StatsWindow = typeof globalThis & {
  __courseMapFrames?: (FrameStats & { total: number; phase: FramePhase; at: number })[]
  __courseMapView?: { view: V.View; plot: V.Plot }
}

/** The layout of the last drawn frame: its geometry (tracks, boxes) and topology. */
interface DrawnLayout {
  geometry: Geometry
  topology: GraphCanvasProps['topology']
}

let drawnLayout: DrawnLayout | null = null

// Layout diagnostics in every build (architecture rule 3, the hard product rule): a read-only
// `__courseMapLayout` getter returns the geometry and topology of the last drawn frame, so the
// end-to-end checks can verify node by node, on the production build, that no column wraps while a
// course is selected and every edge runs left to right. It exposes nothing beyond what the canvas
// draws and cannot be assigned.
if (typeof globalThis !== 'undefined' && !Object.getOwnPropertyDescriptor(globalThis, '__courseMapLayout')) {
  Object.defineProperty(globalThis, '__courseMapLayout', { get: () => drawnLayout, configurable: true, enumerable: false })
}

let reducedMotionQuery: MediaQueryList | null | undefined

/** prefers-reduced-motion, read live (one MediaQueryList, its `matches` follows the setting). */
function reducedMotion(): boolean {
  if (reducedMotionQuery === undefined) {
    reducedMotionQuery = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : null
  }
  return reducedMotionQuery?.matches ?? false
}

/** Tweens and animated pans (17): only with the motion prop and without prefers-reduced-motion. */
function motionAllowed(enabled: boolean | undefined): boolean {
  return !!enabled && typeof window !== 'undefined' && !reducedMotion()
}

/** Opacity fades of 100 ms or less (the 80 ms hover ring) remain under prefers-reduced-motion (17). */
function shortFadesAllowed(enabled: boolean | undefined): boolean {
  return !!enabled && MOTION.hover.ring <= MOTION.reducedFadeMax
}

function plotOf(width: number, height: number): V.Plot {
  return {
    left: OPT.laneHeaderWidth,
    top: OPT.bandHeaderHeight,
    width: Math.max(0, width - OPT.laneHeaderWidth),
    height: Math.max(0, height - OPT.bandHeaderHeight),
  }
}

function sameTokens(a: RenderTokens, b: RenderTokens): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** Recomputed geometry with identical boxes (e.g. an edge-only toggle): no anchoring, no tween. */
function sameLayout(a: Geometry, b: Geometry): boolean {
  if (a === b) return true
  if (a.width !== b.width || a.height !== b.height || a.nodes.length !== b.nodes.length) return false
  for (let i = 0; i < a.nodes.length; i++) {
    const p = a.nodes[i]
    const q = b.nodes[i]
    if (p.cx !== q.cx || p.cy !== q.cy || p.cls !== q.cls || p.w !== q.w || p.overflow !== q.overflow) return false
  }
  return a.lanes.every((lane, i) => lane.y === b.lanes[i].y && lane.h === b.lanes[i].h)
}

function levelOf(level: number): number {
  return Math.max(100, Math.floor(level / 100) * 100)
}

function relationOf(role: NodeRole, inProgram: boolean, focus: number, programActive: boolean, s: GraphStrings): { text: string; tone: RelationTone } | null {
  if (focus >= 0) {
    switch (role) {
      case 'focus': return { text: s.relFocus, tone: 'focus' }
      case 'prereq-direct': return { text: s.relPrereqDirect, tone: 'pre' }
      case 'prereq': return { text: s.relPrereq, tone: 'pre' }
      case 'unlock-direct': return { text: s.relUnlockDirect, tone: 'unl' }
      case 'unlock': return { text: s.relUnlock, tone: 'unl' }
      case 'program': return { text: s.relProgram, tone: 'prog' }
      default: return { text: s.relNone, tone: 'none' }
    }
  }
  if (programActive && inProgram) return { text: s.relProgram, tone: 'prog' }
  return null
}

export function GraphCanvas(props: GraphCanvasProps) {
  const { dataset, topology, presentation, geometry, routes, measure, theme, programActive, ref } = props
  const strings = useStrings(GRAPH_STRINGS)
  const lang = useLang()
  const divisionLabels = useStrings(DIVISION_STRINGS) as Record<string, string>
  const showAllEdges = useApp(state => state.showAllEdges)
  const metricsVersion = useTextMetricsVersion()

  const rootRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const bus = useMemo(createFrameBus, [])
  const s = useRef<Mutable>({
    view: { zoom: 1, x: OPT.laneHeaderWidth, y: OPT.bandHeaderHeight },
    width: 0,
    height: 0,
    dpr: 1,
    hover: -1,
    hoverJunction: -1,
    hoverEdges: null,
    cursor: -1,
    keyboard: false,
    pointer: null,
    drag: null,
    anchor: null,
    pendingFrame: null,
    raf: 0,
    scaleKey: '',
    sceneVersion: 0,
    tipTimer: 0,
    geo: null,
    pan: null,
    focusAt: null,
    hoverAt: null,
    unarmed: new Set(),
    moving: false,
    landed: false,
    overlayHeld: false,
    prevScene: null,
    prevFocus: null,
    shown: null,
    shownLabels: 1,
  }).current

  const [tokens, setTokens] = useState<RenderTokens>(() => readTokens(theme))
  const [tip, setTip] = useState<TooltipState | null>(null)
  const [live, setLive] = useState('')
  const [area, setArea] = useState({ width: 0, height: 0 })
  /** Layout a running tween started from, while it changes which lanes / bands / columns are visible. */
  const [overlayFrom, setOverlayFrom] = useState<Geometry | null>(null)

  useLayoutEffect(() => {
    const refresh = () => setTokens(prev => {
      const next = readTokens(theme)
      return sameTokens(prev, next) ? prev : next
    })
    refresh()
    // <html data-theme> may settle after this render (system theme listeners run in any order).
    const raf = requestAnimationFrame(refresh)
    const forced = window.matchMedia('(forced-colors: active)')
    forced.addEventListener('change', refresh)
    return () => {
      cancelAnimationFrame(raf)
      forced.removeEventListener('change', refresh)
    }
  }, [theme])

  const text = useMemo(
    () => (isLabelMeasurer(measure) && measure.version === metricsVersion ? measure : createLabelMeasure(topology, dataset)),
    [measure, topology, dataset, metricsVersion],
  )
  const focus = useMemo(() => presentation.role.indexOf('focus'), [presentation])
  const sceneInput = useMemo<SceneInput>(() => ({
    topology, geometry, presentation, routes, text, tokens, focus, programActive, showAllEdges,
  }), [topology, geometry, presentation, routes, text, tokens, focus, programActive, showAllEdges])
  const scene = useMemo(() => buildScene(sceneInput), [sceneInput])
  const grid = useMemo(() => buildHitGrid(geometry), [geometry])
  const lanes = useMemo(() => laneCounts(topology, presentation), [topology, presentation])
  const bands = useMemo(() => bandCounts(topology, presentation, geometry), [topology, presentation, geometry])
  // While a tween collapses or reveals lanes, bands or columns, the lane column and band bar keep
  // their rows until it ends, so they shrink or grow with the canvas (17).
  const overlayGeo = useMemo(
    () => (overlayFrom && overlayFrom.nodes.length === geometry.nodes.length ? overlayGeometry(overlayFrom, geometry) : geometry),
    [overlayFrom, geometry],
  )

  const pillTargets = useMemo<V.PillTarget[]>(() => {
    const out: V.PillTarget[] = []
    presentation.role.forEach((role, i) => {
      if (!scene.nodes[i]?.visible || i === focus) return
      const box = geometry.nodes[i]
      if (focus >= 0) {
        if (role === 'prereq' || role === 'prereq-direct') out.push({ x: box.cx, y: box.cy, box: nodeRect(scene, i), kind: 'pre' })
        else if (role === 'unlock' || role === 'unlock-direct') out.push({ x: box.cx, y: box.cy, box: nodeRect(scene, i), kind: 'unl' })
      } else if (programActive && presentation.inProgram[i]) {
        out.push({ x: box.cx, y: box.cy, box: nodeRect(scene, i), kind: 'prog' })
      }
    })
    return out
  }, [scene, presentation, geometry, focus, programActive])
  const pillAnchor = useMemo(() => (focus >= 0 && geometry.nodes[focus] ? { x: geometry.nodes[focus].cx, y: geometry.nodes[focus].cy } : null), [focus, geometry])

  // Latest render data for event handlers and the frame loop.
  const latest = useRef({ props, scene, sceneInput, grid, strings, focus, pillTargets })
  useLayoutEffect(() => {
    latest.current = { props, scene, sceneInput, grid, strings, focus, pillTargets }
  })

  // -------------------------------------------------------------------------
  // Frame loop

  /** Overlay rows kept for a tween are released when its geometry stops moving. */
  const releaseOverlays = useCallback(() => {
    if (!s.overlayHeld) return
    s.overlayHeld = false
    setOverlayFrom(null)
  }, [s])

  /**
   * Re-hit-tests the resting pointer once the layout and the view have settled: pointer moves during
   * a geometry tween are not hit-tested (the end layout is not on screen yet), and a pan moves the
   * map under a still pointer.
   */
  const refreshHover = useRef<() => void>(() => {})

  /** Ends every motion at once: the view jumps to its target, geometry to its end, fades to full (17). */
  const finishMotion = useCallback(() => {
    const was = !!(s.pan || s.geo)
    if (s.pan) {
      s.view = V.viewMotionEnd(s.pan)
      s.pan = null
    }
    if (s.geo) {
      s.geo = null
      s.sceneVersion++
    }
    s.moving = false
    s.focusAt = null
    s.hoverAt = null
    releaseOverlays()
    if (was) refreshHover.current()
  }, [s, releaseOverlays])

  const draw = useCallback((timestamp?: number) => {
    s.raf = 0
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx || !s.width || !s.height) return
    const L = latest.current
    const started = performance.now()
    // First animation frame of motions started since the last one (drawNow passes no timestamp).
    if (timestamp !== undefined && s.unarmed.size) {
      const earliest = started - FRAME_MS
      if (s.geo && s.unarmed.has('geo')) s.geo.start = Math.max(s.geo.start, earliest)
      if (s.pan && s.unarmed.has('pan')) s.pan.start = Math.max(s.pan.start, earliest)
      if (s.focusAt !== null && s.unarmed.has('focus')) s.focusAt = Math.max(s.focusAt, earliest)
      s.unarmed.clear()
    }
    const plot = plotOf(s.width, s.height)
    // prefers-reduced-motion switched on mid-sequence: finish it now.
    if ((s.geo || s.pan || s.focusAt !== null) && !motionAllowed(L.props.motion)) finishMotion()
    let current = L.scene
    const settling = !!(s.geo && s.moving) || !!s.pan
    let labelAlpha = 1
    let edgeAlpha = 1
    let transitiveAlpha = 1
    let animating = false
    let phase: FramePhase = 'idle'
    if (s.geo) {
      const g = V.geometryPhase(started - s.geo.start, s.geo.labelStart)
      if (g.moving) {
        current = tweenScene(s.geo.from, s.geo.to, g.t, g.labels)
        labelAlpha = g.labelAlpha
        phase = 'geometry'
      } else {
        edgeAlpha = g.direct
        transitiveAlpha = g.transitive
        phase = 'fade'
      }
      if (s.moving && !g.moving) releaseOverlays()
      s.moving = g.moving
      if (g.done) s.geo = null
      else animating = true
    }
    if (s.pan) {
      const p = V.viewAt(s.pan, started, plot)
      s.view = p.view
      if (p.done) s.pan = null
      else animating = true
      if (phase === 'idle' && !p.done) phase = 'view'
    }
    let focusScale = 1
    let plateAlpha = 1
    if (s.focusAt !== null) {
      const f = V.focusPhase(started - s.focusAt)
      focusScale = f.scale
      plateAlpha = f.plate
      if (f.done) s.focusAt = null
      else animating = true
    }
    let hoverAlpha = 1
    if (s.hoverAt !== null) {
      hoverAlpha = V.progress(started - s.hoverAt, 0, MOTION.hover.ring)
      if (hoverAlpha >= 1) s.hoverAt = null
      else animating = true
    }
    const view = s.view
    const focused = typeof document !== 'undefined' && document.activeElement === rootRef.current
    const stats = drawScene(ctx, current, {
      view,
      plot,
      width: s.width,
      height: s.height,
      dpr: s.dpr,
      hover: s.hover,
      cursor: s.keyboard && focused ? s.cursor : -1,
      // The hover preview belongs to the settled layout; it waits while dots are still moving.
      hoverEdges: s.moving ? null : s.hoverEdges,
      labelAlpha,
      edgeAlpha,
      transitiveAlpha,
      hoverAlpha,
      focusScale,
      plateAlpha,
    })
    if (current.input.geometry !== s.shown?.input.geometry) s.sceneVersion++
    s.shown = current
    s.shownLabels = labelAlpha
    const scaleKey = `${view.zoom}|${s.width}|${s.height}|${s.sceneVersion}`
    bus.emit({
      view,
      plot,
      width: s.width,
      height: s.height,
      geometry: current.input.geometry,
      scaleChanged: scaleKey !== s.scaleKey,
      moving: s.moving,
      toX: wx => V.toScreenX(view, plot, wx),
      toY: wy => V.toScreenY(view, plot, wy),
    })
    s.scaleKey = scaleKey
    if (drawnLayout?.geometry !== current.input.geometry) drawnLayout = { geometry: current.input.geometry, topology: current.input.topology }
    if (import.meta.env.DEV) {
      const w = globalThis as StatsWindow
      const frames = (w.__courseMapFrames ??= [])
      frames.push({ ...stats, total: performance.now() - started, phase, at: started })
      if (frames.length > 240) frames.splice(0, frames.length - 240)
      w.__courseMapView = { view, plot }
    }
    if (animating) s.raf = requestAnimationFrame(draw)
    // The layout stopped moving and the view stopped panning this frame: hover what is under the pointer.
    if (settling && !s.moving && !s.pan) refreshHover.current()
  }, [bus, s, finishMotion, releaseOverlays])

  const requestDraw = useCallback(() => {
    if (!s.raf) s.raf = requestAnimationFrame(draw)
  }, [draw, s])

  const drawNow = useCallback(() => {
    if (s.raf) cancelAnimationFrame(s.raf)
    draw()
  }, [draw, s])

  useEffect(() => () => {
    if (s.raf) cancelAnimationFrame(s.raf)
    window.clearTimeout(s.tipTimer)
  }, [s])

  const currentPlot = useCallback(() => plotOf(s.width, s.height), [s])

  /** Whether a view or geometry change may animate now (17): motion on, landed, not dragging. */
  const animates = useCallback(() => s.landed && !s.drag?.moved && motionAllowed(latest.current.props.motion), [s])

  /**
   * Every view change goes through here: clamp, report zoom, redraw. With `motion` (framing, lane
   * jumps, pill pans) it animates from the view on screen; the first such request (landing) and
   * anything during a drag is instant.
   */
  const setView = useCallback((next: V.View, motion?: { duration: number; ease: V.Ease }) => {
    const L = latest.current
    const target = V.clampView(next, L.scene.world, currentPlot())
    const before = s.pan ? V.viewMotionEnd(s.pan).zoom : s.view.zoom
    if (motion && animates()) {
      const now = performance.now()
      const geo = s.geo && s.moving ? s.geo : null
      if (geo && (s.unarmed.has('geo') || now - geo.start < FRAME_MS)) {
        // A framing request that comes with a geometry change (hash, search) shares its clock and
        // easing: with the pan on its own timing the lanes collapsing above swung the chain out of
        // the plot and back (visual QA). On one clock the focus slides straight to its frame.
        s.pan = { start: geo.start, from: s.view, to: target, duration: MOTION.geometry.duration, ease: MOTION.geometry.ease }
        if (s.unarmed.has('geo')) s.unarmed.add('pan')
      } else if (geo) {
        // Mid-tween: finish together with the geometry.
        const remaining = Math.max(MOTION.reducedFadeMax, geo.start + MOTION.geometry.duration - now)
        s.pan = { start: now, from: s.view, to: target, duration: remaining, ease: MOTION.geometry.ease }
        s.unarmed.add('pan')
      } else {
        s.pan = { start: now, from: s.view, to: target, duration: motion.duration, ease: motion.ease }
        s.unarmed.add('pan')
      }
    } else {
      s.pan = null
      s.view = target
    }
    if (motion) s.landed = true
    if (target.zoom !== before) L.props.onZoomChange?.(target.zoom)
    requestDraw()
  }, [currentPlot, requestDraw, animates, s])

  /** Any user input jumps every running motion to its end (17) and drops pending anchors and frames. */
  const settle = useCallback(() => {
    finishMotion()
    s.pendingFrame = null
    s.anchor = null
  }, [s, finishMotion])

  // Pointer and key input anywhere (toolbar, panel, search, shortcuts) counts as input: it ends the
  // landing phase and jumps a running tween to its end before the input's own effect starts.
  useEffect(() => {
    const onInput = () => {
      s.landed = true
      if (s.geo || s.pan || s.focusAt !== null) {
        finishMotion()
        requestDraw()
      }
    }
    window.addEventListener('pointerdown', onInput, true)
    window.addEventListener('keydown', onInput, true)
    return () => {
      window.removeEventListener('pointerdown', onInput, true)
      window.removeEventListener('keydown', onInput, true)
    }
  }, [s, finishMotion, requestDraw])

  // -------------------------------------------------------------------------
  // Framing (10.2)

  const frameTarget = useCallback((target: 'chain' | 'program', sc: Scene): V.View | null => {
    const plot = currentPlot()
    if (!plot.width || !plot.height) return null
    const { presentation: p, geometry: g } = sc.input
    const f = p.role.indexOf('focus')
    const rects = (pick: (i: number) => boolean) => {
      const list: V.Rect[] = []
      p.role.forEach((_, i) => {
        if (sc.nodes[i]?.visible && pick(i)) list.push(nodeRect(sc, i))
      })
      return list
    }
    if (target === 'chain' && f >= 0 && sc.nodes[f]?.visible) {
      const box = unionRects(rects(i => CHAIN_ROLES.has(p.role[i])), CHAIN_PAD)
      if (!box) return null
      const w1 = unionRects(rects(i => ['focus', 'prereq-direct', 'prereq', 'unlock-direct'].includes(p.role[i])))
      const w2 = unionRects(rects(i => ['focus', 'prereq-direct', 'unlock-direct'].includes(p.role[i])))
      const windows = [w1, w2].filter((w): w is V.Rect => w !== null)
      return V.frameView({ box, focus: { x: g.nodes[f].cx, y: g.nodes[f].cy }, windows }, plot)
    }
    if (target === 'program' || (target === 'chain' && f < 0)) {
      const box = unionRects(rects(i => p.inProgram[i]), CHAIN_PAD)
      return box ? V.frameView({ box }, plot) : null
    }
    return null
  }, [currentPlot])

  // -------------------------------------------------------------------------
  // Geometry changes: click anchoring (10.4), pending frames, generic anchoring, tweens.

  useLayoutEffect(() => {
    const prev = s.prevScene
    s.prevScene = scene
    s.sceneVersion++
    if (s.hover >= 0 && !scene.nodes[s.hover]?.visible) s.hover = -1
    s.hoverEdges = s.hover >= 0 && !scene.input.presentation.dimming ? hoverEdges(scene, s.hover) : null
    const now = performance.now()
    const nextFocus = scene.input.presentation.role.indexOf('focus')
    const prevFocus = prev ? prev.input.presentation.role.indexOf('focus') : -1
    const animate = animates() && !!prev && prev.input.topology === scene.input.topology
    // A newly selected course: its ring scales 0.6 → 1 and its plate fades in (17).
    const focusMotion = animate && nextFocus >= 0 && nextFocus !== prevFocus
    if (!prev || !s.width || sameLayout(prev.input.geometry, scene.input.geometry)) {
      // Same boxes (an edge-only toggle, the theme, the record): a running tween carries on towards
      // the new scene; theme changes are instant on the canvas.
      if (s.geo && prev && prev.input.topology === scene.input.topology) s.geo.to = scene
      if (focusMotion) {
        s.focusAt = now
        s.unarmed.add('focus')
      }
      requestDraw()
      return
    }
    const plot = currentPlot()
    const startView = s.pan ? V.viewMotionEnd(s.pan) : s.view
    let view = startView
    /** Click selection: the nudged view, reached on its own timing after anchoring (10.4, 17). */
    let nudged: V.View | null = null
    let handled = false
    // Anchoring follows the geometry tween exactly (same clock and easing); framing has its own.
    let motion: { duration: number; ease: V.Ease } = MOTION.geometry
    const anchor = s.anchor && s.anchor.until > now ? s.anchor : null
    if (anchor && (anchor.kind === 'clear' ? nextFocus < 0 : nextFocus === anchor.target)) {
      s.anchor = null
      const box = scene.input.geometry.nodes[anchor.index]
      if (box && box.cls !== 'hidden') {
        view = V.anchorView(view, plot, anchor.screen, { x: box.cx, y: box.cy })
        if (anchor.kind === 'select') {
          if (view.zoom < V.CLICK_MIN_ZOOM) view = V.zoomAround(view, V.FRAME_ZOOM_FLOOR, anchor.screen.x, anchor.screen.y, plot)
          view = V.clampView(view, scene.world, plot)
          const chain = unionRects(scene.nodes.filter(n => n.visible && CHAIN_ROLES.has(n.role)).map(n => nodeRect(scene, n.index)))
          if (chain) nudged = V.clampView(V.nudgeIntoView(view, plot, chain, nodeRect(scene, anchor.index)), scene.world, plot)
        }
        handled = true
      }
      if (anchor.kind === 'frame') {
        const framed = frameTarget('chain', scene)
        if (framed) {
          view = framed
          nudged = null
          motion = MOTION.frame
          handled = true
        }
      }
    }
    if (!handled && s.pendingFrame && s.pendingFrame.until > now) {
      const framed = frameTarget(s.pendingFrame.target, scene)
      if (framed) {
        // Applied once: later geometry changes (toolbar toggles) anchor instead of reframing.
        s.pendingFrame = null
        view = framed
        motion = MOTION.frame
        handled = true
      }
    }
    if (!handled) {
      // Keep the focus (or the node nearest the plot centre) where it was on screen.
      const prevGeometry = prev.input.geometry
      const nextGeometry = scene.input.geometry
      const onScreen = (i: number) => prev.nodes[i]?.visible && V.pointInPlot(startView, plot, { x: prevGeometry.nodes[i].cx, y: prevGeometry.nodes[i].cy })
      let ref = -1
      if (prevFocus >= 0 && scene.nodes[prevFocus]?.visible && onScreen(prevFocus)) {
        ref = prevFocus
      } else {
        const cx = V.toWorldX(startView, plot, plot.left + plot.width / 2)
        const cy = V.toWorldY(startView, plot, plot.top + plot.height / 2)
        let best = Infinity
        prev.nodes.forEach((n, i) => {
          if (!n.visible || !scene.nodes[i]?.visible) return
          const d = Math.abs(prevGeometry.nodes[i].cx - cx) + Math.abs(prevGeometry.nodes[i].cy - cy)
          if (d < best) {
            best = d
            ref = i
          }
        })
      }
      if (ref >= 0) {
        const screen = { x: V.toScreenX(startView, plot, prevGeometry.nodes[ref].cx), y: V.toScreenY(startView, plot, prevGeometry.nodes[ref].cy) }
        view = V.anchorView(view, plot, screen, { x: nextGeometry.nodes[ref].cx, y: nextGeometry.nodes[ref].cy })
      }
    }
    view = V.clampView(view, scene.world, plot)
    const final = nudged ?? view
    if (animate) {
      // An interrupted tween continues from what is on screen (positions, radii, label opacity).
      const from = s.geo && s.moving && s.shown ? s.shown : prev
      s.geo = { start: now, from, to: scene, labelStart: s.geo && s.moving ? s.shownLabels : 1 }
      s.moving = true
      // The pan runs on the geometry's clock and easing, framing included (a framing pan on its own
      // timing swung the chain out of the plot while lanes collapsed, visual QA).
      s.pan = {
        start: now,
        from: s.view,
        to: view,
        duration: MOTION.geometry.duration,
        ease: MOTION.geometry.ease,
        nudge: nudged && (nudged.x !== view.x || nudged.y !== view.y) ? { dx: nudged.x - view.x, dy: nudged.y - view.y, ...MOTION.nudge } : undefined,
      }
      s.unarmed.add('geo').add('pan')
      if (focusMotion) {
        s.focusAt = now
        s.unarmed.add('focus')
      } else if (nextFocus < 0) s.focusAt = null
      if (overlayRowsChange(from.input.geometry, scene.input.geometry)) {
        s.overlayHeld = true
        setOverlayFrom(from.input.geometry)
      }
    } else {
      finishMotion()
      s.view = final
    }
    // The first geometry framed for a pending request (landing on a hash course) ends the landing.
    if (handled && motion === MOTION.frame) s.landed = true
    if (final.zoom !== startView.zoom) latest.current.props.onZoomChange?.(final.zoom)
    drawNow()
  }, [scene, s, currentPlot, frameTarget, requestDraw, drawNow, animates, finishMotion])

  // Selection announcements and the keyboard cursor follow the focus.
  useEffect(() => {
    const was = s.prevFocus
    s.prevFocus = focus
    if (was === null || was === focus) return
    if (focus < 0) {
      setLive(strings.liveCleared)
      return
    }
    s.cursor = focus
    const roles = presentation.role
    const count = (...wanted: NodeRole[]) => roles.reduce((n, role) => n + (wanted.includes(role) ? 1 : 0), 0)
    setLive(format(strings.liveSelected, {
      code: topology.nodes[focus].code,
      pd: formatNumber(count('prereq-direct'), lang),
      pt: formatNumber(count('prereq-direct', 'prereq'), lang),
      ud: formatNumber(count('unlock-direct'), lang),
      ut: formatNumber(count('unlock-direct', 'unlock'), lang),
    }))
  }, [focus, presentation, topology, strings, lang, s])

  // -------------------------------------------------------------------------
  // Size, DPR, wheel

  useLayoutEffect(() => {
    const root = rootRef.current
    const canvas = canvasRef.current
    if (!root || !canvas) return
    const apply = () => {
      const width = root.clientWidth
      const height = root.clientHeight
      const dpr = window.devicePixelRatio || 1
      if (width === s.width && height === s.height && dpr === s.dpr) return
      s.width = width
      s.height = height
      s.dpr = dpr
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      const plot = plotOf(width, height)
      s.view = V.clampView(s.view, latest.current.scene.world, plot)
      s.sceneVersion++
      setArea({ width, height })
      latest.current.props.onPlotSize?.({ width: plot.width, height: plot.height })
      drawNow()
    }
    const observer = new ResizeObserver(apply)
    observer.observe(root)
    apply()
    let query: MediaQueryList | null = null
    const onResolution = () => {
      apply()
      watch()
    }
    const watch = () => {
      query?.removeEventListener('change', onResolution)
      query = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`)
      query.addEventListener('change', onResolution)
    }
    watch()
    return () => {
      observer.disconnect()
      query?.removeEventListener('change', onResolution)
    }
  }, [s, drawNow])

  const tipOpen = useRef(false)

  const hideTip = useCallback(() => {
    window.clearTimeout(s.tipTimer)
    s.tipTimer = 0
    // Hover changes and wheel frames call this constantly; only an open tooltip re-renders.
    if (tipOpen.current) {
      tipOpen.current = false
      setTip(null)
    }
  }, [s])

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const onWheel = (event: WheelEvent) => {
      if ((event.target as Element | null)?.closest?.('.gc-lane-menu, .gc-tooltip')) return
      event.preventDefault()
      s.landed = true
      settle()
      hideTip()
      const plot = currentPlot()
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? plot.height : 1
      const dx = event.deltaX * unit
      const dy = event.deltaY * unit
      if (event.ctrlKey || event.metaKey) {
        const rect = root.getBoundingClientRect()
        const factor = Math.exp(-dy * V.WHEEL_ZOOM_RATE)
        setView(V.zoomAround(s.view, s.view.zoom * factor, event.clientX - rect.left, event.clientY - rect.top, plot))
      } else if (event.shiftKey) {
        setView(V.scrollBy(s.view, dy || dx, 0))
      } else {
        setView(V.scrollBy(s.view, dx, dy))
      }
    }
    root.addEventListener('wheel', onWheel, { passive: false })
    return () => root.removeEventListener('wheel', onWheel)
  }, [s, settle, hideTip, currentPlot, setView])

  // -------------------------------------------------------------------------
  // Pointer

  const localPoint = (event: { clientX: number; clientY: number }): V.Point => {
    const rect = rootRef.current?.getBoundingClientRect()
    return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) }
  }

  const hitAt = useCallback((p: V.Point): number => {
    const plot = currentPlot()
    if (p.x < plot.left || p.y < plot.top || p.x > plot.left + plot.width || p.y > plot.top + plot.height) return -1
    const L = latest.current
    return hitTest(L.grid, L.sceneInput.geometry, V.toWorldX(s.view, plot, p.x), V.toWorldY(s.view, plot, p.y))
  }, [currentPlot, s])

  const junctionAt = useCallback((p: V.Point): number => {
    const plot = currentPlot()
    const junctions = latest.current.scene.junctions
    return junctions.findIndex(j => Math.hypot(V.toScreenX(s.view, plot, j.x) - p.x, V.toScreenY(s.view, plot, j.y) - p.y) <= 7)
  }, [currentPlot, s])

  const nodeScreen = useCallback((index: number): V.Point => {
    const plot = currentPlot()
    const box = latest.current.sceneInput.geometry.nodes[index]
    return { x: V.toScreenX(s.view, plot, box.cx), y: V.toScreenY(s.view, plot, box.cy) }
  }, [currentPlot, s])

  const showTip = useCallback((index: number, junction: number, at: V.Point) => {
    const L = latest.current
    const st = L.strings
    if (junction >= 0) {
      const j = L.scene.junctions[junction]
      if (!j) return
      const codes = j.members.map(v => L.props.topology.nodes[v].code).join(', ')
      tipOpen.current = true
      setTip({ content: { kind: 'anyOf', template: st.tipAnyOf, codes }, x: at.x, y: at.y })
      return
    }
    const { presentation: p, topology: topo, dataset: data } = L.props
    const node = topo.nodes[index]
    const course = data.courses[index]?.id === node.id ? data.courses[index] : data.courses.find(c => c.id === node.id)
    const record = p.record[index]
    const recordActive = L.scene.recordActive
    const recordText = record === 'completed' ? st.recCompleted : record === 'inProgress' ? st.recInProgress : record === 'planned' ? st.recPlanned
      : recordActive && p.eligibility[index] === 'met' ? st.recAvailable : null
    tipOpen.current = true
    setTip({
      content: {
        kind: 'course',
        code: node.code,
        title: node.title,
        record: recordText,
        relation: relationOf(p.role[index], p.inProgram[index], L.focus, L.props.programActive, st),
        prereqLabel: st.tipPrereq,
        prereq: course?.prereq?.text || null,
        coreqLabel: st.tipCoreq,
        coreq: course?.coreq?.text || null,
      },
      x: at.x,
      y: at.y,
    })
  }, [])

  const setHover = useCallback((index: number, junction: number) => {
    if (index === s.hover && junction === s.hoverJunction) return
    const L = latest.current
    const changedNode = index !== s.hover
    s.hover = index
    s.hoverJunction = junction
    s.hoverEdges = index >= 0 && !L.sceneInput.presentation.dimming ? hoverEdges(L.scene, index) : null
    // The hover ring fades in over 80 ms (17; short enough to stay under reduced motion).
    s.hoverAt = changedNode && index >= 0 && shortFadesAllowed(L.props.motion) ? performance.now() : null
    const canvas = canvasRef.current
    if (canvas && !s.drag?.moved) canvas.style.cursor = index >= 0 ? 'pointer' : ''
    if (changedNode) L.props.onHover?.(index >= 0 ? L.props.topology.nodes[index].id : null)
    hideTip()
    if (index >= 0 || junction >= 0) {
      s.tipTimer = window.setTimeout(() => {
        if (s.pointer && !s.drag) showTip(index, junction, s.pointer)
      }, MOTION.hover.delay)
    }
    requestDraw()
  }, [s, hideTip, showTip, requestDraw])

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0) return
    rootRef.current?.focus({ preventScroll: true })
    s.keyboard = false
    settle()
    // A pending or open tooltip would otherwise cover the new chain after the click (10.4).
    hideTip()
    s.drag = { id: event.pointerId, x: event.clientX, y: event.clientY, lastX: event.clientX, lastY: event.clientY, moved: false }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const p = localPoint(event)
    s.pointer = p
    const d = s.drag
    if (d && d.id === event.pointerId) {
      if (!d.moved && Math.hypot(event.clientX - d.x, event.clientY - d.y) > DRAG_SLOP) {
        d.moved = true
        setHover(-1, -1)
        event.currentTarget.style.cursor = 'grabbing'
      }
      if (d.moved) setView(V.panBy(s.view, event.clientX - d.lastX, event.clientY - d.lastY))
      d.lastX = event.clientX
      d.lastY = event.clientY
      return
    }
    // While dots are still moving, the end layout is not what is on screen: hit-test once it settles.
    if (s.moving) return
    const hit = hitAt(p)
    setHover(hit, hit < 0 ? junctionAt(p) : -1)
  }

  useEffect(() => {
    refreshHover.current = () => {
      const p = s.pointer
      if (!p || s.drag || s.moving) return
      const hit = hitAt(p)
      setHover(hit, hit < 0 ? junctionAt(p) : -1)
    }
  })

  const onPointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const d = s.drag
    if (!d || d.id !== event.pointerId) return
    s.drag = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    const p = localPoint(event)
    if (d.moved) {
      event.currentTarget.style.cursor = ''
      const hit = hitAt(p)
      setHover(hit, -1)
      return
    }
    const L = latest.current
    const hit = hitAt(p)
    if (hit >= 0) {
      s.cursor = hit
      if (hit === L.focus) return
      s.anchor = { kind: 'select', index: hit, target: hit, screen: nodeScreen(hit), until: performance.now() + ANCHOR_TTL }
      L.props.onSelect(L.props.topology.nodes[hit].id, 'click')
      return
    }
    if (junctionAt(p) >= 0) return
    if (L.focus >= 0) {
      s.anchor = { kind: 'clear', index: L.focus, target: -1, screen: nodeScreen(L.focus), until: performance.now() + ANCHOR_TTL }
      L.props.onSelect(null, 'click')
    }
  }

  const onPointerCancel = () => {
    s.drag = null
  }

  const onPointerLeave = () => {
    s.pointer = null
    if (!s.drag) setHover(-1, -1)
  }

  const onDoubleClick = (event: ReactMouseEvent<HTMLCanvasElement>) => {
    const hit = hitAt(localPoint(event))
    if (hit < 0) return
    const L = latest.current
    if (hit === L.focus) {
      const view = frameTarget('chain', L.scene)
      if (view) setView(view, MOTION.frame)
      return
    }
    s.anchor = { kind: 'frame', index: hit, target: hit, screen: nodeScreen(hit), until: performance.now() + ANCHOR_TTL }
    L.props.onSelect(L.props.topology.nodes[hit].id, 'double-click')
  }

  // -------------------------------------------------------------------------
  // Keyboard (11.3, graph region)

  const navContext = useCallback((): NavContext => {
    const L = latest.current
    const { presentation: p, topology: topo } = L.props
    const g = L.sceneInput.geometry
    return { topology: topo, geometry: g, presentation: p, candidates: cursorCandidates(p, g, L.focus, L.props.programActive), focus: L.focus }
  }, [])

  const announceCursor = useCallback((index: number) => {
    const L = latest.current
    const { topology: topo, presentation: p } = L.props
    const node = topo.nodes[index]
    const lane = topo.lanes[node.lane]
    const relation = L.focus >= 0 ? relationOf(p.role[index], p.inProgram[index], L.focus, L.props.programActive, L.strings) : null
    const values = { code: node.code, title: node.title, subject: lane?.name ?? node.subject, level: levelOf(node.level), relation: relation?.text ?? '' }
    setLive(format(relation ? L.strings.liveCursorRelation : L.strings.liveCursor, values))
  }, [])

  const moveTo = useCallback((index: number) => {
    if (index < 0) return
    s.keyboard = true
    s.cursor = index
    const plot = currentPlot()
    const rect = nodeRect(latest.current.scene, index)
    const box = latest.current.sceneInput.geometry.nodes[index]
    const dot = { x: box.cx - 4, y: box.cy - 4, w: 8, h: 8 }
    const view = V.nudgeIntoView(s.view, plot, rect.w * s.view.zoom < plot.width - 2 * CURSOR_MARGIN ? rect : dot, dot, CURSOR_MARGIN)
    setView(view)
    announceCursor(index)
  }, [s, currentPlot, setView, announceCursor])

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey) return
    const plot = currentPlot()
    const arrows: Record<string, Direction> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' }
    const direction = arrows[event.key]
    if (direction) {
      settle()
      hideTip()
      if (event.shiftKey) {
        const d = { up: [0, -KEY_PAN], down: [0, KEY_PAN], left: [-KEY_PAN, 0], right: [KEY_PAN, 0] }[direction]
        setView(V.scrollBy(s.view, d[0], d[1]))
      } else {
        const ctx = navContext()
        const from = ctx.candidates.includes(s.cursor) ? s.cursor : -1
        const next = from < 0 || !s.keyboard
          ? (from >= 0 ? from : startCursor(ctx, { x: V.toWorldX(s.view, plot, plot.left + 40), y: V.toWorldY(s.view, plot, plot.top + 40) }))
          : moveCursor(ctx, from, direction)
        moveTo(next)
      }
      event.preventDefault()
      return
    }
    switch (event.key) {
      case 'Enter':
      case ' ': {
        const L = latest.current
        if (s.cursor >= 0 && s.keyboard && s.cursor !== L.focus && latest.current.scene.nodes[s.cursor]?.visible) {
          s.anchor = { kind: 'select', index: s.cursor, target: s.cursor, screen: nodeScreen(s.cursor), until: performance.now() + ANCHOR_TTL }
          L.props.onSelect(L.props.topology.nodes[s.cursor].id, 'keyboard')
        }
        break
      }
      case 'PageUp':
      case 'PageDown':
        settle()
        setView(V.scrollBy(s.view, 0, (event.key === 'PageUp' ? -1 : 1) * plot.height))
        break
      case 'Home':
      case 'End': {
        settle()
        const ctx = navContext()
        moveTo(laneEdgeCursor(ctx, s.cursor, event.key === 'End'))
        break
      }
      case 'Escape': {
        // Ladder (11.3): an open tooltip closes first; otherwise the app takes the next rung.
        if (tipOpen.current) {
          hideTip()
          event.stopPropagation()
          break
        }
        const L = latest.current
        if (L.focus >= 0) {
          s.anchor = { kind: 'clear', index: L.focus, target: -1, screen: nodeScreen(L.focus), until: performance.now() + ANCHOR_TTL }
        }
        L.props.onSelect(null, 'keyboard')
        break
      }
      default:
        return
    }
    event.preventDefault()
  }

  const onFocus = (event: ReactFocusEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return
    if (event.currentTarget.matches(':focus-visible')) {
      s.keyboard = true
      if (s.cursor < 0 || !latest.current.scene.nodes[s.cursor]?.visible) {
        const plot = currentPlot()
        const ctx = navContext()
        s.cursor = ctx.candidates.length ? startCursor(ctx, { x: V.toWorldX(s.view, plot, plot.left + 40), y: V.toWorldY(s.view, plot, plot.top + 40) }) : -1
      }
    }
    requestDraw()
  }

  const onBlur = () => requestDraw()

  // -------------------------------------------------------------------------
  // Imperative handle (contract)

  const zoomStep = useCallback((direction: 1 | -1) => {
    settle()
    setView(V.zoomAtCentre(s.view, V.stepZoom(s.view.zoom, direction), currentPlot()))
  }, [s, settle, setView, currentPlot])

  /**
   * View requests made by the app (framing, lane jumps) retarget the view only: a geometry tween
   * that the same state change started keeps running (user input has already ended older ones).
   */
  const retarget = useCallback(() => {
    s.anchor = null
    s.pendingFrame = null
  }, [s])

  const scrollLaneTo = useCallback((laneIndex: number, top: number) => {
    const box = latest.current.sceneInput.geometry.lanes[laneIndex]
    if (!box) return
    retarget()
    const end = s.pan ? V.viewMotionEnd(s.pan) : s.view
    setView({ ...end, y: box.y - top / end.zoom }, MOTION.frame)
  }, [s, retarget, setView])

  useImperativeHandle(ref, (): GraphCanvasHandle => ({
    zoomIn: () => zoomStep(1),
    zoomOut: () => zoomStep(-1),
    setZoom: zoom => {
      settle()
      setView(V.zoomAtCentre(s.view, V.clampZoom(zoom), currentPlot()))
    },
    fitWidth: () => {
      settle()
      setView(V.fitWidthView(s.view, latest.current.scene.world, currentPlot()), MOTION.frame)
    },
    frame: target => {
      retarget()
      // Framed now when possible; otherwise the next geometry (within FRAME_TTL) is framed once.
      const view = frameTarget(target, latest.current.scene)
      s.pendingFrame = view ? null : { target, until: performance.now() + FRAME_TTL }
      if (view) setView(view, MOTION.frame)
    },
    centerOn: courseId => {
      const L = latest.current
      const index = L.props.topology.indexById.get(courseId)
      if (index === undefined || !L.scene.nodes[index]?.visible) return
      const box = L.sceneInput.geometry.nodes[index]
      settle()
      setView(V.centerOnPoint(s.view, currentPlot(), { x: box.cx, y: box.cy }), MOTION.frame)
    },
    scrollToLane: subject => {
      const lane = latest.current.props.topology.lanes.findIndex(l => l.subject === subject)
      if (lane >= 0) scrollLaneTo(lane, LANE_JUMP_TOP)
    },
    getZoom: () => (s.pan ? V.viewMotionEnd(s.pan).zoom : s.view.zoom),
  }), [s, zoomStep, settle, retarget, setView, currentPlot, frameTarget, scrollLaneTo])

  // -------------------------------------------------------------------------
  // Overlay callbacks

  const onLaneAction = useCallback((action: LaneAction, laneIndex: number) => {
    const lane = latest.current.props.topology.lanes[laneIndex]
    if (!lane) return
    if (action === 'jump') scrollLaneTo(laneIndex, LANE_JUMP_TOP)
    else if (action === 'home') actions.setHome({ kind: 'subject', id: lane.subject })
    else if (action === 'only') actions.setSubjects(new Set([lane.subject]))
    else {
      const current = appStore.get().subjects
      const next = new Set(current ?? latest.current.props.topology.lanes.map(l => l.subject))
      next.delete(lane.subject)
      if (next.size) actions.setSubjects(next)
    }
  }, [scrollLaneTo])

  const onScrollTo = useCallback((axis: 'x' | 'y', value: number) => {
    settle()
    hideTip()
    setView(axis === 'x' ? { ...s.view, x: value } : { ...s.view, y: value })
  }, [s, settle, hideTip, setView])

  const onLaneMark = useCallback((laneIndex: number) => scrollLaneTo(laneIndex, LANE_MARK_TOP), [scrollLaneTo])

  const onReveal = useCallback((side: V.Side) => {
    settle()
    setView(V.revealSide(s.view, currentPlot(), latest.current.pillTargets, side), MOTION.frame)
  }, [s, settle, setView, currentPlot])

  const courseCount = formatNumber(topology.nodes.length, lang)
  return (
    <div
      ref={rootRef}
      className="gc-root"
      role="group"
      aria-roledescription={strings.regionRole}
      aria-label={format(strings.regionLabel, { n: courseCount })}
      tabIndex={0}
      data-motion={props.motion ? 'on' : undefined}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
      onBlur={onBlur}
    >
      <canvas
        ref={canvasRef}
        className="gc-canvas"
        aria-hidden="true"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onPointerLeave={onPointerLeave}
        onDoubleClick={onDoubleClick}
      />
      <BandBar
        bus={bus}
        topology={topology}
        geometry={overlayGeo}
        counts={bands}
        focus={focus}
        programActive={programActive}
        strings={strings}
        lang={lang}
        originX={OPT.laneHeaderWidth}
        trackGap={OPT.trackGap}
      />
      <LaneColumn
        bus={bus}
        topology={topology}
        geometry={overlayGeo}
        counts={lanes}
        focus={focus}
        programActive={programActive}
        strings={strings}
        divisionLabels={divisionLabels}
        lang={lang}
        onAction={onLaneAction}
      />
      <Corner counts={lanes} focus={focus} programActive={programActive} strings={strings} lang={lang} />
      <Scrollbars
        bus={bus}
        topology={topology}
        geometry={geometry}
        counts={lanes}
        world={scene.world}
        focus={focus}
        programActive={programActive}
        onScrollTo={onScrollTo}
        onLaneMark={onLaneMark}
      />
      <EdgePills bus={bus} targets={pillTargets} anchor={pillAnchor} strings={strings} lang={lang} onReveal={onReveal} />
      <Tooltip tip={tip} areaWidth={area.width} areaHeight={area.height} />
      <div className="gc-sr" aria-live="polite">{live}</div>
    </div>
  )
}
