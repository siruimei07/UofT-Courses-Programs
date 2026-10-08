// Graph tooltip (design-spec 6.9.4): shown 350 ms after hover rests on a node (or a fork junction),
// 16 px right of and 14 px below the cursor, flipped to stay inside the graph area.
import { useLayoutEffect, useRef, useState } from 'react'

const OFFSET_X = 16
const OFFSET_Y = 14
const EDGE = 4

export type RelationTone = 'pre' | 'unl' | 'prog' | 'none' | 'focus'

export type TooltipContent =
  | {
    kind: 'course'
    code: string
    title: string
    record: string | null
    relation: { text: string; tone: RelationTone } | null
    prereqLabel: string
    prereq: string | null
    coreqLabel: string
    coreq: string | null
  }
  | { kind: 'text'; text: string }

export interface TooltipState {
  content: TooltipContent
  /** Cursor position in graph-area CSS px. */
  x: number
  y: number
}

export interface TooltipProps {
  tip: TooltipState | null
  areaWidth: number
  areaHeight: number
}

export function Tooltip({ tip, areaWidth, areaHeight }: TooltipProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!tip || !el) {
      setPos(null)
      return
    }
    const w = el.offsetWidth
    const h = el.offsetHeight
    let left = tip.x + OFFSET_X
    let top = tip.y + OFFSET_Y
    if (left + w > areaWidth - EDGE) left = Math.max(EDGE, tip.x - OFFSET_X - w)
    if (top + h > areaHeight - EDGE) top = Math.max(EDGE, tip.y - OFFSET_Y - h)
    setPos({ left, top })
  }, [tip, areaWidth, areaHeight])

  if (!tip) return null
  const c = tip.content
  return (
    <div
      className="gc-tooltip"
      role="tooltip"
      ref={ref}
      style={{ transform: pos ? `translate(${pos.left}px, ${pos.top}px)` : undefined, visibility: pos ? 'visible' : 'hidden' }}
    >
      {c.kind === 'text' ? (
        <div className="gc-tip-text" lang="en">{c.text}</div>
      ) : (
        <>
          <div className="gc-tip-head">
            <span className="gc-tip-code" lang="en">{c.code}</span>
            {c.record && <span className="gc-tip-record">{c.record}</span>}
          </div>
          <div className="gc-tip-title" lang="en">{c.title}</div>
          {c.relation && <div className={`gc-tip-rel gc-tone-${c.relation.tone}`}>{c.relation.text}</div>}
          {c.prereq && (
            <div className="gc-tip-req">
              <span className="gc-tip-label">{c.prereqLabel}</span> <span lang="en">{c.prereq}</span>
            </div>
          )}
          {c.coreq && (
            <div className="gc-tip-req gc-tip-coreq">
              <span className="gc-tip-label">{c.coreqLabel}</span> <span lang="en">{c.coreq}</span>
            </div>
          )}
        </>
      )}
    </div>
  )
}
