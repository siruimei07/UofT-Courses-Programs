import { describe, expect, it } from 'vitest'
import type { RecordEntry } from '../src/app/store'
import type { ProgramLite } from '../src/data/schema'
import type { ProgramProgress } from '../src/domain/engine-types'
import { categories, filterPrograms, needsClamp, programTypeChips, programTypeOf, tally } from '../src/ui/panels/programs'

const program = (code: string, title: string, type: string, groups: ProgramLite['groups'] = []): ProgramLite => ({
  id: `UTM:${code}`, code, title: `${title} - ${code}`, type, sourceUrl: '', description: '', admissionText: '', completionText: '', groups,
})
const programs = [
  program('ERMAJ1688', 'Computer Science - Major (Science)', 'Major'),
  program('ERSPE1688', 'Computer Science - Specialist (Science)', 'Specialist'),
  program('ERMIN1540', 'Applied Statistics - Minor (Science)', 'Minor'),
  program('ERCER0001', 'Certificate in Something', 'Certificate'),
  program('ERFOC0002', 'Focus in Biology', 'Focus'),
  program('ERXXX0003', 'Experimental Stream', 'Stream'),
]

describe('program picker', () => {
  it('maps official types, with anything unexpected as other', () => {
    expect(programTypeOf('Major')).toBe('Major')
    expect(programTypeOf('Focus')).toBe('Focus')
    expect(programTypeOf('Stream')).toBe('other')
  })

  it('builds filter chips in picker order with counts, only for types present', () => {
    expect(programTypeChips(programs)).toEqual([
      { type: 'all', count: 6 },
      { type: 'Specialist', count: 1 },
      { type: 'Major', count: 1 },
      { type: 'Minor', count: 1 },
      { type: 'Certificate', count: 1 },
      { type: 'Focus', count: 1 },
      { type: 'other', count: 1 },
    ])
    expect(programTypeChips(programs.slice(0, 2)).map(chip => chip.type)).toEqual(['all', 'Specialist', 'Major'])
  })

  it('filters by type and by every query word over title, code and type', () => {
    const codes = (query: string, type: Parameters<typeof filterPrograms>[2] = 'all') => filterPrograms(programs, query, type).map(p => p.code)
    expect(codes('')).toEqual(['ERMIN1540', 'ERCER0001', 'ERMAJ1688', 'ERSPE1688', 'ERXXX0003', 'ERFOC0002'])
    expect(codes('computer major')).toEqual(['ERMAJ1688'])
    expect(codes('ermin')).toEqual(['ERMIN1540'])
    expect(codes('', 'Specialist')).toEqual(['ERSPE1688'])
    expect(codes('', 'other')).toEqual(['ERXXX0003'])
    expect(codes('computer', 'Minor')).toEqual([])
  })
})

describe('program progress', () => {
  const record = new Map<string, RecordEntry>([
    ['UTM:CSC108H5', { status: 'completed' }],
    ['UTM:CSC148H5', { status: 'inProgress' }],
    ['UTM:MAT102H5', { status: 'completed', grade: 70 }],
  ])

  it('counts completed courses among unique listed ids', () => {
    expect(tally(['UTM:CSC108H5', 'UTM:CSC148H5', 'UTM:CSC108H5', 'UTM:CSC207H5'], record)).toEqual({ done: 1, total: 3 })
    expect(tally([], record)).toEqual({ done: 0, total: 0 })
  })

  it('splits groups into admission and completion with their own tallies', () => {
    const groups: ProgramLite['groups'] = [
      { id: 'a1', label: 'Admission', category: 'admission', text: '', rule: { kind: 'true' }, ids: ['UTM:CSC108H5', 'UTSG:CSC148H1'] },
      { id: 'c1', label: 'First Year', category: 'completion', text: '', rule: { kind: 'true' }, ids: ['UTM:CSC148H5', 'UTM:MAT102H5'] },
      { id: 'c2', label: 'Second Year', category: 'completion', text: '', rule: { kind: 'true' }, ids: ['UTM:CSC207H5'] },
    ]
    const p = program('ERMAJ1688', 'Computer Science - Major', 'Major', groups)
    const progress: ProgramProgress = {
      programId: p.id,
      completion: 'unknown',
      courseIds: ['UTM:CSC108H5', 'UTM:CSC148H5', 'UTM:MAT102H5', 'UTM:CSC207H5'],
      groups: [
        { groupId: 'a1', status: 'met', courseIds: ['UTM:CSC108H5'], completed: ['UTM:CSC108H5'], inProgress: [], planned: [] },
        { groupId: 'c1', status: 'unknown', courseIds: ['UTM:CSC148H5', 'UTM:MAT102H5'], completed: ['UTM:MAT102H5'], inProgress: ['UTM:CSC148H5'], planned: [] },
        { groupId: 'c2', status: 'unmet', courseIds: ['UTM:CSC207H5'], completed: [], inProgress: [], planned: [] },
      ],
    }
    const [admission, completion] = categories(p, progress, record)
    expect(admission.category).toBe('admission')
    expect(admission.groups.map(g => g.id)).toEqual(['a1'])
    // Engine course ids exclude the other-campus reference.
    expect(admission.tally).toEqual({ done: 1, total: 1 })
    expect(completion.groups.map(g => g.id)).toEqual(['c1', 'c2'])
    expect(completion.tally).toEqual({ done: 1, total: 3 })
    // Without an engine result the raw group ids are used.
    expect(categories(p, null, record)[0].tally).toEqual({ done: 1, total: 2 })
  })

  it('clamps only long official text', () => {
    expect(needsClamp('CSC207H5 and CSC236H5')).toBe(false)
    expect(needsClamp('x'.repeat(201))).toBe(true)
  })
})
