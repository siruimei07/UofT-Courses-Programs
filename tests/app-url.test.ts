import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appStore, initialAppState } from '../src/app/store'
import { formatHash, parseHash, startUrlSync } from '../src/app/url'

describe('parseHash', () => {
  it('reads campus, course and program', () => {
    expect(parseHash('#/utm?course=CSC148H5&program=ERMAJ1688')).toEqual({ campus: 'UTM', course: 'CSC148H5', program: 'ERMAJ1688' })
  })

  it('upper-cases codes and accepts a bare campus', () => {
    expect(parseHash('#/UTM?course=csc148h5')).toEqual({ campus: 'UTM', course: 'CSC148H5', program: null })
    expect(parseHash('#/utsg')).toEqual({ campus: 'UTSG', course: null, program: null })
  })

  it('rejects unknown campuses, malformed codes and foreign hashes', () => {
    expect(parseHash('#/mars?course=CSC148H5')).toEqual({ campus: null, course: 'CSC148H5', program: null })
    expect(parseHash('#/utm?course=<script>')).toEqual({ campus: 'UTM', course: null, program: null })
    expect(parseHash('#theme=dark')).toEqual({ campus: null, course: null, program: null })
    expect(parseHash('')).toEqual({ campus: null, course: null, program: null })
  })

  it('never carries theme, language or the record', () => {
    expect(parseHash('#/utm?course=CSC148H5&theme=dark&record=x')).toEqual({ campus: 'UTM', course: 'CSC148H5', program: null })
  })
})

describe('formatHash', () => {
  it('writes only the codes of the selection', () => {
    expect(formatHash({ campus: 'UTM', focusId: 'UTM:CSC148H5', programId: 'UTM:ERMAJ1688' })).toBe('#/utm?course=CSC148H5&program=ERMAJ1688')
    expect(formatHash({ campus: 'UTM', focusId: null, programId: null })).toBe('#/utm')
  })

  it('round-trips through parseHash', () => {
    const hash = formatHash({ campus: 'UTM', focusId: 'UTM:MAT232H5', programId: null })
    expect(parseHash(hash)).toEqual({ campus: 'UTM', course: 'MAT232H5', program: null })
  })
})

/** A window with just what startUrlSync touches: location.hash, hashchange and replaceState. */
class FakeWindow {
  location = { hash: '' }
  replaced: string[] = []
  listeners = new Set<() => void>()
  history = { replaceState: (_state: unknown, _title: string, url: string) => { this.replaced.push(url); this.location.hash = url } }
  addEventListener(type: string, listener: () => void) { if (type === 'hashchange') this.listeners.add(listener) }
  removeEventListener(type: string, listener: () => void) { if (type === 'hashchange') this.listeners.delete(listener) }
  /** The user edits the address bar or follows a link. */
  navigate(hash: string) {
    this.location.hash = hash
    this.listeners.forEach(listener => listener())
  }
}

describe('startUrlSync', () => {
  const globals = globalThis as unknown as { window?: unknown }
  let win: FakeWindow
  let stop: (() => void) | null = null
  const courses = new Map([['CSC148H5', 'UTM:CSC148H5'], ['MAT232H5', 'UTM:MAT232H5']])
  const programs = new Map([['ERMAJ1688', 'UTM:ERMAJ1688']])
  const resolve = {
    course: (code: string) => courses.get(code) ?? null,
    program: (code: string) => programs.get(code) ?? null,
  }

  beforeEach(() => {
    win = new FakeWindow()
    globals.window = win
    appStore.set(initialAppState())
  })

  afterEach(() => {
    stop?.()
    stop = null
    delete globals.window
    appStore.set(initialAppState())
  })

  it('applies the hash at start and opens the matching panel', () => {
    win.location.hash = '#/utm?course=csc148h5&program=ERMAJ1688'
    stop = startUrlSync(resolve)
    expect(appStore.get()).toMatchObject({ campus: 'UTM', focusId: 'UTM:CSC148H5', programId: 'UTM:ERMAJ1688', panel: 'course' })
  })

  it('applies later hashchanges, including clearing the selection', () => {
    stop = startUrlSync(resolve)
    win.navigate('#/utm?program=ERMAJ1688')
    expect(appStore.get()).toMatchObject({ focusId: null, programId: 'UTM:ERMAJ1688', panel: 'program' })
    win.navigate('#/utm?course=MAT232H5')
    expect(appStore.get()).toMatchObject({ focusId: 'UTM:MAT232H5', programId: null, panel: 'course' })
    win.navigate('#/utm')
    expect(appStore.get()).toMatchObject({ focusId: null, programId: null })
  })

  it('drops codes that do not resolve and rewrites the hash without them', () => {
    win.location.hash = '#/utm?course=XYZ999H5&program=ERMAJ1688'
    stop = startUrlSync(resolve)
    expect(appStore.get()).toMatchObject({ focusId: null, programId: 'UTM:ERMAJ1688' })
    expect(win.location.hash).toBe('#/utm?program=ERMAJ1688')
    win.navigate('#/utm?course=NOPE')
    expect(win.location.hash).toBe('#/utm')
    expect(appStore.get().programId).toBeNull()
  })

  it('mirrors store changes with replaceState (no history entries), only when the hash differs', () => {
    win.location.hash = '#/utm'
    stop = startUrlSync(resolve)
    expect(win.replaced).toEqual([])
    appStore.set({ focusId: 'UTM:CSC148H5' })
    expect(win.replaced).toEqual(['#/utm?course=CSC148H5'])
    appStore.set({ lang: 'zh' })
    expect(win.replaced).toHaveLength(1)
    appStore.set({ focusId: null, programId: 'UTM:ERMAJ1688' })
    expect(win.replaced.at(-1)).toBe('#/utm?program=ERMAJ1688')
  })

  it('stops listening once stopped', () => {
    win.location.hash = '#/utm'
    stop = startUrlSync(resolve)
    stop()
    stop = null
    win.navigate('#/utm?course=CSC148H5')
    expect(appStore.get().focusId).toBeNull()
    appStore.set({ focusId: 'UTM:MAT232H5' })
    expect(win.replaced).toEqual([])
  })
})
