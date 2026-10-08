// Edge-of-view indicators (design-spec 10.3): at most one pill per side counting chain (or
// program) courses whose dots are outside the plot. Text and position update every frame; a click
// pans just enough to reveal the nearest hidden group, without changing the zoom.
import { useCallback, useRef } from 'react'
import type { Lang } from '../../app/store'
import { format, formatNumber } from '../../i18n'
import type { GraphStrings } from '../strings'
import { SCROLLBAR_CLEARANCE, countHidden, hiddenSide, type PillTarget, type Rect, type Side, type SideCount } from '../viewport'
import { clamp, setShown, setTransform, useFrameLayout, type FrameBus, type FrameInfo } from './frame'

const SIDES: readonly Side[] = ['left', 'right', 'top', 'bottom']
const INSET = 10
const PILL_H = 24
/** A pill keeps this far from chain labels and from the other pills; it slides in steps of SLIDE_STEP. */
const LABEL_CLEAR = 4
const PILL_CLEAR = 6
const SLIDE_STEP = 6
/** Screen box kept clear around the focus dot: its knockout and the plate to its right (7.5). */
const FOCUS_CLEAR = { left: 14, right: 300, up: 42, down: 42 }

/** One pill to place: its side, size, preferred top-left corner and the range it may slide over (along its edge). */
export interface PillSlot {
  side: Side
  w: number
  h: number
  x: number
  y: number
  min: number
  max: number
}

const overlap = (a: Rect, b: Rect, pad: number) =>
  Math.max(0, Math.min(a.x + a.w + pad, b.x + b.w) - Math.max(a.x - pad, b.x)) * Math.max(0, Math.min(a.y + a.h + pad, b.y + b.h) - Math.max(a.y - pad, b.y))

/**
 * Pill positions (10.3) that never cover a visible chain label, the focus or another pill: each pill
 * slides along its edge (left and right pills vertically, top and bottom pills horizontally) to the
 * free position nearest its preferred one. Where nothing is free, the position covering least wins.
 */
export function placePills(slots: readonly PillSlot[], obstacles: readonly Rect[]): Array<{ side: Side; x: number; y: number }> {
  const placed: Rect[] = []
  return slots.map(slot => {
    const vertical = slot.side === 'left' || slot.side === 'right'
    const start = vertical ? slot.y : slot.x
    const at = (value: number): Rect => (vertical ? { x: slot.x, y: value, w: slot.w, h: slot.h } : { x: value, y: slot.y, w: slot.w, h: slot.h })
    const cost = (rect: Rect) =>
      obstacles.reduce((sum, box) => sum + overlap(rect, box, LABEL_CLEAR), 0) + placed.reduce((sum, box) => sum + 4 * overlap(rect, box, PILL_CLEAR), 0)
    let best = at(clamp(start, slot.min, slot.max))
    let bestCost = cost(best)
    for (let k = 1; bestCost > 0 && k * SLIDE_STEP <= slot.max - slot.min + SLIDE_STEP; k++) {
      for (const value of [start + k * SLIDE_STEP, start - k * SLIDE_STEP]) {
        if (value < slot.min - 1e-6 || value > slot.max + 1e-6) continue
        const rect = at(value)
        const c = cost(rect)
        if (c < bestCost) {
          best = rect
          bestCost = c
          if (!c) break
        }
      }
    }
    placed.push(best)
    return { side: slot.side, x: best.x, y: best.y }
  })
}

/** Hides a pill; a pill that has keyboard focus first hands it to the graph region, never to <body>. */
function hidePill(el: HTMLButtonElement): void {
  if (el.style.display !== 'none' && el.ownerDocument.activeElement === el) {
    el.closest<HTMLElement>('.gc-root')?.focus({ preventScroll: true })
  }
  setShown(el, false)
}

export function pillText(side: Side, count: SideCount, strings: GraphStrings, lang: Lang): string {
  const n = (value: number) => formatNumber(value, lang)
  if (side === 'left' && count.pre === count.total) {
    return count.pre === 1 ? strings.pillEarlierOne : format(strings.pillEarlier, { n: n(count.pre) })
  }
  if (side === 'right' && count.unl === count.total) {
    return count.unl === 1 ? strings.pillLaterOne : format(strings.pillLater, { n: n(count.unl) })
  }
  const parts: string[] = []
  if (count.pre) parts.push(count.pre === 1 ? strings.partPreOne : format(strings.partPre, { n: n(count.pre) }))
  if (count.unl) parts.push(count.unl === 1 ? strings.partUnlOne : format(strings.partUnl, { n: n(count.unl) }))
  if (count.prog) parts.push(count.prog === 1 ? strings.partProgOne : format(strings.partProg, { n: n(count.prog) }))
  const template = { left: strings.pillLeft, right: strings.pillRight, top: strings.pillTop, bottom: strings.pillBottom }[side]
  return format(template, { parts: parts.join(strings.partJoin) })
}

function pillKind(count: SideCount): 'pre' | 'unl' | 'prog' | 'mixed' {
  if (count.pre === count.total) return 'pre'
  if (count.unl === count.total) return 'unl'
  if (count.prog === count.total) return 'prog'
  return 'mixed'
}

export interface EdgePillsProps {
  bus: FrameBus
  targets: readonly PillTarget[]
  /** Focus dot (world) the pills align with; null centres them on the plot. */
  anchor: { x: number; y: number } | null
  strings: GraphStrings
  lang: Lang
  onReveal(side: Side): void
}

export function EdgePills({ bus, targets, anchor, strings, lang, onReveal }: EdgePillsProps) {
  const els = useRef<Partial<Record<Side, HTMLButtonElement>>>({})
  const texts = useRef<Partial<Record<Side, string>>>({})
  const widths = useRef<Partial<Record<Side, number>>>({})

  const layout = useCallback((frame: FrameInfo) => {
    const { plot, view } = frame
    // Counts belong to the settled layout: while a geometry tween runs the pills wait, then fade in (17).
    const counts = targets.length && !frame.moving ? countHidden(view, plot, targets) : null
    const ax = anchor ? frame.toX(anchor.x) : plot.left + plot.width / 2
    const ay = anchor ? frame.toY(anchor.y) : plot.top + plot.height / 2
    const slots: Array<PillSlot & { el: HTMLButtonElement }> = []
    for (const side of SIDES) {
      const el = els.current[side]
      if (!el) continue
      const count = counts?.[side]
      if (!count || !count.total) {
        hidePill(el)
        continue
      }
      const text = pillText(side, count, strings, lang)
      setShown(el, true)
      if (texts.current[side] !== text) {
        texts.current[side] = text
        const label = el.firstElementChild as HTMLElement | null
        if (label) label.textContent = text
        el.dataset.kind = pillKind(count)
        widths.current[side] = el.offsetWidth
      }
      const w = widths.current[side] ?? 120
      const right = frame.width - SCROLLBAR_CLEARANCE
      const bottom = frame.height - SCROLLBAR_CLEARANCE
      const yMin = plot.top + INSET
      const yMax = bottom - PILL_H
      const xMin = plot.left + INSET
      const xMax = right - w
      const vertical = side === 'left' || side === 'right'
      slots.push({
        el, side, w, h: PILL_H,
        x: side === 'left' ? xMin : side === 'right' ? xMax : clamp(ax - w / 2, xMin, xMax),
        y: side === 'top' ? yMin : side === 'bottom' ? yMax : clamp(ay - PILL_H / 2, yMin, yMax),
        min: vertical ? yMin : xMin,
        max: vertical ? yMax : xMax,
      })
    }
    if (!slots.length) return
    // Chain labels on screen (dot and label box of every visible target) and the focus with its plate.
    const z = view.zoom
    const obstacles: Rect[] = []
    for (const target of targets) {
      if (hiddenSide(view, plot, target)) continue
      obstacles.push({ x: frame.toX(target.box.x), y: frame.toY(target.box.y), w: target.box.w * z, h: target.box.h * z })
    }
    if (anchor) obstacles.push({ x: ax - FOCUS_CLEAR.left, y: ay - FOCUS_CLEAR.up, w: FOCUS_CLEAR.left + FOCUS_CLEAR.right, h: FOCUS_CLEAR.up + FOCUS_CLEAR.down })
    const spots = placePills(slots, obstacles)
    slots.forEach((slot, i) => setTransform(slot.el, spots[i].x, spots[i].y))
  }, [targets, anchor, strings, lang])
  useFrameLayout(bus, layout)

  return (
    <>
      {SIDES.map(side => (
        <button
          key={side}
          type="button"
          className="gc-pill"
          data-side={side}
          title={strings.pillTitle}
          style={{ display: 'none' }}
          ref={el => {
            if (el) els.current[side] = el
            else delete els.current[side]
          }}
          onClick={() => onReveal(side)}
          onPointerDown={event => event.stopPropagation()}
        >
          <span />
        </button>
      ))}
    </>
  )
}
