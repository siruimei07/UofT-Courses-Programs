import { describe, expect, it } from 'vitest'
import { formatHash, parseHash } from '../src/app/url'

describe('parseHash', () => {
  it('reads campus, course and program', () => {
    expect(parseHash('#/utm?course=CSC148H5&program=ERMAJ1688')).toEqual({ campus: 'UTM', course: 'CSC148H5', program: 'ERMAJ1688' })
  })

  it('upper-cases codes and accepts a bare campus', () => {
    expect(parseHash('#/UTM?course=csc148h5')).toEqual({ campus: 'UTM', course: 'CSC148H5', program: null })
    expect(parseHash('#/utsg')).toEqual({ campus: 'UTSG', course: null, program: null })
  })

  it('rejects unknown campuses, malformed codes and foreign hashes', () => {
    expect(parseHash('#/mars?course=CSC148H5')).toEqual({ campus: null, course: 'CSC148H5', program: null })
    expect(parseHash('#/utm?course=<script>')).toEqual({ campus: 'UTM', course: null, program: null })
    expect(parseHash('#theme=dark')).toEqual({ campus: null, course: null, program: null })
    expect(parseHash('')).toEqual({ campus: null, course: null, program: null })
  })

  it('never carries theme, language or the record', () => {
    expect(parseHash('#/utm?course=CSC148H5&theme=dark&record=x')).toEqual({ campus: 'UTM', course: 'CSC148H5', program: null })
  })
})

describe('formatHash', () => {
  it('writes only the codes of the selection', () => {
    expect(formatHash({ campus: 'UTM', focusId: 'UTM:CSC148H5', programId: 'UTM:ERMAJ1688' })).toBe('#/utm?course=CSC148H5&program=ERMAJ1688')
    expect(formatHash({ campus: 'UTM', focusId: null, programId: null })).toBe('#/utm')
  })

  it('round-trips through parseHash', () => {
    const hash = formatHash({ campus: 'UTM', focusId: 'UTM:MAT232H5', programId: null })
    expect(parseHash(hash)).toEqual({ campus: 'UTM', course: 'MAT232H5', program: null })
  })
})
