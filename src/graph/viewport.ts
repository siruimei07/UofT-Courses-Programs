// Pure pan / zoom math for the graph view (design-spec 8.12, 9.4, 10). World units are CSS px at
// zoom 1 (geometry units). The plot is the canvas minus the sticky lane column (left) and band bar
// (top); a View stores the zoom and the world point shown at the plot's top-left corner.

export const ZOOM_MIN = 0.35
export const ZOOM_MAX = 2
export const ZOOM_STEP = 1.2
/** Ctrl + wheel: zoom by exp(-deltaY · k) around the cursor. */
export const WHEEL_ZOOM_RATE = 0.0016
/** Automatic framing never zooms below this (8.12). */
export const FRAME_ZOOM_FLOOR = 0.92
export const FRAME_ZOOM_MAX = 1
/** 10.2: framing margins (screen px). */
export const FRAME_MARGIN_X = 16
export const FRAME_MARGIN_Y = 20
/** 10.2 step 4: a priority window's leftmost node sits this far inside the plot. */
export const WINDOW_LEFT_INSET = 24
/** 10.4: a click below this zoom (labels invisible) zooms to the floor around the node. */
export const CLICK_MIN_ZOOM = 0.73
export const NUDGE_MARGIN = 16
/** 10.3 / 9.4: the 10 px scrollbars plus air; dots this close to the right / bottom edge are hidden. */
export const SCROLLBAR_CLEARANCE = 16

export interface View {
  zoom: number
  /** World point at the plot's top-left corner. */
  x: number
  y: number
}

/** Plot rectangle in canvas CSS px. */
export interface Plot {
  left: number
  top: number
  width: number
  height: number
}

/** Scrollable world: content starts at the origin (lane header width, band header height). */
export interface World {
  originX: number
  originY: number
  width: number
  height: number
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface Point {
  x: number
  y: number
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1
  return clamp(zoom, ZOOM_MIN, ZOOM_MAX)
}

/** × 1.2 or ÷ 1.2, snapped so repeated steps return exactly to 100 %. */
export function stepZoom(zoom: number, direction: 1 | -1): number {
  const next = direction > 0 ? zoom * ZOOM_STEP : zoom / ZOOM_STEP
  const rounded = Math.round(next * 1e4) / 1e4
  return clampZoom(Math.abs(rounded - 1) < 0.005 ? 1 : rounded)
}

export function toScreenX(view: View, plot: Plot, wx: number): number {
  return plot.left + (wx - view.x) * view.zoom
}

export function toScreenY(view: View, plot: Plot, wy: number): number {
  return plot.top + (wy - view.y) * view.zoom
}

export function toWorldX(view: View, plot: Plot, sx: number): number {
  return view.x + (sx - plot.left) / view.zoom
}

export function toWorldY(view: View, plot: Plot, sy: number): number {
  return view.y + (sy - plot.top) / view.zoom
}

/** World rectangle currently visible in the plot. */
export function visibleWorld(view: View, plot: Plot): Rect {
  return { x: view.x, y: view.y, w: plot.width / view.zoom, h: plot.height / view.zoom }
}

/** Keeps the view inside the content; content smaller than the plot sticks to the top-left. */
export function clampView(view: View, world: World, plot: Plot): View {
  const zoom = clampZoom(view.zoom)
  const maxX = Math.max(world.originX, world.width - plot.width / zoom)
  const maxY = Math.max(world.originY, world.height - plot.height / zoom)
  return { zoom, x: clamp(view.x, world.originX, maxX), y: clamp(view.y, world.originY, maxY) }
}

/** New zoom with the world point under the screen point (sx, sy) kept in place. */
export function zoomAround(view: View, zoom: number, sx: number, sy: number, plot: Plot): View {
  const next = clampZoom(zoom)
  const wx = toWorldX(view, plot, sx)
  const wy = toWorldY(view, plot, sy)
  return { zoom: next, x: wx - (sx - plot.left) / next, y: wy - (sy - plot.top) / next }
}

/** Zoom around the plot centre (buttons, keys). */
export function zoomAtCentre(view: View, zoom: number, plot: Plot): View {
  return zoomAround(view, zoom, plot.left + plot.width / 2, plot.top + plot.height / 2, plot)
}

/** Pan by a screen-space delta: content moves with the pointer, so the view moves against it. */
export function panBy(view: View, dx: number, dy: number): View {
  return { zoom: view.zoom, x: view.x - dx / view.zoom, y: view.y - dy / view.zoom }
}

/** Scroll by a screen-space delta (wheel, keys): the view moves with the delta. */
export function scrollBy(view: View, dx: number, dy: number): View {
  return { zoom: view.zoom, x: view.x + dx / view.zoom, y: view.y + dy / view.zoom }
}

/** "Fit width": the whole content width in the plot (minimum zoom 0.35), left edge aligned. */
export function fitWidthView(view: View, world: World, plot: Plot): View {
  const content = Math.max(1, world.width - world.originX)
  const zoom = clampZoom(plot.width / content)
  return { zoom, x: world.originX, y: view.y }
}

/** The world point stays at the same screen position after a geometry change (click anchoring). */
export function anchorView(view: View, plot: Plot, screen: Point, world: Point): View {
  return { zoom: view.zoom, x: world.x - (screen.x - plot.left) / view.zoom, y: world.y - (screen.y - plot.top) / view.zoom }
}

/**
 * Smallest shift on one axis that brings [lo, hi] inside [min, max]. A span larger than the window
 * only moves until its visible end reaches the window edge (what is on screen stays on screen);
 * `keepLo..keepHi` (the focus) always ends up inside.
 */
function nudgeAxis(lo: number, hi: number, min: number, max: number, keepLo: number, keepHi: number): number {
  let shift = 0
  if (hi - lo <= max - min) shift = lo < min ? min - lo : hi > max ? max - hi : 0
  else if (lo < min && hi <= max) shift = Math.min(min - lo, max - hi)
  else if (hi > max && lo >= min) shift = -Math.min(hi - max, lo - min)
  if (keepLo + shift < min) shift = min - keepLo
  else if (keepHi + shift > max) shift = max - keepHi
  return shift
}

/**
 * 10.4 step 3: shift the view by the minimum so `box` lies inside the plot with `margin`,
 * preferring to keep `keep` (the focus) visible when the box is larger than the plot.
 */
export function nudgeIntoView(view: View, plot: Plot, box: Rect, keep: Rect = box, margin = NUDGE_MARGIN): View {
  const z = view.zoom
  const sx = (wx: number) => toScreenX(view, plot, wx)
  const sy = (wy: number) => toScreenY(view, plot, wy)
  const dx = nudgeAxis(sx(box.x), sx(box.x + box.w), plot.left + margin, plot.left + plot.width - margin, sx(keep.x), sx(keep.x + keep.w))
  const dy = nudgeAxis(sy(box.y), sy(box.y + box.h), plot.top + margin, plot.top + plot.height - margin, sy(keep.y), sy(keep.y + keep.h))
  return { zoom: z, x: view.x - dx / z, y: view.y - dy / z }
}

/** True when the world point lies inside the plot shrunk by `margin` screen px. */
export function pointInPlot(view: View, plot: Plot, point: Point, margin = 0): boolean {
  const sx = toScreenX(view, plot, point.x)
  const sy = toScreenY(view, plot, point.y)
  return sx >= plot.left + margin && sx <= plot.left + plot.width - margin && sy >= plot.top + margin && sy <= plot.top + plot.height - margin
}

/** centerOn: unchanged when the point is comfortably visible, otherwise centred; zoom unchanged. */
export function centerOnPoint(view: View, plot: Plot, point: Point, margin = 24): View {
  if (pointInPlot(view, plot, point, margin)) return view
  return { zoom: view.zoom, x: point.x - plot.width / 2 / view.zoom, y: point.y - plot.height / 2 / view.zoom }
}

export interface FrameRequest {
  /** Chain (or program) box, already padded (8.12). */
  box: Rect
  /** Focus dot centre; drives the 30 % / 70 % rule and the last fallback. */
  focus?: Point
  /** 10.2 step 4 priority windows (unpadded node unions), best first. */
  windows?: Rect[]
}

/** Vertical placement of 10.2 step 3 for a box at zoom z; returns view.y. */
function placeY(box: Rect, z: number, plot: Plot, focus: Point | undefined): number {
  const vh = plot.height - 2 * FRAME_MARGIN_Y
  const h = box.h * z
  if (h <= vh) {
    const slack = plot.height - h
    return box.y - Math.min(FRAME_MARGIN_Y, slack / 2) / z
  }
  const y = box.y - FRAME_MARGIN_Y / z
  if (focus && (focus.y - y) * z > 0.7 * plot.height) return focus.y - (0.3 * plot.height) / z
  return y
}

/**
 * Framing (design-spec 10.2): zoom = clamp(vw / box.w, 0.92, 1). A box that fits is centred
 * horizontally; otherwise the first priority window that fits at 0.92 is left-aligned, and the
 * last resort centres the focus. The caller clamps the result to the world.
 */
export function frameView(request: FrameRequest, plot: Plot): View {
  const { box, focus } = request
  const vw = plot.width - 2 * FRAME_MARGIN_X
  const zoom = clampZoom(clamp(vw / Math.max(1, box.w), FRAME_ZOOM_FLOOR, FRAME_ZOOM_MAX))
  if (box.w * zoom <= vw) {
    const x = box.x + box.w / 2 - plot.width / 2 / zoom
    return { zoom, x, y: placeY(box, zoom, plot, focus) }
  }
  const z = FRAME_ZOOM_FLOOR
  for (const window of request.windows ?? []) {
    // The window's left edge sits 24 screen px inside the plot and needs the 16 px right margin.
    if (window.w * z + WINDOW_LEFT_INSET > plot.width - FRAME_MARGIN_X) continue
    return { zoom: z, x: window.x - WINDOW_LEFT_INSET / z, y: placeY(window, z, plot, focus) }
  }
  if (focus) return { zoom: z, x: focus.x - plot.width / 2 / z, y: placeY(box, z, plot, focus) }
  return { zoom: z, x: box.x - FRAME_MARGIN_X / z, y: placeY(box, z, plot, undefined) }
}

// ---------------------------------------------------------------------------
// Edge-of-view indicators (10.3)

export type Side = 'left' | 'right' | 'top' | 'bottom'
export type PillKind = 'pre' | 'unl' | 'prog'

export interface PillTarget {
  /** Dot centre (world). */
  x: number
  y: number
  /** Box to reveal when the pill is clicked (world). */
  box: Rect
  kind: PillKind
}

export interface SideCount {
  pre: number
  unl: number
  prog: number
  total: number
}

export type SideCounts = Record<Side, SideCount>

const emptyCount = (): SideCount => ({ pre: 0, unl: 0, prog: 0, total: 0 })

/**
 * Which side a dot is hidden on (horizontal sides win), or null when it is readable in the plot.
 * Dots under the scrollbars (within `clearance` of the right or bottom edge) count as hidden.
 */
export function hiddenSide(view: View, plot: Plot, point: Point, clearance = SCROLLBAR_CLEARANCE): Side | null {
  const sx = toScreenX(view, plot, point.x)
  const sy = toScreenY(view, plot, point.y)
  if (sx < plot.left) return 'left'
  if (sx > plot.left + plot.width - clearance) return 'right'
  if (sy < plot.top) return 'top'
  if (sy > plot.top + plot.height - clearance) return 'bottom'
  return null
}

/** Chain nodes whose dots are outside the plot (or under a scrollbar), per side; at most one pill per side. */
export function countHidden(view: View, plot: Plot, targets: readonly PillTarget[]): SideCounts {
  const counts: SideCounts = { left: emptyCount(), right: emptyCount(), top: emptyCount(), bottom: emptyCount() }
  for (const target of targets) {
    const side = hiddenSide(view, plot, target)
    if (!side) continue
    counts[side][target.kind]++
    counts[side].total++
  }
  return counts
}

/**
 * Pill click: pan (zoom unchanged) by the smallest amount that reveals the nearest hidden group on
 * that side. The group is every hidden target whose dot lies within `groupSpan` world px of the
 * nearest one along the panning axis (one dependency column, or one row band).
 */
export function revealSide(view: View, plot: Plot, targets: readonly PillTarget[], side: Side, margin = 24, groupSpan = 24): View {
  const hidden = targets.filter(target => hiddenSide(view, plot, target) === side)
  if (!hidden.length) return view
  const horizontal = side === 'left' || side === 'right'
  const axis = (t: PillTarget) => (horizontal ? t.x : t.y)
  const nearest = side === 'left' || side === 'top'
    ? Math.max(...hidden.map(axis))
    : Math.min(...hidden.map(axis))
  const group = hidden.filter(target => Math.abs(axis(target) - nearest) <= groupSpan)
  const z = view.zoom
  if (horizontal) {
    if (side === 'left') {
      const left = Math.min(...group.map(t => t.box.x))
      return { zoom: z, x: left - margin / z, y: view.y }
    }
    const right = Math.max(...group.map(t => t.box.x + t.box.w))
    return { zoom: z, x: right + margin / z - plot.width / z, y: view.y }
  }
  if (side === 'top') {
    const top = Math.min(...group.map(t => t.box.y))
    return { zoom: z, x: view.x, y: top - margin / z }
  }
  const bottom = Math.max(...group.map(t => t.box.y + t.box.h))
  return { zoom: z, x: view.x, y: bottom + margin / z - plot.height / z }
}

// ---------------------------------------------------------------------------
// Scrollbars (9.4)

export interface ScrollAxis {
  /** Whether the content overflows the plot on this axis (bars hide otherwise). */
  scrollable: boolean
  /** Thumb offset and length in track px. */
  thumbStart: number
  thumbLength: number
}

export const THUMB_MIN = 40

/** Thumb geometry for one axis: content and view in world units, track in screen px. */
export function scrollThumb(origin: number, extent: number, viewStart: number, viewSpan: number, track: number): ScrollAxis {
  const content = Math.max(0, extent - origin)
  if (content <= viewSpan + 0.5 || track <= 0) return { scrollable: false, thumbStart: 0, thumbLength: track }
  const thumbLength = Math.min(track, Math.max(THUMB_MIN, (track * viewSpan) / content))
  const range = content - viewSpan
  const offset = clamp((viewStart - origin) / range, 0, 1)
  return { scrollable: true, thumbStart: offset * (track - thumbLength), thumbLength }
}

/** Inverse of scrollThumb: the view start for a thumb dragged to `thumbStart`. */
export function viewFromThumb(origin: number, extent: number, viewSpan: number, track: number, thumbLength: number, thumbStart: number): number {
  const content = Math.max(0, extent - origin)
  const range = Math.max(0, content - viewSpan)
  const free = Math.max(1, track - thumbLength)
  return origin + clamp(thumbStart / free, 0, 1) * range
}

// ---------------------------------------------------------------------------
// Motion helpers (17, owner decision 13). Pure timing: the canvas loop asks these what to draw at
// a given number of milliseconds into a sequence.

export type Ease = (t: number) => number

/** cubic-bezier(x1, y1, x2, y2) easing: Newton steps on x, bisection where they do not converge. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): Ease {
  const cx = 3 * x1
  const bx = 3 * (x2 - x1) - cx
  const ax = 1 - cx - bx
  const cy = 3 * y1
  const by = 3 * (y2 - y1) - cy
  const ay = 1 - cy - by
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t
  const slopeX = (t: number) => (3 * ax * t + 2 * bx) * t + cx
  return (x: number) => {
    if (!(x > 0)) return 0
    if (x >= 1) return 1
    let t = x
    for (let i = 0; i < 8; i++) {
      const err = sampleX(t) - x
      if (Math.abs(err) < 1e-6) return sampleY(t)
      const d = slopeX(t)
      if (Math.abs(d) < 1e-6) break
      t = clamp(t - err / d, 0, 1)
    }
    let lo = 0
    let hi = 1
    t = x
    for (let i = 0; i < 40 && hi - lo > 1e-7; i++) {
      if (sampleX(t) < x) lo = t
      else hi = t
      t = (lo + hi) / 2
    }
    return sampleY(t)
  }
}

/** Geometry changes and the focus glyph: cubic-bezier(0.2, 0, 0, 1). */
export const EASE_EMPHASIS = cubicBezier(0.2, 0, 0, 1)
/** Framing, nudges and pill pans: cubic-bezier(0.4, 0, 0.2, 1). */
export const EASE_STANDARD = cubicBezier(0.4, 0, 0.2, 1)
export const EASE_LINEAR: Ease = t => clamp(t, 0, 1)

/** Durations (ms) and easings of design-spec 17. */
export const MOTION = {
  /** Select, clear, filter, Titles: node centres, dot radii and lane / column / band boxes. */
  geometry: { duration: 260, ease: EASE_EMPHASIS },
  /** During the geometry tween the old labels fade out, then the new ones fade in. */
  labelsOut: { delay: 0, duration: 100 },
  labelsIn: { delay: 100, duration: 160 },
  /** Chain edges are hidden during the tween, then fade in (opacity only): direct at 0, transitive at +60 ms. */
  edges: { direct: 0, transitive: 60, duration: 160 },
  /** Focus glyph: the ring scales 0.6 → 1, the plate fades in. */
  focus: { duration: 180, ease: EASE_EMPHASIS, from: 0.6, plate: 120 },
  /** Framing pan / zoom (hash, search, F, double-click) and pill-click pans. */
  frame: { duration: 320, ease: EASE_STANDARD },
  /** Click selection: the nudge that brings the chain into view after anchoring. */
  nudge: { duration: 220, ease: EASE_STANDARD },
  /** Hover ring fade; the tooltip (CSS) fades over 120 ms after the 350 ms rest. */
  hover: { ring: 80, delay: 350, tooltip: 120 },
  /** Edge-of-view pills fade in (CSS). */
  pill: { fade: 160 },
  /** Under prefers-reduced-motion only opacity fades this short remain. */
  reducedFadeMax: 100,
} as const

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/** Linear progress (0 → 1) of a step that starts `delay` ms into a sequence and lasts `duration` ms. */
export function progress(elapsed: number, delay: number, duration: number): number {
  if (duration <= 0) return elapsed >= delay ? 1 : 0
  return clamp((elapsed - delay) / duration, 0, 1)
}

/** What a geometry change shows `elapsed` ms after it started (17). */
export interface GeometryPhase {
  /** Eased geometry progress: 0 = previous layout, 1 = new layout. */
  t: number
  /** Still interpolating: chain edges stay hidden and the edge-of-view pills wait. */
  moving: boolean
  /** Labels drawn now: the previous ones (fading out) or the new ones (fading in). */
  labels: 'from' | 'to'
  labelAlpha: number
  /** Opacity of the direct chain edges (and the faint overview texture) and of the transitive and program edges. */
  direct: number
  transitive: number
  /** The whole sequence (tween, label fades, edge fades) is over. */
  done: boolean
}

/**
 * Sequencing of a geometry change: 260 ms tween; labels out over 100 ms, in over 160 ms after
 * 100 ms; then the chain edges fade in over 160 ms, direct at 0 and transitive at +60 ms.
 * `labelStart` is the opacity the outgoing labels had when the change started (a tween that
 * interrupts another one continues from the labels on screen).
 */
export function geometryPhase(elapsed: number, labelStart = 1): GeometryPhase {
  const { geometry, labelsIn, labelsOut, edges } = MOTION
  const raw = progress(elapsed, 0, geometry.duration)
  const moving = raw < 1
  const incoming = elapsed >= labelsIn.delay
  const labelAlpha = incoming
    ? progress(elapsed, labelsIn.delay, labelsIn.duration)
    : labelStart * (1 - progress(elapsed, labelsOut.delay, labelsOut.duration))
  const after = elapsed - geometry.duration
  const direct = moving ? 0 : progress(after, edges.direct, edges.duration)
  const transitive = moving ? 0 : progress(after, edges.transitive, edges.duration)
  return {
    t: geometry.ease(raw),
    moving,
    labels: incoming ? 'to' : 'from',
    labelAlpha,
    direct,
    transitive,
    done: !moving && direct >= 1 && transitive >= 1,
  }
}

/** Total length of a geometry change sequence (ms). */
export const GEOMETRY_SEQUENCE_MS = MOTION.geometry.duration + Math.max(MOTION.edges.direct, MOTION.edges.transitive) + MOTION.edges.duration

/** Focus glyph `elapsed` ms after a new course was selected: ring scale 0.6 → 1, plate opacity 0 → 1. */
export function focusPhase(elapsed: number): { scale: number; plate: number; done: boolean } {
  const F = MOTION.focus
  const ring = progress(elapsed, 0, F.duration)
  const plate = progress(elapsed, 0, F.plate)
  return { scale: F.from + (1 - F.from) * F.ease(ring), plate, done: ring >= 1 && plate >= 1 }
}

/** Interpolates two views; zoom is interpolated geometrically so the motion feels even. */
export function lerpView(from: View, to: View, t: number): View {
  const zoom = from.zoom * Math.pow(to.zoom / from.zoom, t)
  return { zoom, x: lerp(from.x, to.x, t), y: lerp(from.y, to.y, t) }
}

/**
 * View at eased progress t of a pan / zoom. Without a zoom change the corner moves linearly (an
 * anchored node then stays exactly where it is while the geometry tweens with the same easing).
 * With a zoom change, per axis, the world point that sits at the same screen offset in both views
 * stays put when it lies inside the plot (a zoom about it); otherwise the plot centre moves
 * linearly while the zoom changes geometrically.
 */
export function tweenView(from: View, to: View, t: number, plot?: Plot): View {
  if (t <= 0) return from
  if (t >= 1) return to
  if (Math.abs(from.zoom - to.zoom) < 1e-9 || !plot) return lerpView(from, to, t)
  const zoom = from.zoom * Math.pow(to.zoom / from.zoom, t)
  const axis = (a: number, b: number, span: number) => {
    const fixed = (b - a) / (1 / from.zoom - 1 / to.zoom)
    if (fixed >= 0 && fixed <= span) return a + fixed / from.zoom - fixed / zoom
    const centre = lerp(a + span / 2 / from.zoom, b + span / 2 / to.zoom, t)
    return centre - span / 2 / zoom
  }
  return { zoom, x: axis(from.x, to.x, plot.width), y: axis(from.y, to.y, plot.height) }
}

/** An animated view change: a main pan / zoom plus, for click selection, a nudge on its own timing (10.4). */
export interface ViewMotion {
  start: number
  from: View
  to: View
  duration: number
  ease: Ease
  /** World-space shift added on top of `to` (zoom unchanged). */
  nudge?: { dx: number; dy: number; duration: number; ease: Ease }
}

export function viewMotionEnd(motion: ViewMotion): View {
  const { to, nudge } = motion
  return nudge ? { zoom: to.zoom, x: to.x + nudge.dx, y: to.y + nudge.dy } : to
}

/** View of a motion at time `now` (same clock as `start`). */
export function viewAt(motion: ViewMotion, now: number, plot?: Plot): { view: View; done: boolean } {
  const elapsed = now - motion.start
  const main = progress(elapsed, 0, motion.duration)
  const shift = motion.nudge ? progress(elapsed, 0, motion.nudge.duration) : 1
  if (main >= 1 && shift >= 1) return { view: viewMotionEnd(motion), done: true }
  const view = tweenView(motion.from, motion.to, motion.ease(main), plot)
  if (!motion.nudge) return { view, done: false }
  const e = motion.nudge.ease(shift)
  return { view: { zoom: view.zoom, x: view.x + motion.nudge.dx * e, y: view.y + motion.nudge.dy * e }, done: false }
}
