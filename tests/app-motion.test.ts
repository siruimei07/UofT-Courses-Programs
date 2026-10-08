import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createStageHold, cssTimeMs, RELEASE_GRACE_MS, transitionMs, type ColumnLike, type StageLike, type TransitionStyle,
} from '../src/app/panelMotion'
import { appStore, initialAppState } from '../src/app/store'
import { startThemeSync, THEME_FADE_HOLD_MS } from '../src/app/theme'

describe('CSS transition timing (design-spec 17)', () => {
  it('reads CSS times in ms', () => {
    expect(cssTimeMs('0.2s')).toBe(200)
    expect(cssTimeMs(' 120ms ')).toBe(120)
    expect(cssTimeMs('0s')).toBe(0)
    expect(cssTimeMs('1e-5s')).toBeCloseTo(0.01)
    expect(cssTimeMs('')).toBe(0)
    expect(cssTimeMs('auto')).toBe(0)
  })

  const style = (property: string, duration: string, delay = '0s'): TransitionStyle =>
    ({ transitionProperty: property, transitionDuration: duration, transitionDelay: delay })

  it('finds the width transition among computed lists (repeating short lists)', () => {
    expect(transitionMs(style('width', '0.2s'), 'width')).toBe(200)
    expect(transitionMs(style('background-color, width', '0.15s, 0.2s', '0s, 0.05s'), 'width')).toBe(250)
    expect(transitionMs(style('opacity, width', '0.2s'), 'width')).toBe(200)
    expect(transitionMs(style('all', '0.3s'), 'width')).toBe(300)
  })

  it('is 0 when width does not animate (reduced motion, or only other properties)', () => {
    expect(transitionMs(style('all', '0s'), 'width')).toBe(0)
    expect(transitionMs(style('none', '0.2s'), 'width')).toBe(0)
    expect(transitionMs(style('background-color', '0.15s'), 'width')).toBe(0)
    expect(transitionMs(style('width', '0s', '0.1s'), 'width')).toBe(0)
  })
})

describe('createStageHold: the canvas resizes once, after the panel animation', () => {
  type Listener = (event: { target: unknown; propertyName: string }) => void

  function setup(duration = '0.2s') {
    const listeners = new Set<Listener>()
    const column: ColumnLike = {
      addEventListener: (_type, listener) => { listeners.add(listener) },
      removeEventListener: (_type, listener) => { listeners.delete(listener) },
    }
    let width = 1200
    const stage: StageLike = { style: { width: '' }, getBoundingClientRect: () => ({ width }) }
    const hold = createStageHold(column, stage, {
      styleOf: () => ({ transitionProperty: 'width', transitionDuration: duration, transitionDelay: '0s' }),
    })
    const fire = (target: unknown, propertyName: string) => { for (const listener of [...listeners]) listener({ target, propertyName }) }
    return { column, stage, hold, fire, listeners, setWidth: (value: number) => { width = value } }
  }

  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('pins the stage at its pre-change width until the column width transitionend', () => {
    const { column, stage, hold, fire, setWidth } = setup()
    setWidth(1203.5)
    hold.start()
    expect(stage.style.width).toBe('1203.5px')
    expect(hold.held).toBe(true)
    // Transitions of the panel content bubble up: they do not release the stage.
    fire({}, 'width')
    fire(column, 'opacity')
    expect(stage.style.width).toBe('1203.5px')
    fire(column, 'width')
    expect(stage.style.width).toBe('')
    expect(hold.held).toBe(false)
  })

  it('releases on a fallback timer when transitionend never comes', () => {
    const { stage, hold } = setup()
    hold.start()
    vi.advanceTimersByTime(200 + RELEASE_GRACE_MS - 1)
    expect(stage.style.width).not.toBe('')
    vi.advanceTimersByTime(1)
    expect(stage.style.width).toBe('')
  })

  it('a reversal mid-way keeps the first width and restarts the fallback', () => {
    const { stage, hold, setWidth } = setup()
    hold.start()
    vi.advanceTimersByTime(150)
    setWidth(900)
    hold.start()
    expect(stage.style.width).toBe('1200px')
    vi.advanceTimersByTime(200)
    expect(stage.style.width).toBe('1200px')
    vi.advanceTimersByTime(RELEASE_GRACE_MS)
    expect(stage.style.width).toBe('')
  })

  it('holds nothing without a width transition (prefers-reduced-motion)', () => {
    const { stage, hold } = setup('0s')
    hold.start()
    expect(stage.style.width).toBe('')
    expect(hold.held).toBe(false)
  })

  it('dispose releases the stage and stops listening', () => {
    const { stage, hold, listeners } = setup()
    hold.start()
    hold.dispose()
    expect(stage.style.width).toBe('')
    expect(listeners.size).toBe(0)
    vi.runAllTimers()
    expect(stage.style.width).toBe('')
  })
})

describe('theme change fade (design-spec 17)', () => {
  const globals = globalThis as unknown as { document?: unknown }
  let root: { dataset: Record<string, string>; style: { colorScheme?: string } }
  let stop: (() => void) | null = null

  beforeEach(() => {
    vi.useFakeTimers()
    root = { dataset: {}, style: {} }
    globals.document = { documentElement: root }
    appStore.set(initialAppState())
  })

  afterEach(() => {
    stop?.()
    stop = null
    delete globals.document
    appStore.set(initialAppState())
    vi.useRealTimers()
  })

  it('applies the first theme instantly, then marks each change for a short fade', () => {
    appStore.set({ theme: 'light' })
    stop = startThemeSync()
    expect(root.dataset.theme).toBe('light')
    expect(root.style.colorScheme).toBe('light')
    expect('themeFade' in root.dataset).toBe(false)

    appStore.set({ theme: 'dark' })
    expect(root.dataset.theme).toBe('dark')
    expect(root.dataset.themeFade).toBe('')
    vi.advanceTimersByTime(THEME_FADE_HOLD_MS - 1)
    expect('themeFade' in root.dataset).toBe(true)
    vi.advanceTimersByTime(1)
    expect('themeFade' in root.dataset).toBe(false)
  })

  it('other store changes never start a fade; a quick second change extends it', () => {
    appStore.set({ theme: 'light' })
    stop = startThemeSync()
    appStore.set({ focusId: 'UTM:CSC108H5' })
    expect('themeFade' in root.dataset).toBe(false)

    appStore.set({ theme: 'dark' })
    vi.advanceTimersByTime(THEME_FADE_HOLD_MS - 50)
    appStore.set({ theme: 'light' })
    vi.advanceTimersByTime(THEME_FADE_HOLD_MS - 1)
    expect(root.dataset.themeFade).toBe('')
    vi.advanceTimersByTime(1)
    expect('themeFade' in root.dataset).toBe(false)
  })

  it('stopping the sync clears a pending fade', () => {
    appStore.set({ theme: 'light' })
    stop = startThemeSync()
    appStore.set({ theme: 'dark' })
    stop()
    stop = null
    expect('themeFade' in root.dataset).toBe(false)
  })
})

describe('chrome motion CSS (design-spec 17)', () => {
  const css = readFileSync('src/ui/app.css', 'utf8').replace(/\r\n/g, '\n')
  const reduced = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? ''

  it('animates the panel column width for 200 ms with the standard easing', () => {
    expect(css).toMatch(/\.panel-col \{[^}]*transition: width 200ms cubic-bezier\(0\.2, 0, 0, 1\);/)
  })

  it('popovers enter over 120 ms with opacity and a 4 px rise', () => {
    expect(css).toMatch(/@keyframes pop-in \{ from \{ opacity: 0; transform: translateY\(4px\); \} \}/)
    expect(css).toMatch(/\.popover \{[^}]*animation: pop-in 120ms/)
  })

  it('fades chrome backgrounds for 150 ms on a theme change, never inside the graph area', () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: no-preference\) \{\n\s*:root\[data-theme-fade\] [^{]*:not\(\.graph-area, \.graph-area \*\) \{\n\s*transition: background-color 150ms/)
  })

  it('switches the popover and panel motion off under prefers-reduced-motion', () => {
    expect(reduced).toMatch(/\.popover, \.popover\.shortcuts \{ animation: none; \}/)
    expect(reduced).toMatch(/\.panel-col \{ transition: none; \}/)
  })
})
