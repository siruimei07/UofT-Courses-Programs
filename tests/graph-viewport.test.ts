import { describe, expect, it } from 'vitest'
import {
  FRAME_MARGIN_X, FRAME_MARGIN_Y, FRAME_ZOOM_FLOOR, ZOOM_MAX, ZOOM_MIN, anchorView, centerOnPoint, clampView, clampZoom,
  countHidden, cubicBezier, fitWidthView, frameView, hiddenSide, lerpView, nudgeIntoView, revealSide, scrollThumb, stepZoom,
  toScreenX, toScreenY, toWorldX, toWorldY, viewFromThumb, visibleWorld, zoomAround, zoomAtCentre,
} from '../src/graph/viewport'
import type { PillTarget, Plot, Rect, View, World } from '../src/graph/viewport'

/** The 1920 × 1080 frame with the panel open: canvas 1494 × 826, plot 1318 × 766. */
const plot: Plot = { left: 176, top: 60, width: 1318, height: 766 }
const world: World = { originX: 176, originY: 60, width: 5000, height: 9000 }
const view: View = { zoom: 1, x: 176, y: 60 }

const screen = (v: View, x: number, y: number) => ({ x: toScreenX(v, plot, x), y: toScreenY(v, plot, y) })
const inside = (v: View, box: Rect, margin = 0) => {
  const a = screen(v, box.x, box.y)
  const b = screen(v, box.x + box.w, box.y + box.h)
  return a.x >= plot.left + margin - 1e-6 && b.x <= plot.left + plot.width - margin + 1e-6 &&
    a.y >= plot.top + margin - 1e-6 && b.y <= plot.top + plot.height - margin + 1e-6
}

describe('zoom', () => {
  it('clamps to 0.35-2.0 and steps by 1.2', () => {
    expect(clampZoom(0.1)).toBe(ZOOM_MIN)
    expect(clampZoom(5)).toBe(ZOOM_MAX)
    expect(clampZoom(Number.NaN)).toBe(1)
    expect(stepZoom(1, 1)).toBeCloseTo(1.2)
    expect(stepZoom(1, -1)).toBeCloseTo(1 / 1.2, 4)
    let z = 1
    for (let i = 0; i < 20; i++) z = stepZoom(z, 1)
    expect(z).toBe(ZOOM_MAX)
    for (let i = 0; i < 40; i++) z = stepZoom(z, -1)
    expect(z).toBe(ZOOM_MIN)
  })

  it('returns exactly to 100 % after symmetric steps', () => {
    let z = 1
    for (let i = 0; i < 3; i++) z = stepZoom(z, 1)
    for (let i = 0; i < 3; i++) z = stepZoom(z, -1)
    expect(z).toBe(1)
  })

  it('keeps the world point under the cursor in place', () => {
    const v: View = { zoom: 0.8, x: 900, y: 1400 }
    const cursor = { x: 700, y: 420 }
    const wx = toWorldX(v, plot, cursor.x)
    const wy = toWorldY(v, plot, cursor.y)
    for (const z of [0.35, 0.92, 1.44, 2]) {
      const next = zoomAround(v, z, cursor.x, cursor.y, plot)
      expect(next.zoom).toBe(z)
      expect(toScreenX(next, plot, wx)).toBeCloseTo(cursor.x, 6)
      expect(toScreenY(next, plot, wy)).toBeCloseTo(cursor.y, 6)
    }
    const centred = zoomAtCentre(v, 1.2, plot)
    const c = { x: plot.left + plot.width / 2, y: plot.top + plot.height / 2 }
    expect(toScreenX(centred, plot, toWorldX(v, plot, c.x))).toBeCloseTo(c.x, 6)
  })

  it('converts between world and screen symmetrically', () => {
    const v: View = { zoom: 1.37, x: 512, y: 2048 }
    expect(toWorldX(v, plot, toScreenX(v, plot, 1234.5))).toBeCloseTo(1234.5, 9)
    expect(toWorldY(v, plot, toScreenY(v, plot, 4321.25))).toBeCloseTo(4321.25, 9)
    const visible = visibleWorld(v, plot)
    expect(visible.w).toBeCloseTo(plot.width / 1.37, 9)
  })
})

describe('clampView and fitWidthView', () => {
  it('keeps the view inside the content', () => {
    expect(clampView({ zoom: 1, x: 0, y: -50 }, world, plot)).toEqual({ zoom: 1, x: 176, y: 60 })
    const far = clampView({ zoom: 1, x: 1e6, y: 1e6 }, world, plot)
    expect(far.x).toBe(world.width - plot.width)
    expect(far.y).toBe(world.height - plot.height)
  })

  it('pins content smaller than the plot to the top-left', () => {
    const small: World = { originX: 176, originY: 60, width: 900, height: 500 }
    expect(clampView({ zoom: 1, x: 400, y: 300 }, small, plot)).toEqual({ zoom: 1, x: 176, y: 60 })
  })

  it('fits the content width with a 0.35 minimum and the left edge aligned', () => {
    const narrow: World = { originX: 176, originY: 60, width: 176 + 2000, height: 9000 }
    const fit = fitWidthView({ zoom: 1, x: 600, y: 700 }, narrow, plot)
    expect(fit.zoom).toBeCloseTo(plot.width / 2000, 9)
    expect(fit.x).toBe(176)
    expect(fit.y).toBe(700)
    expect(fitWidthView(view, world, plot).zoom).toBe(ZOOM_MIN)
  })
})

describe('frameView (design-spec 10.2)', () => {
  const vw = plot.width - 2 * FRAME_MARGIN_X
  const vh = plot.height - 2 * FRAME_MARGIN_Y

  it('centres a box that fits, at zoom ≤ 1, with min(20, slack / 2) at the top', () => {
    const box: Rect = { x: 1000, y: 2000, w: 800, h: 300 }
    const v = frameView({ box, focus: { x: 1300, y: 2100 } }, plot)
    expect(v.zoom).toBe(1)
    const a = screen(v, box.x, box.y)
    const b = screen(v, box.x + box.w, box.y + box.h)
    expect((a.x + b.x) / 2).toBeCloseTo(plot.left + plot.width / 2, 6)
    expect(a.y).toBeCloseTo(plot.top + FRAME_MARGIN_Y, 6)
  })

  it('shrinks to the 0.92 floor for a box slightly wider than the plot', () => {
    const box: Rect = { x: 300, y: 500, w: vw / 0.95, h: 200 }
    const v = frameView({ box }, plot)
    expect(v.zoom).toBeCloseTo(0.95, 6)
    expect(inside(v, box, FRAME_MARGIN_X - 1)).toBe(true)
  })

  it('aligns the top of a tall box unless the focus would fall below 70 %', () => {
    const box: Rect = { x: 300, y: 500, w: 600, h: vh * 3 }
    const topAligned = frameView({ box, focus: { x: 400, y: 700 } }, plot)
    expect(screen(topAligned, 0, box.y).y).toBeCloseTo(plot.top + FRAME_MARGIN_Y, 6)
    const low = frameView({ box, focus: { x: 400, y: 500 + vh * 2 } }, plot)
    expect(screen(low, 0, 500 + vh * 2).y).toBeCloseTo(plot.top + 0.3 * plot.height, 6)
  })

  it('never auto-frames below 0.92 and falls back through the priority windows', () => {
    const box: Rect = { x: 200, y: 400, w: 4000, h: 600 }
    const wide: Rect = { x: 220, y: 420, w: 3000, h: 500 }
    const fits: Rect = { x: 900, y: 420, w: 1000, h: 300 }
    const v = frameView({ box, focus: { x: 1200, y: 600 }, windows: [wide, fits] }, plot)
    expect(v.zoom).toBe(FRAME_ZOOM_FLOOR)
    // The first window that fits is left-aligned with its leftmost node 24 px inside the plot.
    expect(screen(v, fits.x, 0).x).toBeCloseTo(plot.left + 24, 6)
    expect(inside(v, { ...fits, y: fits.y, h: 1 })).toBe(true)
  })

  it('centres the focus when no window fits', () => {
    const box: Rect = { x: 200, y: 400, w: 4000, h: 600 }
    const focus = { x: 2100, y: 600 }
    const v = frameView({ box, focus, windows: [{ x: 210, y: 410, w: 3500, h: 100 }] }, plot)
    expect(v.zoom).toBe(FRAME_ZOOM_FLOOR)
    expect(screen(v, focus.x, 0).x).toBeCloseTo(plot.left + plot.width / 2, 6)
  })

  it('renders codes ≥ 12 px and titles ≥ 11.5 px at every automatic framing zoom', () => {
    for (const w of [200, 1000, 1400, 3000, 20000]) {
      const v = frameView({ box: { x: 0, y: 0, w, h: 100 } }, plot)
      expect(13 * v.zoom).toBeGreaterThanOrEqual(11.96)
      expect(12.5 * v.zoom).toBeGreaterThanOrEqual(11.5)
    }
  })
})

describe('anchoring and nudging (10.4)', () => {
  it('keeps an anchored world point at its old screen position', () => {
    const v: View = { zoom: 0.92, x: 800, y: 1200 }
    const before = screen(v, 1000, 1500)
    const moved = anchorView(v, plot, before, { x: 1180, y: 1430 })
    const after = screen(moved, 1180, 1430)
    expect(after.x).toBeCloseTo(before.x, 9)
    expect(after.y).toBeCloseTo(before.y, 9)
  })

  it('shifts a small box into view by the minimum with 16 px margins', () => {
    const box: Rect = { x: 176 + 1318 - 10, y: 200, w: 100, h: 50 }
    const v = nudgeIntoView(view, plot, box)
    expect(inside(v, box, 16)).toBe(true)
    expect(screen(v, box.x + box.w, 0).x).toBeCloseTo(plot.left + plot.width - 16, 6)
    expect(nudgeIntoView(view, plot, { x: 400, y: 200, w: 100, h: 50 })).toEqual(view)
  })

  it('never pushes the visible end of a box larger than the plot off screen, and keeps the focus', () => {
    const focus: Rect = { x: 600, y: 300, w: 20, h: 20 }
    // Box starts inside on the left and overflows on the right: reveal more only up to its left end.
    const box: Rect = { x: 300, y: 250, w: 3000, h: 100 }
    const v = nudgeIntoView(view, plot, box, focus)
    expect(screen(v, box.x, 0).x).toBeCloseTo(plot.left + 16, 6)
    expect(inside(v, focus, 16)).toBe(true)
    // Both ends outside: nothing to gain, nothing moves.
    const both: Rect = { x: 100, y: 250, w: 5000, h: 100 }
    expect(nudgeIntoView({ zoom: 1, x: 400, y: 60 }, plot, both, { x: 800, y: 300, w: 20, h: 20 }).x).toBe(400)
    // A focus outside the plot always comes back in.
    const away: Rect = { x: 4000, y: 300, w: 20, h: 20 }
    expect(inside(nudgeIntoView(view, plot, both, away), away, 16)).toBe(true)
  })

  it('centerOnPoint centres off-screen points only', () => {
    expect(centerOnPoint(view, plot, { x: 500, y: 300 })).toEqual(view)
    const v = centerOnPoint(view, plot, { x: 4000, y: 6000 })
    expect(screen(v, 4000, 6000).x).toBeCloseTo(plot.left + plot.width / 2, 6)
    expect(screen(v, 4000, 6000).y).toBeCloseTo(plot.top + plot.height / 2, 6)
  })
})

describe('edge-of-view pills (10.3)', () => {
  const target = (x: number, y: number, kind: PillTarget['kind']): PillTarget => ({ x, y, kind, box: { x: x - 6, y: y - 16, w: 120, h: 32 } })
  const targets = [
    target(100, 300, 'pre'),
    target(120, 340, 'pre'),
    target(2000, 300, 'unl'),
    target(2600, 300, 'unl'),
    target(600, 1400, 'unl'),
    target(700, 1500, 'pre'),
    target(600, 400, 'unl'),
  ]
  const v: View = { zoom: 1, x: 300, y: 60 }

  it('counts hidden dots per side, horizontal sides first', () => {
    expect(hiddenSide(v, plot, { x: 100, y: 5000 })).toBe('left')
    const counts = countHidden(v, plot, targets)
    expect(counts.left).toEqual({ pre: 2, unl: 0, prog: 0, total: 2 })
    expect(counts.right).toEqual({ pre: 0, unl: 2, prog: 0, total: 2 })
    expect(counts.bottom).toEqual({ pre: 1, unl: 1, prog: 0, total: 2 })
    expect(counts.top.total).toBe(0)
  })

  it('reveals the nearest hidden group without changing the zoom', () => {
    const right = revealSide(v, plot, targets, 'right')
    expect(right.zoom).toBe(1)
    expect(hiddenSide(right, plot, targets[2])).toBeNull()
    expect(hiddenSide(right, plot, targets[3])).toBe('right')
    const left = revealSide(v, plot, targets, 'left')
    expect(hiddenSide(left, plot, targets[0])).toBeNull()
    expect(hiddenSide(left, plot, targets[1])).toBeNull()
    const below = revealSide(v, plot, targets, 'bottom')
    expect(below.x).toBe(v.x)
    expect(hiddenSide(below, plot, targets[4])).toBeNull()
    expect(revealSide(v, plot, targets, 'top')).toBe(v)
  })
})

describe('scrollbars (9.4)', () => {
  it('sizes and positions the thumb proportionally, minimum 40 px', () => {
    const t = scrollThumb(60, 9060, 60, 766, 700)
    expect(t.scrollable).toBe(true)
    expect(t.thumbStart).toBe(0)
    expect(t.thumbLength).toBe(Math.max(40, (700 * 766) / 9000))
    const end = scrollThumb(60, 9060, 9060 - 766, 766, 700)
    expect(end.thumbStart + end.thumbLength).toBeCloseTo(700, 6)
    expect(scrollThumb(60, 600, 60, 766, 700).scrollable).toBe(false)
  })

  it('round-trips thumb positions to view coordinates', () => {
    const t = scrollThumb(60, 9060, 3000, 766, 700)
    expect(viewFromThumb(60, 9060, 766, 700, t.thumbLength, t.thumbStart)).toBeCloseTo(3000, 6)
    expect(viewFromThumb(60, 9060, 766, 700, t.thumbLength, -100)).toBe(60)
  })
})

describe('motion helpers', () => {
  it('eases from 0 to 1 monotonically', () => {
    const ease = cubicBezier(0.2, 0, 0, 1)
    expect(ease(0)).toBe(0)
    expect(ease(1)).toBe(1)
    let last = 0
    for (let t = 0.05; t < 1; t += 0.05) {
      const e = ease(t)
      expect(e).toBeGreaterThanOrEqual(last)
      last = e
    }
  })

  it('interpolates views with geometric zoom', () => {
    const mid = lerpView({ zoom: 0.5, x: 0, y: 0 }, { zoom: 2, x: 100, y: 200 }, 0.5)
    expect(mid.zoom).toBeCloseTo(1, 9)
    expect(mid.x).toBe(50)
    expect(mid.y).toBe(100)
  })
})
