// Right panel expand / collapse (design-spec 17): `.panel-col` animates its width for 200 ms and
// the canvas resizes once at the end, not on every frame. While the column moves, the graph stage
// (the box GraphCanvas fills) keeps the width it had when the change started; the graph area clips
// it or shows its own background beside it. The column's width `transitionend` (or a fallback
// timer, should that event never come) releases the stage, so GraphCanvas's ResizeObserver sees a
// single size change. Without a width transition (prefers-reduced-motion) nothing is held.
import { useLayoutEffect, useRef, type RefObject } from 'react'

/** Extra wait after the transition's own duration before the stage is released regardless. */
export const RELEASE_GRACE_MS = 100

/** The computed `transition-*` lists of an element (CSSStyleDeclaration has these). */
export interface TransitionStyle {
  transitionProperty: string
  transitionDuration: string
  transitionDelay: string
}

/** A CSS time ('0.2s', '200ms') in milliseconds; 0 for anything unreadable. */
export function cssTimeMs(text: string): number {
  const match = /^\s*(-?[\d.]+(?:e[+-]?\d+)?)(ms|s)\s*$/i.exec(text)
  if (!match) return 0
  const value = Number(match[1])
  if (!Number.isFinite(value)) return 0
  return match[2].toLowerCase() === 's' ? value * 1000 : value
}

/**
 * How long (delay + duration, ms) a change of `property` animates under these computed transition
 * lists; 0 when it does not. Lists repeat to the length of `transition-property` (CSS Transitions).
 */
export function transitionMs(style: TransitionStyle, property: string): number {
  const properties = style.transitionProperty.split(',').map(item => item.trim().toLowerCase())
  const durations = style.transitionDuration.split(',')
  const delays = style.transitionDelay.split(',')
  let result = 0
  properties.forEach((name, index) => {
    if (name !== property && name !== 'all') return
    const duration = Math.max(0, cssTimeMs(durations[index % durations.length]))
    if (duration <= 0) return
    result = Math.max(result, Math.max(0, duration + cssTimeMs(delays[index % delays.length])))
  })
  return result
}

/** The parts of the panel column the hold listens to. */
export interface ColumnLike {
  addEventListener(type: 'transitionend', listener: (event: { target: unknown; propertyName: string }) => void): void
  removeEventListener(type: 'transitionend', listener: (event: { target: unknown; propertyName: string }) => void): void
}

/** The parts of the graph stage the hold sizes. */
export interface StageLike {
  style: { width: string }
  getBoundingClientRect(): { width: number }
}

export interface StageHold {
  /** Call right after a commit that changed the column's width (before paint). */
  start(): void
  /** Whether the stage is currently held at a fixed width. */
  readonly held: boolean
  /** Releases the stage and stops listening. */
  dispose(): void
}

export interface StageHoldOptions {
  /** Computed style of the column (defaults to getComputedStyle). */
  styleOf?: (column: ColumnLike) => TransitionStyle
  setTimer?: (callback: () => void, ms: number) => unknown
  clearTimer?: (timer: unknown) => void
}

export function createStageHold(column: ColumnLike, stage: StageLike, options: StageHoldOptions = {}): StageHold {
  const styleOf = options.styleOf ?? (element => getComputedStyle(element as unknown as Element))
  const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms))
  const clearTimer = options.clearTimer ?? (timer => clearTimeout(timer as ReturnType<typeof setTimeout>))
  let held = false
  let timer: unknown = null

  const release = () => {
    if (timer !== null) clearTimer(timer)
    timer = null
    if (!held) return
    held = false
    stage.style.width = ''
  }
  // Child transitions (panel content fades) bubble up here: only the column's own width counts.
  const onEnd = (event: { target: unknown; propertyName: string }) => {
    if (event.target === column && event.propertyName === 'width') release()
  }
  column.addEventListener('transitionend', onEnd)

  return {
    start() {
      // Reading the computed style also flushes the new column width: its transition starts at
      // the old value, so the stage still measures its pre-change width here.
      const ms = transitionMs(styleOf(column), 'width')
      if (ms <= 0) {
        release()
        return
      }
      // A reversal mid-way keeps the width held since the first change: one resize at the end.
      if (!held) {
        stage.style.width = `${stage.getBoundingClientRect().width}px`
        held = true
      }
      if (timer !== null) clearTimer(timer)
      timer = setTimer(release, ms + RELEASE_GRACE_MS)
    },
    get held() {
      return held
    },
    dispose() {
      release()
      column.removeEventListener('transitionend', onEnd)
    },
  }
}

/** Holds the graph stage while `.panel-col` animates after `collapsed` changes. */
export function usePanelMotion(
  columnRef: RefObject<HTMLElement | null>,
  stageRef: RefObject<HTMLElement | null>,
  collapsed: boolean,
): void {
  const hold = useRef<StageHold | null>(null)
  useLayoutEffect(() => {
    const column = columnRef.current
    const stage = stageRef.current
    if (!column || !stage) return
    const created = createStageHold(column, stage)
    hold.current = created
    return () => {
      created.dispose()
      if (hold.current === created) hold.current = null
    }
  }, [columnRef, stageRef])

  const previous = useRef(collapsed)
  useLayoutEffect(() => {
    if (previous.current === collapsed) return
    previous.current = collapsed
    hold.current?.start()
  }, [collapsed])
}
