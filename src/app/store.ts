// Tiny external store (useSyncExternalStore) holding all app state. Selectors passed to
// useApp must return primitives or references that already live in the state; returning a
// freshly built object on every call re-renders forever.
import { useSyncExternalStore } from 'react'
import type { CampusId } from '../data/schema'
import type { RecordStatus } from '../graph/types'

export type ThemePref = 'system' | 'light' | 'dark'
export type Lang = 'en' | 'zh'
export type Depth = 'all' | 'direct'
export type PanelId = 'course' | 'program' | 'record' | null

/** Where a returning visitor lands when the URL names no course or program. */
export interface HomePref {
  kind: 'subject' | 'program'
  id: string
}

export interface RecordEntry {
  status: RecordStatus
  /** Final percentage grade, when the student chose to enter it. */
  grade?: number
}

export interface AppState {
  campus: CampusId
  focusId: string | null
  programId: string | null
  depth: Depth
  hideUnrelated: boolean
  hideCompleted: boolean
  showAllEdges: boolean
  /** Titles toggle: overview nodes show titles; chain titles always 'all'. */
  titles: boolean
  /** Visible levels; null = all. */
  levels: ReadonlySet<number> | null
  /** Visible subjects; null = all. */
  subjects: ReadonlySet<string> | null
  /** Student record keyed by course id. Replaced (never mutated) on change. */
  record: ReadonlyMap<string, RecordEntry>
  theme: ThemePref
  lang: Lang
  panel: PanelId
  /** Right panel collapsed to its rail. */
  panelCollapsed: boolean
  home: HomePref | null
  /** First-visit start strip dismissed. */
  onboarded: boolean
}

type Listener = () => void
type Update<T> = Partial<T> | ((state: T) => Partial<T>)

export interface Store<T> {
  get(): T
  set(update: Update<T>): void
  subscribe(listener: Listener): () => void
}

export function createStore<T extends object>(initial: T): Store<T> {
  let state = initial
  const listeners = new Set<Listener>()
  return {
    get: () => state,
    set(update) {
      const patch = typeof update === 'function' ? update(state) : update
      const keys = Object.keys(patch) as (keyof T)[]
      if (keys.every(key => Object.is(patch[key], state[key]))) return
      state = { ...state, ...patch }
      listeners.forEach(listener => listener())
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

export function initialAppState(): AppState {
  return {
    campus: 'UTM',
    focusId: null,
    programId: null,
    depth: 'all',
    hideUnrelated: false,
    hideCompleted: false,
    showAllEdges: false,
    titles: false,
    levels: null,
    subjects: null,
    record: new Map(),
    theme: 'system',
    lang: 'en',
    panel: null,
    panelCollapsed: false,
    home: null,
    onboarded: false,
  }
}

export const appStore = createStore<AppState>(initialAppState())

export function useApp<S>(selector: (state: AppState) => S): S {
  return useSyncExternalStore(appStore.subscribe, () => selector(appStore.get()))
}

// ---------------------------------------------------------------------------
// Actions. Components call these instead of appStore.set directly.

export const actions = {
  selectCourse(id: string | null) {
    appStore.set(state => ({ focusId: id, panel: id ? 'course' : state.panel === 'course' ? null : state.panel }))
  },
  selectProgram(id: string | null) {
    appStore.set(state => ({ programId: id, panel: id ? 'program' : state.panel === 'program' ? null : state.panel }))
  },
  openPanel(panel: PanelId) {
    appStore.set({ panel })
  },
  /** Opens a tab and expands the panel if it was collapsed to its rail. */
  showPanel(panel: Exclude<PanelId, null>) {
    appStore.set({ panel, panelCollapsed: false })
  },
  setPanelCollapsed(panelCollapsed: boolean) {
    appStore.set({ panelCollapsed })
  },
  setDepth(depth: Depth) {
    appStore.set({ depth })
  },
  toggle(key: 'hideUnrelated' | 'hideCompleted' | 'showAllEdges' | 'titles' | 'panelCollapsed') {
    appStore.set(state => ({ [key]: !state[key] }))
  },
  setLevels(levels: ReadonlySet<number> | null) {
    appStore.set({ levels: levels && levels.size ? levels : null })
  },
  /** null = all subjects; an empty set is kept ("None" in the subject picker, then pick some). */
  setSubjects(subjects: ReadonlySet<string> | null) {
    appStore.set({ subjects })
  },
  setRecord(courseId: string, entry: RecordEntry | null) {
    appStore.set(state => {
      const record = new Map(state.record)
      if (entry) record.set(courseId, entry)
      else record.delete(courseId)
      return { record }
    })
  },
  replaceRecord(record: ReadonlyMap<string, RecordEntry>) {
    appStore.set({ record })
  },
  setTheme(theme: ThemePref) {
    appStore.set({ theme })
  },
  setLang(lang: Lang) {
    appStore.set({ lang })
  },
  setHome(home: HomePref | null) {
    appStore.set({ home })
  },
  setOnboarded() {
    appStore.set({ onboarded: true })
  },
  clearFocus() {
    appStore.set(state => ({ focusId: null, panel: state.panel === 'course' ? null : state.panel }))
  },
}
