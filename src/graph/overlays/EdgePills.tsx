// Edge-of-view indicators (design-spec 10.3): at most one pill per side counting chain (or
// program) courses whose dots are outside the plot. Text and position update every frame; a click
// pans just enough to reveal the nearest hidden group, without changing the zoom.
import { useCallback, useRef } from 'react'
import type { Lang } from '../../app/store'
import { format, formatNumber } from '../../i18n'
import type { GraphStrings } from '../strings'
import { countHidden, type PillTarget, type Side, type SideCount } from '../viewport'
import { clamp, setShown, setTransform, useFrameLayout, type FrameBus, type FrameInfo } from './frame'

const SIDES: readonly Side[] = ['left', 'right', 'top', 'bottom']
const INSET = 10
/** Clear of the 10 px scrollbars (16 px from the right / bottom edge). */
const SCROLLBAR_CLEAR = 16
const PILL_H = 24

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
    const counts = targets.length ? countHidden(view, plot, targets) : null
    const ax = anchor ? frame.toX(anchor.x) : plot.left + plot.width / 2
    const ay = anchor ? frame.toY(anchor.y) : plot.top + plot.height / 2
    for (const side of SIDES) {
      const el = els.current[side]
      if (!el) continue
      const count = counts?.[side]
      if (!count || !count.total) {
        setShown(el, false)
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
      const right = frame.width - SCROLLBAR_CLEAR
      const bottom = frame.height - SCROLLBAR_CLEAR
      const yMin = plot.top + INSET
      const yMax = bottom - PILL_H
      const xMin = plot.left + INSET
      const xMax = right - w
      if (side === 'left') setTransform(el, xMin, clamp(ay - PILL_H / 2, yMin, yMax))
      else if (side === 'right') setTransform(el, xMax, clamp(ay - PILL_H / 2, yMin, yMax))
      else if (side === 'top') setTransform(el, clamp(ax - w / 2, xMin, xMax), yMin)
      else setTransform(el, clamp(ax - w / 2, xMin, xMax), yMax)
    }
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
