// Layout class of the window (design-spec 6.1). CSS reads it from `data-bp` on the app root, so
// sizes and structure always switch together.
import { useSyncExternalStore } from 'react'

export type Breakpoint = 'wide' | 'standard' | 'compact' | 'narrow'

export function breakpointOf(width: number): Breakpoint {
  if (width >= 1700) return 'wide'
  if (width >= 1440) return 'standard'
  if (width >= 1280) return 'compact'
  return 'narrow'
}

function subscribe(listener: () => void): () => void {
  window.addEventListener('resize', listener)
  return () => window.removeEventListener('resize', listener)
}

export function useBreakpoint(): Breakpoint {
  return useSyncExternalStore(subscribe, () => breakpointOf(window.innerWidth), () => 'wide' as const)
}
