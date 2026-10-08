import { describe, expect, it } from 'vitest'
import {
  buildCourseIndex, buildProgramIndex, parseQuery, programShortTitle, searchCourses, searchPrograms, splitMatch,
} from '../src/app/search'
import type { GraphCourse, GraphDataset, ProgramLite } from '../src/data/schema'
import { loadGraphDataset } from './helpers/dataset'

const course = (code: string, title: string): GraphCourse => ({
  id: `UTM:${code}`, code, title, subject: code.slice(0, 3), level: Number(code[3]) * 100, credits: 0.5,
})

const dataset = (courses: GraphCourse[]): GraphDataset => ({
  schemaVersion: 1, campus: 'UTM', academicYear: '2026-2027', fetchedAt: '', generatedAt: '',
  sources: { calendar: '', courseSearch: '', programSearch: '', coursePageTemplate: '', programPageTemplate: '' },
  divisions: [], subjects: [], courses,
})

const program = (code: string, title: string, type = 'Major'): ProgramLite => ({
  id: `UTM:${code}`, code, title: `${title} - ${code}`, type, sourceUrl: '', description: '',
  admissionText: '', completionText: '', groups: [],
})

const sample = buildCourseIndex(dataset([
  course('CSC108H5', 'Introduction to Computer Programming'),
  course('CSC148H5', 'Introduction to Computer Science'),
  course('CSC209H5', 'Software Tools and Systems Programming'),
  course('MAT102H5', 'Introduction to Mathematical Proofs'),
  course('STA148H5', 'Statistics for Data Science'),
  course('ANT148H5', 'Computer Anthropology'),
  course('ENG110Y5', 'Narrative'),
]))

describe('parseQuery', () => {
  it('lower-cases, collapses spaces and builds a compact code key', () => {
    expect(parseQuery('  CSC   148 ')).toEqual({ text: 'csc 148', compact: 'csc148', words: ['csc', '148'] })
    expect(parseQuery('csc-148').compact).toBe('csc148')
    expect(parseQuery('   ')).toEqual({ text: '', compact: '', words: [] })
  })
})

describe('searchCourses', () => {
  it('returns nothing for an empty query', () => {
    expect(searchCourses(sample, '')).toEqual([])
    expect(searchCourses(sample, '   ')).toEqual([])
  })

  it('ranks an exact code (with or without the H5 suffix) first', () => {
    expect(searchCourses(sample, 'csc148h5')[0]).toMatchObject({ code: 'CSC148H5', rank: 0 })
    expect(searchCourses(sample, 'CSC 148')[0]).toMatchObject({ code: 'CSC148H5', rank: 0 })
  })

  it('ranks code prefix before code contains before title matches', () => {
    const codes = searchCourses(sample, '148').map(hit => [hit.code, hit.rank])
    // "148" is inside three codes (rank 2), sorted by code.
    expect(codes).toEqual([['ANT148H5', 2], ['CSC148H5', 2], ['STA148H5', 2]])
    const csc = searchCourses(sample, 'csc').map(hit => hit.code)
    expect(csc).toEqual(['CSC108H5', 'CSC148H5', 'CSC209H5'])
  })

  it('orders title tiers: starts with, word prefix, contains, all words', () => {
    const hits = searchCourses(sample, 'computer')
    expect(hits.map(hit => [hit.code, hit.rank])).toEqual([
      ['ANT148H5', 3], // title starts with "computer"
      ['CSC108H5', 4], // a word starts with it
      ['CSC148H5', 4],
    ])
    expect(searchCourses(sample, 'omputer')[0].rank).toBe(5)
    const words = searchCourses(sample, 'programming software')
    expect(words.map(hit => [hit.code, hit.rank])).toEqual([['CSC209H5', 6]])
  })

  it('reports the matched range for highlighting', () => {
    const [hit] = searchCourses(sample, 'csc 14')
    expect(hit.match).toEqual({ field: 'code', start: 0, end: 5 })
    expect(splitMatch(hit.code, hit.match, 'code')).toEqual(['', 'CSC14', '8H5'])
    expect(splitMatch(hit.title, hit.match, 'title')).toEqual([hit.title, '', ''])
    const [title] = searchCourses(sample, 'proofs')
    expect(splitMatch(title.title, title.match, 'title')).toEqual(['Introduction to Mathematical ', 'Proofs', ''])
  })

  it('caps the result count', () => {
    expect(searchCourses(sample, 'i', 2)).toHaveLength(2)
  })

  it('finds CSC148H5 first in the real UTM dataset', () => {
    const { dataset: real } = loadGraphDataset()
    const index = buildCourseIndex(real)
    expect(searchCourses(index, 'csc148')[0].code).toBe('CSC148H5')
    expect(searchCourses(index, 'CSC 148')[0].code).toBe('CSC148H5')
    const hits = searchCourses(index, 'calculus')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.every(hit => hit.title.toLowerCase().includes('calculus'))).toBe(true)
  })
})

describe('programs', () => {
  const programs = [
    program('ERMAJ1688', 'Computer Science - Major (Science)'),
    program('ERMIN1688', 'Computer Science - Minor (Science)', 'Minor'),
    program('ERSPE1688', 'Computer Science - Specialist (Science)', 'Specialist'),
    program('ERMAJ0101', 'Applied Computing - Major (Science)'),
  ]
  const index = buildProgramIndex(programs)

  it('strips the trailing code from program titles', () => {
    expect(programShortTitle(programs[0])).toBe('Computer Science - Major (Science)')
    expect(programShortTitle({ title: 'No suffix', code: 'X' })).toBe('No suffix')
  })

  it('ranks code matches, then title tiers, ties by title', () => {
    expect(searchPrograms(index, 'ermaj1688')[0]).toMatchObject({ code: 'ERMAJ1688', rank: 0 })
    const hits = searchPrograms(index, 'comput', 5)
    expect(hits.map(hit => hit.code)).toEqual(['ERMAJ1688', 'ERMIN1688', 'ERSPE1688', 'ERMAJ0101'])
    expect(hits[3].rank).toBeGreaterThan(hits[0].rank)
  })

  it('defaults to three program rows', () => {
    expect(searchPrograms(index, 'science')).toHaveLength(3)
  })
})
