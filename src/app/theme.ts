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

/** Theme fade on the DOM chrome (design-spec 17); the canvas switches instantly. */
export const THEME_FADE_MS = 150
/** How long <html data-theme-fade> stays: the fade plus a frame or two to start it. */
export const THEME_FADE_HOLD_MS = THEME_FADE_MS + 100

/**
 * Keeps <html data-theme> and color-scheme in sync with the store and the OS setting. Each real
 * change (not the first apply) also sets <html data-theme-fade> briefly; app.css fades the chrome
 * backgrounds only while it is there (and never under prefers-reduced-motion).
 */
export function startThemeSync(): () => void {
  let applied: ResolvedTheme | null = null
  let fadeTimer: ReturnType<typeof setTimeout> | null = null
  const root = document.documentElement
  const endFade = () => {
    fadeTimer = null
    delete root.dataset.themeFade
  }
  const apply = () => {
    const theme = resolveTheme(appStore.get().theme, systemTheme())
    if (theme === applied) return
    if (applied !== null) {
      root.dataset.themeFade = ''
      if (fadeTimer !== null) clearTimeout(fadeTimer)
      fadeTimer = setTimeout(endFade, THEME_FADE_HOLD_MS)
    }
    applied = theme
    root.dataset.theme = theme
    root.style.colorScheme = theme
  }
  apply()
  const unsubscribeStore = appStore.subscribe(apply)
  const unsubscribeSystem = subscribeSystem(apply)
  return () => {
    unsubscribeStore()
    unsubscribeSystem()
    if (fadeTimer !== null) clearTimeout(fadeTimer)
    endFade()
  }
}
