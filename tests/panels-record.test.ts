import { describe, expect, it } from 'vitest'
import type { RecordEntry } from '../src/app/store'
import type { GraphCourse } from '../src/data/schema'
import {
  earnsCredit, exportRecordJson, groupCredits, groupRecord, importRecordText, mapImportError, recordTotals, searchCourses,
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
