import { describe, expect, it } from 'vitest'
import type { RecordEntry } from '../src/app/store'
import type { GraphCourse } from '../src/data/schema'
import type { CourseEngine } from '../src/domain/engine-types'
import type { Eligibility } from '../src/graph/types'
import {
  cachedEligibility, earnsCredit, exportRecordJson, gradedEntry, gradeText, groupCredits, groupRecord, importRecordText, mapImportError,
  nextRecordEntry, recordTotals, searchCourses, syncGradeDraft,
} from '../src/ui/panels/record'

const course = (code: string, title: string, credits = 0.5): GraphCourse => ({
  id: `UTM:${code}`, code, title, subject: code.slice(0, 3), level: Number(code[3]) * 100, credits,
})
const catalog = [
  course('CSC108H5', 'Introduction to Computer Programming'),
  course('CSC148H5', 'Introduction to Computer Science'),
  course('CSC236H5', 'Introduction to the Theory of Computation'),
  course('MAT135H5', 'Differential Calculus'),
  course('MAT137Y5', 'Calculus', 1),
  course('PHL245H5', 'Modern Symbolic Logic'),
  course('STA107H5', 'An Introduction to Probability and Modelling'),
]
const courses = new Map(catalog.map(c => [c.id, c]))

describe('record grouping and credits', () => {
  const record = new Map<string, RecordEntry>([
    ['UTM:MAT137Y5', { status: 'completed', grade: 81 }],
    ['UTM:CSC108H5', { status: 'completed' }],
    ['UTM:MAT135H5', { status: 'completed', grade: 42 }],
    ['UTSG:CSC111H1', { status: 'completed', grade: 90 }],
    ['UTM:CSC148H5', { status: 'inProgress' }],
    ['UTM:CSC236H5', { status: 'planned' }],
    ['UTM:XYZ999Y5', { status: 'planned' }],
  ])
  const groups = groupRecord(record, courses)

  it('groups by status, sorted by code, with titles from the calendar', () => {
    expect(groups.completed.map(row => row.code)).toEqual(['CSC108H5', 'CSC111H1', 'MAT135H5', 'MAT137Y5'])
    expect(groups.inProgress.map(row => row.code)).toEqual(['CSC148H5'])
    expect(groups.planned.map(row => row.code)).toEqual(['CSC236H5', 'XYZ999Y5'])
    expect(groups.completed[0].title).toBe('Introduction to Computer Programming')
    expect(groups.completed[1].title).toBeNull()
  })

  it('takes credits from the calendar, else from the H / Y code', () => {
    expect(groups.completed.find(row => row.code === 'MAT137Y5')?.credits).toBe(1)
    expect(groups.completed.find(row => row.code === 'CSC111H1')?.credits).toBe(0.5)
    expect(groups.planned.find(row => row.code === 'XYZ999Y5')?.credits).toBe(1)
  })

  it('counts every course but no credit for a failed grade', () => {
    expect(earnsCredit({ status: 'completed', grade: 49.5 })).toBe(false)
    expect(earnsCredit({ status: 'completed', grade: 50 })).toBe(true)
    expect(earnsCredit({ status: 'completed' })).toBe(true)
    expect(earnsCredit({ status: 'planned', grade: 10 })).toBe(true)
    expect(recordTotals(groups)).toEqual({
      completed: { count: 4, credits: 2 },
      inProgress: { count: 1, credits: 0.5 },
      planned: { count: 2, credits: 1.5 },
    })
  })

  it('rounds sums so 0.1-style artefacts never show', () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({ id: `${i}`, code: `${i}`, title: null, credits: 0.1, entry: { status: 'planned' as const } }))
    expect(groupCredits(rows)).toBe(0.3)
  })
})

describe('import and export', () => {
  it('round-trips through the exported JSON', () => {
    const record = new Map<string, RecordEntry>([['UTM:CSC148H5', { status: 'inProgress' }], ['UTM:CSC108H5', { status: 'completed', grade: 88 }]])
    const text = exportRecordJson(record)
    expect(JSON.parse(text)).toEqual({ schemaVersion: 1, courses: [
      { id: 'UTM:CSC108H5', status: 'completed', grade: 88 },
      { id: 'UTM:CSC148H5', status: 'inProgress' },
    ] })
    const result = importRecordText(text)
    expect(result.ok && [...result.record]).toEqual([...record].sort(([a], [b]) => a.localeCompare(b)))
  })

  it('maps every parseRecord failure to a localisable error', () => {
    const error = (text: string) => {
      const result = importRecordText(text)
      return result.ok ? null : result.error
    }
    expect(error('{oops')).toEqual({ key: 'importNotJson' })
    expect(error('"text"')).toEqual({ key: 'importNotObject' })
    expect(error('null')).toEqual({ key: 'importNotObject' })
    expect(error('{"schemaVersion":2,"courses":[]}')).toEqual({ key: 'importFormat' })
    expect(error('{"schemaVersion":1,"courses":[{"id":"CSC108H5","status":"completed"}]}')).toEqual({ key: 'importBadId', id: 'CSC108H5' })
    expect(error('{"schemaVersion":1,"courses":[{"status":"completed"}]}')).toEqual({ key: 'importBadId', id: 'undefined' })
    expect(error('{"schemaVersion":1,"courses":[{"id":"UTM:CSC108H5","status":"done"}]}')).toEqual({ key: 'importBadStatus', id: 'UTM:CSC108H5' })
    expect(error('{"schemaVersion":1,"courses":[{"id":"UTM:CSC108H5","status":"completed","grade":101}]}')).toEqual({ key: 'importBadGrade', id: 'UTM:CSC108H5' })
    expect(error(' '.repeat(2_000_001))).toEqual({ key: 'importTooLarge' })
  })

  it('keeps unknown failures readable', () => {
    expect(mapImportError(new Error('disk on fire'))).toEqual({ key: 'importFailed', message: 'disk on fire' })
    expect(mapImportError('nope')).toEqual({ key: 'importFailed', message: 'nope' })
  })
})

describe('add-a-course search', () => {
  const codes = (query: string) => searchCourses(catalog, query).map(c => c.code)

  it('ranks code prefixes first, ignoring spaces and case', () => {
    expect(codes('csc 1')).toEqual(['CSC108H5', 'CSC148H5'])
    expect(codes('MAT13')).toEqual(['MAT135H5', 'MAT137Y5'])
  })

  it('then code contains, title starts with, title contains, all words', () => {
    expect(codes('148')).toEqual(['CSC148H5'])
    expect(codes('introduction')).toEqual(['CSC108H5', 'CSC148H5', 'CSC236H5', 'STA107H5'])
    expect(codes('calculus')).toEqual(['MAT137Y5', 'MAT135H5'])
    expect(codes('logic symbolic')).toEqual(['PHL245H5'])
  })

  it('returns nothing for an empty query and respects the limit', () => {
    expect(codes('  ')).toEqual([])
    expect(searchCourses(catalog, 'c', 2)).toHaveLength(2)
  })
})

describe('record control (stale grade regression)', () => {
  it('writes only from the stored entry, so an old draft grade never comes back', () => {
    // Completed 80, then Clear all, then Completed again: no grade.
    expect(nextRecordEntry(undefined, 'completed')).toEqual({ status: 'completed' })
    // A grade survives a move to Completed only when it is stored on the entry (imported files).
    expect(nextRecordEntry({ status: 'inProgress', grade: 65 }, 'completed')).toEqual({ status: 'completed', grade: 65 })
    expect(nextRecordEntry({ status: 'completed', grade: 80 }, 'planned')).toEqual({ status: 'planned' })
    expect(nextRecordEntry({ status: 'completed', grade: 80 }, 'none')).toBeNull()
  })

  it('does nothing when the status is already stored', () => {
    expect(nextRecordEntry({ status: 'completed', grade: 80 }, 'completed')).toBe('unchanged')
    expect(nextRecordEntry({ status: 'planned' }, 'planned')).toBe('unchanged')
    expect(nextRecordEntry(undefined, 'none')).toBe('unchanged')
  })

  it('writes a grade edit only when it is valid and different', () => {
    const entry: RecordEntry = { status: 'completed', grade: 80 }
    expect(gradedEntry(entry, '65')).toEqual({ status: 'completed', grade: 65 })
    expect(gradedEntry(entry, '')).toEqual({ status: 'completed' })
    expect(gradedEntry(entry, '80')).toBe('unchanged')
    expect(gradedEntry(entry, '080')).toBe('unchanged')
    expect(gradedEntry(entry, '8a')).toBe('unchanged')
    expect(gradedEntry({ status: 'completed' }, '  ')).toBe('unchanged')
  })

  it('re-syncs the grade input from the stored grade', () => {
    expect(gradeText(undefined)).toBe('')
    expect(gradeText(77.5)).toBe('77.5')
    // Clear all while the input still says 80.
    expect(syncGradeDraft('80', undefined)).toBe('')
    // An import replaced 80 with 65.
    expect(syncGradeDraft('80', 65)).toBe('65')
    // An invalid draft gives way to the stored grade.
    expect(syncGradeDraft('8a', 65)).toBe('65')
    // What the student is typing stays while it means the stored grade.
    expect(syncGradeDraft('080', 80)).toBe('080')
    expect(syncGradeDraft('8', 8)).toBe('8')
    expect(syncGradeDraft('', undefined)).toBe('')
  })
})

describe('eligibility cache', () => {
  it('computes eligibility once per engine and record', () => {
    let calls = 0
    const engine = {
      eligibility: () => {
        calls++
        return new Map<string, Eligibility>([['UTM:CSC148H5', 'met']])
      },
    } as unknown as CourseEngine
    const record = new Map<string, RecordEntry>([['UTM:CSC108H5', { status: 'completed' }]])
    const first = cachedEligibility(engine, record)
    expect(cachedEligibility(engine, record)).toBe(first)
    expect(calls).toBe(1)
    cachedEligibility(engine, new Map(record))
    expect(calls).toBe(2)
  })
})
