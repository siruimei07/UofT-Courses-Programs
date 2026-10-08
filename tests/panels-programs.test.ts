import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { RecordEntry } from '../src/app/store'
import type { ProgramLite } from '../src/data/schema'
import type { ProgramProgress } from '../src/domain/engine-types'
import {
  capSections, categories, filterPrograms, groupNumber, groupSections, isHeadingOnly, isOverflowing, programTypeChips, programTypeOf, tally,
} from '../src/ui/panels/programs'

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

  it('does not match page slugs that only stand in for a missing POSt code', () => {
    const slugged: ProgramLite = { ...program('computer-science-cert', '', 'Certificate'), title: 'Certificate in Computing', codeSource: 'url-slug' }
    expect(filterPrograms([slugged], 'computer-science-cert', 'all')).toEqual([])
    expect(filterPrograms([slugged], 'computing', 'all')).toEqual([slugged])
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

  it('does not count failed courses (grade below 50) as completed', () => {
    // Review repro: CSC108H5 at 30 and MAT102H5 at 20 read "2 of 43" while the engine said 0.
    const failed = new Map<string, RecordEntry>([
      ['UTM:CSC108H5', { status: 'completed', grade: 30 }],
      ['UTM:MAT102H5', { status: 'completed', grade: 20 }],
      ['UTM:MAT135H5', { status: 'completed', grade: 49.5 }],
      ['UTM:MAT137Y5', { status: 'completed', grade: 50 }],
      ['UTM:STA107H5', { status: 'completed' }],
    ])
    expect(tally(['UTM:CSC108H5', 'UTM:MAT102H5', 'UTM:MAT135H5', 'UTM:MAT137Y5', 'UTM:STA107H5'], failed)).toEqual({ done: 2, total: 5 })
    const groups: ProgramLite['groups'] = [
      { id: 'c1', label: 'First Year', category: 'completion', text: '', rule: { kind: 'true' }, ids: ['UTM:CSC108H5', 'UTM:MAT102H5', 'UTM:MAT137Y5'] },
    ]
    const [, completion] = categories(program('ERMAJ1688', 'Computer Science - Major', 'Major', groups), null, failed)
    expect(completion.tally).toEqual({ done: 1, total: 3 })
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

  it('offers "Show more" only when the clamped text really overflows', () => {
    expect(isOverflowing(120, 80)).toBe(true)
    expect(isOverflowing(81, 80)).toBe(false)
    expect(isOverflowing(80, 80)).toBe(false)
    // A hidden tab measures 0 x 0 until it is shown.
    expect(isOverflowing(0, 0)).toBe(false)
  })
})

describe('program group sections (student QA: pathways, heading-only groups)', () => {
  const real = (JSON.parse(readFileSync(join(process.cwd(), 'public', 'data', 'utm', 'programs.json'), 'utf8')) as { programs: ProgramLite[] }).programs
  const csMajor = real.find(item => item.code === 'ERMAJ1688')!
  const admission = csMajor.groups.filter(group => group.category === 'admission')

  it('turns heading-only groups into section headings instead of cards with a "check" badge', () => {
    const heading = admission.find(group => group.text.startsWith('For students admitted through the CMP1'))!
    expect(isHeadingOnly(heading)).toBe(true)
    // A group with courses, or a note whose text is not its label, stays a card.
    expect(isHeadingOnly(admission.find(group => group.ids.length > 0)!)).toBe(false)
    expect(isHeadingOnly(admission.find(group => group.label.startsWith('Notes:'))!)).toBe(false)
    const sections = groupSections(admission)
    for (const section of sections) for (const item of section.items) expect(isHeadingOnly(item), item.text).toBe(false)
    // Every pathway is one section headed once by its official framing text.
    const pathways = sections.filter(section => section.heading?.startsWith('For students admitted'))
    expect(pathways.length).toBeGreaterThanOrEqual(3)
    expect(pathways[0].heading).toBe('For students admitted through the CMP1 admission category in Fall 2026 and beyond:')
    expect(pathways[0].items.map(item => item.text)).toEqual(['CSC110Y5 (70%)', 'CSC111H5 (77%)', 'MAT139H5 or MAT159H5', 'ISP100H5'])
    // The generic "Admission" label is never repeated under the localized Admission heading.
    expect(sections[0].heading).toBeNull()
    // Numbered notes share one "Notes:" section and keep their numbers.
    const notes = sections.find(section => section.key === 'Notes:')!
    expect(notes.items.map(groupNumber)).toEqual([1, 2, 3, null])
    // No card is lost: cards + heading-only groups = all groups.
    expect(sections.reduce((n, section) => n + section.items.length, 0) + admission.filter(isHeadingOnly).length).toBe(admission.length)
  })

  it('collapses to whole sections, so a pathway is never cut in half', () => {
    const sections = groupSections(admission)
    const { shown, rest } = capSections(sections, 8, false)
    const cards = shown.reduce((n, section) => n + section.items.length, 0)
    expect(cards).toBeGreaterThanOrEqual(8)
    expect(shown.length).toBeLessThan(sections.length)
    expect(rest).toBe(sections.reduce((n, section) => n + section.items.length, 0) - cards)
    expect(capSections(sections, 8, true)).toEqual({ shown: sections, rest: 0 })
  })
})
