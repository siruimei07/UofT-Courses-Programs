// The student record as the graph sees it (design-spec 7.2): the statuses the presentation draws
// and the eligibility of everything else. Pure; no React.
import { PASS_GRADE } from '../domain'
import type { CourseEngine } from '../domain/engine-types'
import type { Eligibility, RecordStatus } from '../graph/types'
import { cachedEligibility } from '../ui/panels/record'
import type { RecordEntry } from './store'

/** A completed course with a grade below 50 is a fail (UTM Calendar): it earns no credit and may be retaken. */
export function isFailedEntry(entry: RecordEntry): boolean {
  return entry.status === 'completed' && entry.grade !== undefined && entry.grade < PASS_GRADE
}

/**
 * Record statuses for PresentationInput.record. A failed course counts as not taken, so the map
 * draws it like any other untaken course and its eligibility (the engine keeps failed courses in
 * the eligibility map) can mark it available for a retake.
 */
export function presentationRecord(record: ReadonlyMap<string, RecordEntry>): Map<string, RecordStatus> {
  const statuses = new Map<string, RecordStatus>()
  for (const [id, entry] of record) {
    if (!isFailedEntry(entry)) statuses.set(id, entry.status)
  }
  return statuses
}

/** Whether any course on the record is completed and passed (what "Hide completed" can hide). */
export function hasPassedCourse(record: ReadonlyMap<string, RecordEntry>): boolean {
  for (const entry of record.values()) {
    if (entry.status === 'completed' && !isFailedEntry(entry)) return true
  }
  return false
}

/**
 * Eligibility for the current record, null while it is empty. Shares the panels' memo
 * (cachedEligibility: once per engine and record object), so the map and the panels compute it
 * once per record change and always agree. A failing engine leaves the "available" marks out
 * instead of breaking the map, as in the panels.
 */
export function recordEligibility(engine: CourseEngine, record: ReadonlyMap<string, RecordEntry>): ReadonlyMap<string, Eligibility> | null {
  if (!record.size) return null
  try {
    return cachedEligibility(engine, record)
  } catch {
    return null
  }
}
