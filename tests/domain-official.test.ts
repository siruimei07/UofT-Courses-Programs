import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createEmptyProfile, evaluateRule, recommendCourses } from '../src/domain'
import type { Catalog, Rule, StudentProfile } from '../src/domain'

const catalog = JSON.parse(readFileSync('public/data/catalog.json', 'utf8')) as Catalog
const completed = (codes: string[]): StudentProfile => ({
  ...createEmptyProfile(), recordComplete: true,
  courses: codes.map(code => ({ courseId: `UTM:${code}`, status: 'completed', grade: 80 })),
})
function prerequisite(code: string): Rule {
  const course = catalog.courses.find(course => course.code === code)
  if (!course) throw new Error(`Official regression course missing: ${code}`)
  return course.prerequisites.rule
}

describe('official prose scope regression: parser through rule evaluation', () => {
  it.each([
    ['CCT371H5', ['CCT110H5']],
    ['GGR214H5', ['ENV100Y5']],
    ['ENV495H5', ['BIO205H5']],
    ['GGR315H5', ['GGR217H5']],
  ])('%s does not bypass a total-credit requirement via the second including alternative', (code, records) => {
    // The official wording scopes a total-credit minimum over the entire including list.
    // A parser that leaves the first branch unknown and the second as a course is unsafe.
    expect(evaluateRule(prerequisite(code), completed(records), catalog.courses).status).not.toBe('met')
  })

  it.each(['JLP481H5', 'JLP483H5'])('%s does not accept one pool course in place of both its bridge and required credit amount', code => {
    expect(evaluateRule(prerequisite(code), completed(['LIN328H5']), catalog.courses).status).not.toBe('met')
  })

  it.each([
    ['FRE180H5', 'FSL206H5'],
    ['FRE181H5', 'FRE180H5'],
    ['FSL106H5', 'FSL105H5'],
  ])('%s retains the independent placement-test/student-group clause', (code, record) => {
    expect(evaluateRule(prerequisite(code), completed([record]), catalog.courses).status).not.toBe('met')
  })

  it('keeps a co-op-only admission leaf conditional rather than turning it into a general program requirement', () => {
    const program = catalog.programs.find(program => program.code === 'ERSPE1025')!
    const group = program.groups.find(group => group.category === 'admission' && group.label.includes('UTMCIP') && group.rawText.includes('ISP100H5'))!
    expect(group).toBeDefined()
    expect(evaluateRule(group.rule, completed(['ISP100H5']), catalog.courses).status).toBe('unknown')
    // Isolate this real source group to ensure unrelated general-program requirements
    // cannot independently justify the same course as a ready recommendation.
    const recommendations = recommendCourses({ ...program, groups: [group] }, catalog, completed([]))
    const isp = recommendations.find(recommendation => recommendation.courseId === 'UTM:ISP100H5')!
    expect(isp.category).toBe('planning')
    expect(isp.reasons.every(reason => !reason.includes('必修条件'))).toBe(true)
  })

  it('does not treat one elective-list reference as meeting the full list allocation', () => {
    const program = catalog.programs.find(program => program.code === 'ERMAJ0727')!
    const group = program.groups.find(group => group.category === 'completion' && group.label.includes('Group B') && group.courseIds.includes('UTM:ANT205H5'))!
    expect(group).toBeDefined()
    expect(evaluateRule(group.rule, completed(['ANT205H5']), catalog.courses).status).not.toBe('met')
  })

  it('requires the stated decimal credits before satisfying a program course pool', () => {
    const program = catalog.programs.find(program => program.code === 'ERMAJ1034')!
    const group = program.groups.find(group => group.id === 'UTM:ERMAJ1034:completion:6')!
    expect(group.rawText).toContain('1.0 credit')
    expect(evaluateRule(group.rule, completed([]), catalog.courses).status).toBe('unmet')
    expect(evaluateRule(group.rule, completed(['CCT200H5']), catalog.courses).status).toBe('unmet')
    expect(evaluateRule(group.rule, completed(['CCT200H5', 'CCT206H5']), catalog.courses).status).toBe('met')

    const italian = catalog.programs.find(program => program.code === 'ERMAJ1249')!
    const halfCredit = italian.groups.find(group => group.id === 'UTM:ERMAJ1249:completion:5')!
    expect(halfCredit.rawText).toContain('0.5 credit')
    expect(evaluateRule(halfCredit.rule, completed(['ITA351H5']), catalog.courses).status).toBe('met')
  })

  it('keeps Neuroscience cluster reference lists out of mandatory-course recommendations', () => {
    const program = catalog.programs.find(program => program.code === 'ERSPE2470')!
    const cluster = program.groups.find(group => group.label.startsWith('Cluster A'))!
    const allClusterCourses = completed(cluster.courseIds.map(id => id.slice(4)))
    expect(evaluateRule(cluster.rule, allClusterCourses, catalog.courses).status).toBe('unknown')
    const recommendations = recommendCourses({ ...program, groups: [cluster] }, catalog, completed([]))
    expect(recommendations.some(recommendation => recommendation.courseId === 'UTM:BIO318Y5')).toBe(true)
    expect(recommendations.every(recommendation => recommendation.category === 'planning')).toBe(true)
    expect(recommendations.every(recommendation => recommendation.reasons.every(reason => !reason.includes('必修条件')))).toBe(true)
  })
})
