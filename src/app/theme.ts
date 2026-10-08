// Resolves the theme preference (system / light / dark) and applies it to <html data-theme>.
import { useSyncExternalStore } from 'react'
import { appStore, useApp } from './store'

export type ResolvedTheme = 'light' | 'dark'

const query = typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: dark)') : null

function subscribeSystem(listener: () => void): () => void {
  query?.addEventListener('change', listener)
  return () => query?.removeEventListener('change', listener)
}

function systemTheme(): ResolvedTheme {
  return query?.matches ? 'dark' : 'light'
}

export function resolveTheme(pref: 'system' | 'light' | 'dark', system: ResolvedTheme): ResolvedTheme {
  return pref === 'system' ? system : pref
}

export function useResolvedTheme(): ResolvedTheme {
  const pref = useApp(state => state.theme)
  const system = useSyncExternalStore(subscribeSystem, systemTheme, () => 'light' as const)
  return resolveTheme(pref, system)
}

/** Keeps <html data-theme> and color-scheme in sync with the store and the OS setting. */
export function startThemeSync(): () => void {
  const apply = () => {
    const theme = resolveTheme(appStore.get().theme, systemTheme())
    const root = document.documentElement
    root.dataset.theme = theme
    root.style.colorScheme = theme
  }
  apply()
  const unsubscribeStore = appStore.subscribe(apply)
  const unsubscribeSystem = subscribeSystem(apply)
  return () => {
    unsubscribeStore()
    unsubscribeSystem()
  }
}
