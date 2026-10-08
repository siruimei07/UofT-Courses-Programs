// Builds a StudentRecord from rows (an import, a stored file) that may repeat a course.
import type { RecordStatus } from '../graph/types'
import type { RecordEntryLike } from './engine-types'
import { isFailed } from './evaluate'

export interface RecordRow {
  courseId: string
  status: RecordStatus
  grade?: number
}

/** Passed > in progress > planned > failed; ties keep the higher grade, then the first row. */
function strength(entry: RecordEntryLike): number {
  if (entry.status === 'completed') return isFailed(entry) ? 1 : 4
  return entry.status === 'inProgress' ? 3 : 2
}

function stronger(candidate: RecordEntryLike, current: RecordEntryLike): boolean {
  const difference = strength(candidate) - strength(current)
  return difference > 0 || (difference === 0 && (candidate.grade ?? -1) > (current.grade ?? -1))
}

/** One entry per course id; repeated rows resolve to the strongest one, whatever their order. */
export function recordFromRows(rows: Iterable<RecordRow>): Map<string, RecordEntryLike> {
  const record = new Map<string, RecordEntryLike>()
  for (const row of rows) {
    const entry: RecordEntryLike = row.grade === undefined ? { status: row.status } : { status: row.status, grade: row.grade }
    const current = record.get(row.courseId)
    if (!current || stronger(entry, current)) record.set(row.courseId, entry)
  }
  return record
}
