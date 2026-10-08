import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parsePrefs, parseRecord, PREFS_KEY, RECORD_KEY, serializeRecord, startPersistence } from '../src/app/persist'
import { appStore, initialAppState } from '../src/app/store'

class MemoryStorage {
  data = new Map<string, string>()
  getItem(key: string) { return this.data.get(key) ?? null }
  setItem(key: string, value: string) { this.data.set(key, value) }
  removeItem(key: string) { this.data.delete(key) }
}

const globals = globalThis as unknown as { window?: unknown }

describe('parsePrefs', () => {
  it('keeps valid preferences and drops anything else', () => {
    expect(parsePrefs({
      theme: 'dark', lang: 'zh', depth: 'direct', titles: true, panelCollapsed: true, onboarded: true,
      home: { kind: 'subject', id: 'CSC' }, hideUnrelated: 'yes', extra: 1,
    })).toEqual({ theme: 'dark', lang: 'zh', depth: 'direct', titles: true, panelCollapsed: true, onboarded: true, home: { kind: 'subject', id: 'CSC' } })
    expect(parsePrefs({ theme: 'sepia', lang: 'fr', home: { kind: 'course', id: 'X' } })).toEqual({})
    expect(parsePrefs(null)).toEqual({})
    expect(parsePrefs('dark')).toEqual({})
  })
})

describe('parseRecord / serializeRecord', () => {
  it('round-trips a record sorted by id', () => {
    const record = parseRecord({ schemaVersion: 1, courses: [
      { id: 'UTM:MAT102H5', status: 'inProgress' },
      { id: 'UTM:CSC108H5', status: 'completed', grade: 85 },
    ] })
    expect(serializeRecord(record)).toEqual({ schemaVersion: 1, courses: [
      { id: 'UTM:CSC108H5', status: 'completed', grade: 85 },
      { id: 'UTM:MAT102H5', status: 'inProgress' },
    ] })
  })

  it('rejects malformed input with a readable message', () => {
    expect(() => parseRecord(null)).toThrow('JSON object')
    expect(() => parseRecord({ schemaVersion: 2, courses: [] })).toThrow('Unsupported')
    expect(() => parseRecord({ schemaVersion: 1, courses: [{ id: 'CSC108', status: 'completed' }] })).toThrow('Invalid course id')
    expect(() => parseRecord({ schemaVersion: 1, courses: [{ id: 'UTM:CSC108H5', status: 'done' }] })).toThrow('Invalid status')
    expect(() => parseRecord({ schemaVersion: 1, courses: [{ id: 'UTM:CSC108H5', status: 'completed', grade: 101 }] })).toThrow('Invalid grade')
  })

  it('rejects a course listed twice, naming it (the panels map this exact text)', () => {
    const twice = (second: object) => () => parseRecord({ schemaVersion: 1, courses: [
      { id: 'UTM:CSC108H5', status: 'completed', grade: 42 },
      { id: 'UTM:MAT102H5', status: 'planned' },
      { id: 'UTM:CSC108H5', ...second },
    ] })
    // Identical rows and conflicting ones alike: which status or grade would win is ambiguous.
    expect(twice({ status: 'completed', grade: 42 })).toThrow(new Error('Duplicate course id: UTM:CSC108H5'))
    expect(twice({ status: 'inProgress' })).toThrow(new Error('Duplicate course id: UTM:CSC108H5'))
    // The existing messages are unchanged and still come first for a bad row.
    expect(twice({ status: 'done' })).toThrow(new Error('Duplicate course id: UTM:CSC108H5'))
    expect(() => parseRecord({ schemaVersion: 1, courses: [{ id: 'UTM:CSC108H5', status: 'done' }, { id: 'UTM:CSC108H5', status: 'planned' }] }))
      .toThrow(new Error('Invalid status for UTM:CSC108H5'))
    // Ids differing only by the campus digit are different courses.
    expect(parseRecord({ schemaVersion: 1, courses: [{ id: 'UTM:CSC108H5', status: 'planned' }, { id: 'UTSG:CSC108H1', status: 'planned' }] }).size).toBe(2)
  })

  it('a serialized record never trips the duplicate check', () => {
    expect(() => parseRecord(serializeRecord(new Map([['UTM:CSC108H5', { status: 'completed' as const }]])))).not.toThrow()
  })
})

describe('startPersistence', () => {
  let storage: MemoryStorage
  let stop: (() => void) | null = null

  beforeEach(() => {
    storage = new MemoryStorage()
    globals.window = { localStorage: storage }
    appStore.set(initialAppState())
  })

  afterEach(() => {
    stop?.()
    stop = null
    delete globals.window
    appStore.set(initialAppState())
  })

  it('loads prefs and the record, then writes changes back', () => {
    storage.setItem(PREFS_KEY, JSON.stringify({ theme: 'dark', onboarded: true }))
    storage.setItem(RECORD_KEY, JSON.stringify({ schemaVersion: 1, courses: [{ id: 'UTM:CSC108H5', status: 'completed' }] }))
    stop = startPersistence()
    expect(appStore.get().theme).toBe('dark')
    expect(appStore.get().onboarded).toBe(true)
    expect(appStore.get().record.get('UTM:CSC108H5')).toEqual({ status: 'completed' })

    appStore.set({ lang: 'zh', focusId: 'UTM:CSC148H5' })
    const prefs = JSON.parse(storage.getItem(PREFS_KEY) ?? '{}')
    expect(prefs.lang).toBe('zh')
    // Selection never goes to storage.
    expect(JSON.stringify(prefs)).not.toContain('CSC148H5')
  })

  it('migrates the development record key once', () => {
    storage.setItem('uoft-course-map:record:v1', JSON.stringify({ schemaVersion: 1, courses: [{ id: 'UTM:MAT102H5', status: 'planned' }] }))
    stop = startPersistence()
    expect(appStore.get().record.get('UTM:MAT102H5')).toEqual({ status: 'planned' })
    expect(storage.getItem('uoft-course-map:record:v1')).toBeNull()
    expect(storage.getItem(RECORD_KEY)).toContain('MAT102H5')
  })

  it('keeps working in memory when storage throws', () => {
    globals.window = { localStorage: { getItem() { throw new Error('blocked') }, setItem() { throw new Error('blocked') }, removeItem() {} } }
    stop = startPersistence()
    expect(() => appStore.set({ theme: 'light' })).not.toThrow()
    expect(appStore.get().theme).toBe('light')
  })

  it('ignores a corrupt stored record', () => {
    storage.setItem(RECORD_KEY, '{"schemaVersion":1,"courses":[{"id":"bad"}]}')
    stop = startPersistence()
    expect(appStore.get().record.size).toBe(0)
  })

  it('ignores a stored record that lists a course twice', () => {
    storage.setItem(RECORD_KEY, JSON.stringify({ schemaVersion: 1, courses: [
      { id: 'UTM:CSC108H5', status: 'completed' }, { id: 'UTM:CSC108H5', status: 'planned' },
    ] }))
    stop = startPersistence()
    expect(appStore.get().record.size).toBe(0)
  })
})
