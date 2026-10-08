// Student record helpers for the My courses tab: grouping, credit totals, course search and JSON
// import/export with readable errors. Pure; no React.
import type { GraphCourse } from '../../data/schema'
import type { RecordEntry } from '../../app/store'
import { parseRecord, serializeRecord } from '../../app/persist'
import type { CourseEngine } from '../../domain/engine-types'
import type { Eligibility, RecordStatus } from '../../graph/types'
import { codeOf, creditsFromCode, parseGrade } from './format'

export const STATUS_ORDER: readonly RecordStatus[] = ['completed', 'inProgress', 'planned']
export const RECORD_FILE_NAME = 'uoft-course-map-record.json'
/** A record of every UTM course is about 100 KB; anything far larger is not a record. */
export const MAX_IMPORT_BYTES = 2_000_000

export interface RecordRow {
  id: string
  code: string
  /** Official title, or null when the course is not in the loaded calendar. */
  title: string | null
  credits: number
  entry: RecordEntry
}

export type RecordGroups = Record<RecordStatus, RecordRow[]>

export function groupRecord(record: ReadonlyMap<string, RecordEntry>, courses: ReadonlyMap<string, GraphCourse>): RecordGroups {
  const groups: RecordGroups = { completed: [], inProgress: [], planned: [] }
  for (const [id, entry] of record) {
    const course = courses.get(id)
    const code = course?.code ?? codeOf(id)
    groups[entry.status].push({ id, code, title: course?.title ?? null, credits: course?.credits ?? creditsFromCode(code), entry })
  }
  for (const status of STATUS_ORDER) groups[status].sort((a, b) => a.code.localeCompare(b.code))
  return groups
}

export type RecordChoice = RecordStatus | 'none'

/**
 * What a click on the record control writes for a course: an entry, null to remove it, or
 * 'unchanged' when the choice is already stored. Only the stored entry is consulted, so an old
 * grade typed earlier can never come back; a grade survives only on a move to Completed.
 */
export function nextRecordEntry(entry: RecordEntry | undefined, choice: RecordChoice): RecordEntry | null | 'unchanged' {
  if (choice === 'none') return entry ? null : 'unchanged'
  if (entry?.status === choice) return 'unchanged'
  return choice === 'completed' && entry?.grade !== undefined ? { status: 'completed', grade: entry.grade } : { status: choice }
}

/** The completed entry a grade edit writes, or 'unchanged' when the text is invalid or already stored. */
export function gradedEntry(entry: RecordEntry | undefined, text: string): RecordEntry | 'unchanged' {
  const parsed = parseGrade(text)
  if (parsed === 'invalid') return 'unchanged'
  const grade = parsed ?? undefined
  if (entry?.status === 'completed' && entry.grade === grade) return 'unchanged'
  return grade === undefined ? { status: 'completed' } : { status: 'completed', grade }
}

/** Grade input text for a stored grade. */
export function gradeText(grade: number | undefined): string {
  return grade === undefined ? '' : String(grade)
}

/**
 * The grade input after the stored grade changed (typing, import, clear all, another tab): what
 * the student typed stays while it still means the stored grade ("080" for 80); otherwise the
 * input shows the stored grade.
 */
export function syncGradeDraft(draft: string, grade: number | undefined): string {
  return parseGrade(draft) === (grade ?? null) ? draft : gradeText(grade)
}

const eligibilityCache = new WeakMap<CourseEngine, WeakMap<ReadonlyMap<string, RecordEntry>, Map<string, Eligibility>>>()

/** engine.eligibility, computed once per engine and record (the record is replaced on every change). */
export function cachedEligibility(engine: CourseEngine, record: ReadonlyMap<string, RecordEntry>): Map<string, Eligibility> {
  let byRecord = eligibilityCache.get(engine)
  if (!byRecord) eligibilityCache.set(engine, (byRecord = new WeakMap()))
  let result = byRecord.get(record)
  if (!result) byRecord.set(record, (result = engine.eligibility(record)))
  return result
}

/** A completed course with a grade below 50 is a fail (UTM Calendar) and earns no credit. */
export function earnsCredit(entry: RecordEntry): boolean {
  return entry.status !== 'completed' || entry.grade === undefined || entry.grade >= 50
}

/** Credits of a group, rounded to avoid 0.1 + 0.2 artefacts. */
export function groupCredits(rows: readonly RecordRow[]): number {
  const sum = rows.reduce((total, row) => total + (earnsCredit(row.entry) ? row.credits : 0), 0)
  return Math.round(sum * 100) / 100
}

export interface StatusTotal {
  count: number
  credits: number
}

export function recordTotals(groups: RecordGroups): Record<RecordStatus, StatusTotal> {
  const total = (rows: readonly RecordRow[]) => ({ count: rows.length, credits: groupCredits(rows) })
  return { completed: total(groups.completed), inProgress: total(groups.inProgress), planned: total(groups.planned) }
}

export type ImportError =
  | { key: 'importNotJson' | 'importNotObject' | 'importFormat' | 'importTooLarge' | 'importUnreadable' }
  | { key: 'importBadId' | 'importBadStatus' | 'importBadGrade'; id: string }
  | { key: 'importFailed'; message: string }

/** Maps a JSON.parse or parseRecord failure to a localisable message. */
export function mapImportError(error: unknown): ImportError {
  if (error instanceof SyntaxError) return { key: 'importNotJson' }
  const message = error instanceof Error ? error.message : String(error)
  if (message === 'Record must be a JSON object') return { key: 'importNotObject' }
  if (message === 'Unsupported record format') return { key: 'importFormat' }
  const withId = /^Invalid (course id|status for|grade for):? (.*)$/.exec(message)
  if (withId) {
    const key = withId[1] === 'course id' ? 'importBadId' : withId[1] === 'status for' ? 'importBadStatus' : 'importBadGrade'
    return { key, id: withId[2] }
  }
  return { key: 'importFailed', message }
}

export type ImportResult = { ok: true; record: Map<string, RecordEntry> } | { ok: false; error: ImportError }

export function importRecordText(text: string): ImportResult {
  if (text.length > MAX_IMPORT_BYTES) return { ok: false, error: { key: 'importTooLarge' } }
  try {
    return { ok: true, record: parseRecord(JSON.parse(text)) }
  } catch (error) {
    return { ok: false, error: mapImportError(error) }
  }
}

export function exportRecordJson(record: ReadonlyMap<string, RecordEntry>): string {
  return `${JSON.stringify(serializeRecord(record), null, 2)}\n`
}

const compact = (text: string) => text.toLowerCase().replace(/\s+/g, '')

/**
 * Course search for "Add a course…", ranked like the header search (design-spec 6.9.1): code
 * prefix (spaces ignored), code contains, title starts with, title contains, all words in title.
 */
export function searchCourses(courses: readonly GraphCourse[], query: string, limit = 8): GraphCourse[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const qc = compact(q)
  const words = q.split(/\s+/)
  const rank = (course: GraphCourse): number => {
    const code = course.code.toLowerCase()
    const title = course.title.toLowerCase()
    if (code.startsWith(qc)) return 0
    if (code.includes(qc)) return 1
    if (title.startsWith(q)) return 2
    if (title.includes(q)) return 3
    if (words.every(word => title.includes(word))) return 4
    return -1
  }
  return courses
    .map(course => ({ course, rank: rank(course) }))
    .filter(item => item.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.course.code.localeCompare(b.course.code))
    .slice(0, limit)
    .map(item => item.course)
}
