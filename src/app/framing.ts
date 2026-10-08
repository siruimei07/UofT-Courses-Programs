// "Chain titles: auto" (design-spec 8.2): the chain keeps transitive titles only when its box fits
// the plot at the auto-frame floor with the 10.2 margins. Pure, so the decision is testable.
import type { PlotSize } from '../graph/canvas-types'
import type { Geometry, NodeRole, Presentation } from '../graph/types'

/** Automatic framing never zooms below this (8.12). */
export const FRAME_ZOOM_FLOOR = 0.92
/** 10.2: 16 px left and right, 20 px top and bottom. */
export const FRAME_MARGIN_X = 16
export const FRAME_MARGIN_Y = 20
/** 8.12: the chain box is padded by 12 px. */
const BOX_PAD = 12
/** Focus knockout radius (7.1) and the largest chain dot radius plus its ring. */
const FOCUS_DOT_R = 10.5
const DOT_R = 8.5

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

const CHAIN: ReadonlySet<NodeRole> = new Set<NodeRole>(['focus', 'prereq-direct', 'prereq', 'unlock-direct', 'unlock'])

/** Union of the dot and label boxes of every visible chain node, plus 12 px; null without a chain. */
export function chainBox(presentation: Presentation, geometry: Geometry): Box | null {
  let left = Infinity
  let top = Infinity
  let right = -Infinity
  let bottom = -Infinity
  presentation.role.forEach((role, index) => {
    if (!CHAIN.has(role) || presentation.cls[index] === 'hidden') return
    const node = geometry.nodes[index]
    if (!node) return
    const r = role === 'focus' ? FOCUS_DOT_R : DOT_R
    left = Math.min(left, node.x, node.cx - r)
    top = Math.min(top, node.y, node.cy - r)
    right = Math.max(right, node.x + node.w, node.cx + r)
    bottom = Math.max(bottom, node.y + node.h, node.cy + r)
  })
  if (left === Infinity) return null
  return { x: left - BOX_PAD, y: top - BOX_PAD, w: right - left + 2 * BOX_PAD, h: bottom - top + 2 * BOX_PAD }
}

/** Whether the box fits the plot width at the framing floor (10.2 step 3); height is scrolled. */
export function boxFitsPlot(box: Box | null, plot: PlotSize | null, zoom = FRAME_ZOOM_FLOOR): boolean {
  if (!box || !plot) return true
  return box.w * zoom <= plot.width - 2 * FRAME_MARGIN_X
}
