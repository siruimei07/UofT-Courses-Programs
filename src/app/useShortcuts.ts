// Global keyboard shortcuts (design-spec 11.3). Popovers, the search box and the graph handle
// their own keys first and call preventDefault; this listener runs in the bubble phase on window
// and skips anything already handled.
import { useEffect, useRef } from 'react'
import { actions, appStore } from './store'

export interface ShortcutHandlers {
  focusSearch(): void
  zoomIn(): void
  zoomOut(): void
  fitWidth(): void
  resetZoom(): void
  frame(): void
  help(): void
}

export function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (tag !== 'INPUT') return false
  const type = (target as HTMLInputElement).type
  return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file'].includes(type)
}

let escapeConsumed = false

/**
 * Marks the Esc being dispatched as handled by another component that cannot call preventDefault
 * from where it learns about it (GraphCanvas reports Esc through onSelect). Cleared after dispatch.
 */
export function consumeEscape(): void {
  escapeConsumed = true
  setTimeout(() => { escapeConsumed = false })
}

/** Esc ladder rungs 3 and 4: clear the course selection, then the program. Never the record. */
export function escapeLadder(): void {
  const state = appStore.get()
  if (state.focusId) actions.clearFocus()
  else if (state.programId) actions.selectProgram(null)
}

export function useShortcuts(handlers: ShortcutHandlers): void {
  const ref = useRef(handlers)
  useEffect(() => { ref.current = handlers })

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return
      const editable = isEditable(event.target)
      const run = ref.current
      if (event.key === 'Escape') {
        if (escapeConsumed) return
        // In other fields (panel inputs) Esc only leaves the field.
        if (editable) (event.target as HTMLElement).blur()
        else escapeLadder()
        return
      }
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        run.focusSearch()
        return
      }
      if (editable || event.ctrlKey || event.metaKey || event.altKey) return
      const action: (() => void) | undefined = {
        '/': run.focusSearch,
        '+': run.zoomIn,
        '=': run.zoomIn,
        '-': run.zoomOut,
        '0': run.fitWidth,
        '1': run.resetZoom,
        f: run.frame,
        F: run.frame,
        '?': run.help,
      }[event.key]
      if (!action) return
      event.preventDefault()
      action()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}
