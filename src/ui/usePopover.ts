// Shared popover behaviour (design-spec 6.9): close on an outside pointer press or on Esc. Esc is
// caught in the capture phase and stopped, so it is the first rung of the Esc ladder (11.3) and
// never reaches the global handler or the graph.
import { useCallback, useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react'

export interface Popover<Root extends HTMLElement = HTMLDivElement, Trigger extends HTMLElement = HTMLButtonElement> {
  open: boolean
  setOpen: Dispatch<SetStateAction<boolean>>
  toggle(): void
  close(): void
  /** Wraps the trigger and the popover: presses inside it do not close the popover. */
  rootRef: RefObject<Root | null>
  /** Gets focus back when Esc closes the popover. */
  triggerRef: RefObject<Trigger | null>
}

export function usePopover<Root extends HTMLElement = HTMLDivElement, Trigger extends HTMLElement = HTMLButtonElement>(): Popover<Root, Trigger> {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<Root>(null)
  const triggerRef = useRef<Trigger>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
      triggerRef.current?.focus()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [open])

  const toggle = useCallback(() => setOpen(value => !value), [])
  const close = useCallback(() => setOpen(false), [])
  return { open, setOpen, toggle, close, rootRef, triggerRef }
}
