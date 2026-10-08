// localStorage persistence for preferences and the student record. Storage can be missing or
// throw (private mode, blocked site data); the app must work without it.
import type { RecordStatus } from '../graph/types'
import { appStore, type AppState, type Depth, type Lang, type RecordEntry, type ThemePref } from './store'

export const PREFS_KEY = 'uoft-course-map:prefs:v1'
export const RECORD_KEY = 'uoft-course-map:record:v1'

const STATUSES: readonly RecordStatus[] = ['completed', 'inProgress', 'planned']
const COURSE_ID = /^(UTM|UTSG|UTSC):[A-Z0-9]{6,10}$/

interface StoredPrefs {
  theme?: ThemePref
  lang?: Lang
  depth?: Depth
  hideUnrelated?: boolean
  hideCompleted?: boolean
  showAllEdges?: boolean
}

export interface StoredRecord {
  schemaVersion: 1
  courses: { id: string; status: RecordStatus; grade?: number }[]
}

function read(key: string): unknown {
  try {
    const raw = window.localStorage.getItem(key)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function write(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Storage unavailable: keep working in memory.
  }
}

function pickEnum<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return allowed.includes(value as T) ? (value as T) : undefined
}

export function parsePrefs(value: unknown): Partial<AppState> {
  if (!value || typeof value !== 'object') return {}
  const prefs = value as StoredPrefs
  const result: Partial<AppState> = {}
  const theme = pickEnum(prefs.theme, ['system', 'light', 'dark'] as const)
  const lang = pickEnum(prefs.lang, ['en', 'zh'] as const)
  const depth = pickEnum(prefs.depth, ['all', 'direct'] as const)
  if (theme) result.theme = theme
  if (lang) result.lang = lang
  if (depth) result.depth = depth
  for (const key of ['hideUnrelated', 'hideCompleted', 'showAllEdges'] as const) {
    if (typeof prefs[key] === 'boolean') result[key] = prefs[key]
  }
  return result
}

/** Validates an imported or stored record; throws with a readable message on bad input. */
export function parseRecord(value: unknown): Map<string, RecordEntry> {
  if (!value || typeof value !== 'object') throw new Error('Record must be a JSON object')
  const stored = value as Partial<StoredRecord>
  if (stored.schemaVersion !== 1 || !Array.isArray(stored.courses)) throw new Error('Unsupported record format')
  const record = new Map<string, RecordEntry>()
  for (const item of stored.courses) {
    if (!item || typeof item.id !== 'string' || !COURSE_ID.test(item.id)) throw new Error(`Invalid course id: ${String(item?.id)}`)
    const status = pickEnum(item.status, STATUSES)
    if (!status) throw new Error(`Invalid status for ${item.id}`)
    const entry: RecordEntry = { status }
    if (item.grade !== undefined) {
      if (typeof item.grade !== 'number' || !Number.isFinite(item.grade) || item.grade < 0 || item.grade > 100) {
        throw new Error(`Invalid grade for ${item.id}`)
      }
      entry.grade = item.grade
    }
    record.set(item.id, entry)
  }
  return record
}

export function serializeRecord(record: ReadonlyMap<string, RecordEntry>): StoredRecord {
  const courses = [...record.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, entry]) => (entry.grade === undefined ? { id, status: entry.status } : { id, status: entry.status, grade: entry.grade }))
  return { schemaVersion: 1, courses }
}

/** Loads stored state into the store and keeps storage in sync afterwards. */
export function startPersistence(): () => void {
  const patch: Partial<AppState> = parsePrefs(read(PREFS_KEY))
  const storedRecord = read(RECORD_KEY)
  if (storedRecord) {
    try {
      patch.record = parseRecord(storedRecord)
    } catch {
      // Corrupt record: ignore rather than block the app.
    }
  }
  appStore.set(patch)

  let last = appStore.get()
  return appStore.subscribe(() => {
    const state = appStore.get()
    if (state.record !== last.record) write(RECORD_KEY, serializeRecord(state.record))
    if (
      state.theme !== last.theme || state.lang !== last.lang || state.depth !== last.depth ||
      state.hideUnrelated !== last.hideUnrelated || state.hideCompleted !== last.hideCompleted ||
      state.showAllEdges !== last.showAllEdges
    ) {
      const prefs: StoredPrefs = {
        theme: state.theme, lang: state.lang, depth: state.depth,
        hideUnrelated: state.hideUnrelated, hideCompleted: state.hideCompleted, showAllEdges: state.showAllEdges,
      }
      write(PREFS_KEY, prefs)
    }
    last = state
  })
}
