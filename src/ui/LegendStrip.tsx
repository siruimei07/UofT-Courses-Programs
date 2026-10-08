// Contextual legend strip under the graph (design-spec 6.6). Glyphs are drawn with the canvas
// tokens. The strip never scrolls: items that do not fit move into a "+n more" popover, lowest
// priority first, after the right-hand hint has given way.
import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useApp } from '../app/store'
import { format, useStrings } from '../i18n'
import { legendStrings } from './strings'
import { usePopover } from './usePopover'

type Glyph =
  | 'course' | 'link' | 'stub' | 'coreq-faint' | 'coreq-chain' | 'selected' | 'pre-direct' | 'pre-trans' | 'unl-direct'
  | 'unl-trans' | 'mini' | 'fork' | 'program' | 'program-link' | 'completed' | 'in-progress' | 'planned' | 'available'

export type LegendMode = 'overview' | 'chain' | 'program'

interface Item {
  glyph: Glyph
  label: string
}

const ring = (stroke: string, r: number, width = 1.4, dash?: string) => (
  <circle cx="11" cy="6" r={r} fill="none" stroke={stroke} strokeWidth={width} strokeDasharray={dash} />
)

export function LegendGlyph({ glyph }: { glyph: Glyph }) {
  let body
  switch (glyph) {
    case 'course': body = <circle cx="11" cy="6" r="3.75" fill="var(--node-default)" />; break
    case 'link': body = <>
      <path d="M3 9.5C10 9.5 12 2.5 19 2.5" fill="none" stroke="var(--edge-faint)" strokeWidth="1.2" />
      <circle cx="3" cy="9.5" r="2" fill="var(--node-default)" /><circle cx="19" cy="2.5" r="2" fill="var(--node-default)" />
    </>; break
    case 'stub': body = <>
      <path d="M1 6H8M14 6H21" stroke="var(--edge-faint)" strokeWidth="1.2" />
      <circle cx="8" cy="6" r="1.6" fill="var(--edge-faint)" /><circle cx="14" cy="6" r="1.6" fill="var(--edge-faint)" />
    </>; break
    case 'coreq-faint': body = <path d="M1 6H21" stroke="var(--edge-faint)" strokeWidth="1.3" strokeDasharray="4 3" />; break
    case 'coreq-chain': body = <path d="M1 6H21" stroke="var(--edge-prereq-direct)" strokeWidth="1.6" strokeDasharray="4 3" />; break
    case 'selected': body = <>{ring('var(--node-selected-ring)', 4.6, 1.6)}<circle cx="11" cy="6" r="2.1" fill="var(--node-selected-ring)" /></>; break
    case 'pre-direct': body = <circle cx="11" cy="6" r="4.2" fill="var(--node-prereq-direct)" />; break
    case 'pre-trans': body = <circle cx="11" cy="6" r="3.6" fill="var(--surface)" stroke="var(--node-prereq-transitive)" strokeWidth="1.5" />; break
    case 'unl-direct': body = <circle cx="11" cy="6" r="4.2" fill="var(--node-unlock-direct)" />; break
    case 'unl-trans': body = <circle cx="11" cy="6" r="3.6" fill="var(--surface)" stroke="var(--node-unlock-transitive)" strokeWidth="1.5" />; break
    case 'mini': body = <circle cx="11" cy="6" r="2.25" fill="var(--node-mini)" />; break
    case 'fork': body = <>
      <path d="M1 2C7 2 8 6 12 6M1 10C7 10 8 6 12 6M17 6H21" fill="none" stroke="var(--edge-prereq-direct)" strokeWidth="1.3" />
      <circle cx="14.5" cy="6" r="2.6" fill="var(--surface)" stroke="var(--edge-prereq-direct)" strokeWidth="1.4" />
    </>; break
    case 'program': body = <><circle cx="11" cy="6" r="3.4" fill="var(--node-program)" />{ring('var(--node-program)', 5.4, 1.2)}</>; break
    case 'program-link': body = <path d="M2 9.5C9 9.5 13 2.5 20 2.5" fill="none" stroke="var(--edge-program)" strokeWidth="1.5" />; break
    case 'completed': body = <>
      <rect x="6.75" y="1.75" width="8.5" height="8.5" rx="2" fill="var(--node-completed)" />
      <path d="M8.8 6.1 10.4 7.7 13.3 4.4" fill="none" stroke="var(--surface)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </>; break
    case 'in-progress': body = <>{ring('var(--node-in-progress)', 4, 1.5)}<path d="M11 2a4 4 0 0 0 0 8Z" fill="var(--node-in-progress)" /></>; break
    case 'planned': body = <>{ring('var(--node-planned)', 4, 1.5, '2 1.5')}<circle cx="11" cy="6" r="1.5" fill="var(--node-planned)" /></>; break
    case 'available': body = <><circle cx="11" cy="6" r="2.8" fill="var(--node-default)" />{ring('var(--node-available)', 5.2, 1.3)}</>; break
  }
  return <svg className="legend-glyph" width="22" height="12" viewBox="0 0 22 12" aria-hidden="true" focusable="false">{body}</svg>
}

function LegendItem({ item }: { item: Item }) {
  return <span className="legend-item"><LegendGlyph glyph={item.glyph} />{item.label}</span>
}

const GAP = 16
const HINT_GAP = 24

export function LegendStrip({ mode, recordActive }: { mode: LegendMode; recordActive: boolean }) {
  const t = useStrings(legendStrings)
  const lang = useApp(state => state.lang)
  const stripRef = useRef<HTMLDivElement>(null)
  const measureRef = useRef<HTMLDivElement>(null)
  const more = usePopover()

  const items = useMemo<Item[]>(() => {
    const base: Item[] = mode === 'chain'
      ? [
        { glyph: 'selected', label: t.selected },
        { glyph: 'pre-direct', label: t.neededDirectly },
        { glyph: 'pre-trans', label: t.neededEarlier },
        { glyph: 'unl-direct', label: t.unlocksDirectly },
        { glyph: 'unl-trans', label: t.unlocksLater },
        { glyph: 'mini', label: t.notInChain },
        { glyph: 'fork', label: t.anyOf },
        { glyph: 'coreq-chain', label: t.coreq },
      ]
      : mode === 'program'
        ? [
          { glyph: 'program', label: t.programCourse },
          { glyph: 'program-link', label: t.programLink },
          { glyph: 'mini', label: t.notInProgram },
        ]
        : [
          { glyph: 'course', label: t.course },
          { glyph: 'link', label: t.link },
          { glyph: 'stub', label: t.stub },
          { glyph: 'coreq-faint', label: t.coreqShort },
        ]
    if (!recordActive) return base
    return [
      ...base,
      { glyph: 'completed', label: t.completed },
      { glyph: 'in-progress', label: t.inProgress },
      { glyph: 'planned', label: t.planned },
      { glyph: 'available', label: t.available },
    ]
  }, [mode, recordActive, t])

  const [fit, setFit] = useState({ count: items.length, hint: true })

  useLayoutEffect(() => {
    const strip = stripRef.current
    const measure = measureRef.current
    if (!strip || !measure) return
    const compute = () => {
      const style = getComputedStyle(strip)
      const available = strip.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
      const widths = [...measure.children].map(child => child.getBoundingClientRect().width)
      const itemWidths = widths.slice(0, items.length)
      const [hintWidth = 0, moreWidth = 0] = widths.slice(items.length)
      const total = itemWidths.reduce((sum, width) => sum + width, 0) + GAP * Math.max(0, items.length - 1)
      if (total + HINT_GAP + hintWidth <= available) return setFit({ count: items.length, hint: true })
      if (total <= available) return setFit({ count: items.length, hint: false })
      let used = moreWidth
      let count = 0
      while (count < items.length && used + itemWidths[count] + GAP <= available) used += itemWidths[count++] + GAP
      setFit({ count, hint: false })
    }
    compute()
    const observer = new ResizeObserver(compute)
    observer.observe(strip)
    return () => observer.disconnect()
  }, [items, lang])

  const visible = items.slice(0, fit.count)
  const hidden = items.slice(fit.count)

  return (
    <div className="legend-strip" ref={stripRef} role="group" aria-label={t.label}>
      <div className="legend-measure" ref={measureRef} aria-hidden="true">
        {items.map(item => <LegendItem key={item.glyph} item={item} />)}
        <span className="legend-hint">{t.hint}</span>
        <span className="chip chip-small legend-more">{format(t.more, { n: 8 })}</span>
      </div>
      <ul className="legend-items">
        {visible.map(item => <li key={item.glyph}><LegendItem item={item} /></li>)}
      </ul>
      {hidden.length > 0 && (
        <div className="menu-root legend-more-root" ref={more.rootRef}>
          <button ref={more.triggerRef} type="button" className="chip chip-small legend-more" aria-expanded={more.open}
            title={t.moreTitle} onClick={more.toggle}>
            {format(t.more, { n: hidden.length })}
          </button>
          {more.open && (
            <ul className="popover legend-popover" aria-label={t.moreTitle}>
              {hidden.map(item => <li key={item.glyph}><LegendItem item={item} /></li>)}
            </ul>
          )}
        </div>
      )}
      {fit.hint && <span className="legend-hint">{t.hint}</span>}
    </div>
  )
}
