import { describe, expect, it } from 'vitest'
import { decideLanding, type LandingInput } from '../src/app/landing'

const base: LandingInput = {
  hashCourse: null,
  hashProgram: null,
  home: null,
  onboarded: false,
  startSubjects: ['CSC', 'MAT', 'STA', 'ECO', 'PSY', 'BIO'],
  subjects: new Set(['AST', 'BIO', 'CSC', 'MAT', 'STA', 'ECO', 'PSY']),
}

describe('decideLanding (design-spec 10.1)', () => {
  it('first visit: CSC lane on top, start strip and search focus', () => {
    expect(decideLanding(base)).toEqual({ action: { kind: 'lane', subject: 'CSC' }, showStart: true, focusSearch: true })
  })

  it('a hash course wins over everything and frames the chain', () => {
    const landing = decideLanding({ ...base, hashCourse: 'UTM:CSC148H5', hashProgram: 'UTM:ERMAJ1688', home: { kind: 'subject', id: 'MAT' } })
    expect(landing).toEqual({ action: { kind: 'chain' }, showStart: false, focusSearch: false })
  })

  it('a hash program comes next, already active through the URL', () => {
    const landing = decideLanding({ ...base, hashProgram: 'UTM:ERMAJ1688', home: { kind: 'subject', id: 'MAT' } })
    expect(landing.action).toEqual({ kind: 'program', programId: 'UTM:ERMAJ1688', activate: false })
    expect(landing.showStart).toBe(false)
  })

  it('a stored subject home scrolls to that lane without the start strip', () => {
    const landing = decideLanding({ ...base, home: { kind: 'subject', id: 'MAT' }, onboarded: true })
    expect(landing).toEqual({ action: { kind: 'lane', subject: 'MAT' }, showStart: false, focusSearch: false })
  })

  it('a stored program home activates the program', () => {
    const landing = decideLanding({ ...base, home: { kind: 'program', id: 'UTM:ERMAJ1688' }, onboarded: true })
    expect(landing.action).toEqual({ kind: 'program', programId: 'UTM:ERMAJ1688', activate: true })
  })

  it('ignores a stored subject that has no lane and falls back to the start subject', () => {
    const landing = decideLanding({ ...base, home: { kind: 'subject', id: 'XYZ' }, onboarded: true })
    expect(landing).toEqual({ action: { kind: 'lane', subject: 'CSC' }, showStart: false, focusSearch: false })
  })

  it('returning visitors never land on the first science lanes either', () => {
    expect(decideLanding({ ...base, onboarded: true }).action).toEqual({ kind: 'lane', subject: 'CSC' })
  })

  it('skips start subjects the dataset does not have', () => {
    const landing = decideLanding({ ...base, subjects: new Set(['AST', 'MAT']) })
    expect(landing.action).toEqual({ kind: 'lane', subject: 'MAT' })
    expect(decideLanding({ ...base, startSubjects: [] }).action).toEqual({ kind: 'none' })
  })
})
