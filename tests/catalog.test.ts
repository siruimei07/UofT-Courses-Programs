import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createEmptyProfile, evaluateEligibility, evaluateRule, findDependencyCycles, getRelatedCourses, ruleCourseIds } from '../src/domain'
import type { Catalog, StudentProfile } from '../src/domain/types'

const catalog = JSON.parse(readFileSync('public/data/catalog.json', 'utf8')) as Catalog
function course(code: string) {
  const found = catalog.courses.find(item => item.code === code)
  if (!found) throw new Error(`Official regression sample missing from current snapshot: ${code}`)
  return found
}
function completed(codes: string[], grades: Record<string, number> = {}): StudentProfile {
  return { ...createEmptyProfile(), recordComplete: true, courses: codes.map(code => ({ courseId: `UTM:${code}`, status: 'completed', grade: grades[code] })) }
}

describe('current official Calendar integration', () => {
  it('keeps a complete single-campus catalog with full unique identities', () => {
    expect(catalog.metadata.complete).toBe(true)
    expect(new Set(catalog.courses.map(item => item.id)).size).toBe(catalog.courses.length)
    expect(catalog.courses.every(item => item.campus === 'UTM' && item.id === `UTM:${item.code}`)).toBe(true)
    expect(new Set(catalog.programs.map(item => item.type)).size).toBeGreaterThanOrEqual(3)
  })

  it('ANT202H5 accepts either ANT101H5 or BIO152H5, with record completeness respected', () => {
    const rule = course('ANT202H5').prerequisites.rule
    expect(evaluateRule(rule, createEmptyProfile(), catalog.courses).status).toBe('unknown')
    expect(evaluateRule(rule, completed([]), catalog.courses).status).toBe('unmet')
    expect(evaluateRule(rule, completed(['ANT101H5']), catalog.courses).status).toBe('met')
    expect(evaluateRule(rule, completed(['BIO152H5']), catalog.courses).status).toBe('met')
  })

  it('CHM242H5 preserves the CHM120 grade scope and complete nested mathematics alternative', () => {
    const rule = course('CHM242H5').prerequisites.rule
    const base = ['CHM110H5', 'CHM120H5', 'MAT132H5', 'MAT134H5']
    expect(evaluateRule(rule, completed(base, { CHM120H5: 60 }), catalog.courses).status).toBe('met')
    expect(evaluateRule(rule, completed(base, { CHM120H5: 59 }), catalog.courses).status).toBe('unmet')
    expect(evaluateRule(rule, completed(base), catalog.courses).status).toBe('unknown')
    expect(evaluateRule(rule, completed(base.filter(code => code !== 'MAT134H5'), { CHM120H5: 60 }), catalog.courses).status).toBe('unmet')
  })

  it('recommended CHM110 corequisites are advisory and high-school qualifications stay unresolved', () => {
    const chm = course('CHM110H5')
    expect(chm.recommended.rawText.toLowerCase()).toContain('recommend')
    expect(evaluateRule(chm.corequisites.rule, completed([]), catalog.courses).status).toBe('met')
    expect(evaluateEligibility(chm, completed([]), catalog.courses).status).not.toBe('met')
  })

  it('preserves both mandatory co-requisites and external campus exclusions', () => {
    const phy = course('PHY147H5')
    expect(phy.corequisites.courseIds.length).toBeGreaterThan(0)
    expect(phy.exclusions.courseIds.some(id => id.startsWith('UTSG:') || id.startsWith('UTSC:'))).toBe(true)
    const ant = course('ANT101H5')
    expect(evaluateEligibility(ant, { ...completed([]), courses: [{ courseId: 'UTSG:ANT100Y1', status: 'completed' }] }, catalog.courses).status).toBe('unmet')
  })

  it('CS Major retains cohort-sensitive text and cannot certify admission from a blank record', () => {
    const cs = catalog.programs.find(item => item.code === 'ERMAJ1688')!
    expect(cs).toBeDefined()
    expect(cs.admission.rawText).toMatch(/2026|2027|cohort|admission category/i)
    expect(cs.completion.rawText.length).toBeGreaterThan(300)
    expect(evaluateRule(cs.admission.rule, createEmptyProfile(), catalog.courses).status).not.toBe('met')
    expect(cs.groups.some(group => group.category === 'admission')).toBe(true)
    expect(cs.groups.some(group => group.category === 'completion')).toBe(true)
  })

  it('walks the full graph and its cycles without conflating campuses', () => {
    const cycles = findDependencyCycles(catalog.courses)
    expect(Array.isArray(cycles)).toBe(true)
    const related = getRelatedCourses('UTM:CSC108H5', catalog.courses)
    expect(related.transitiveDependents.length).toBeGreaterThan(0)
    expect(related.transitiveDependents).not.toContain('UTM:CSC108H5')
    expect(ruleCourseIds(course('ANT202H5').prerequisites.rule)).toContain('UTM:ANT101H5')
  })
})
