// Current official Calendar integration: catalog identity and engine results on real courses.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ProgramLite } from '../src/data/schema'
import { createEngine } from '../src/domain'
import type { Catalog, EvalNode, RecordEntryLike, Rule } from '../src/domain'
import { datasetFromCatalog } from './helpers/dataset'

const catalog = JSON.parse(readFileSync('data/utm/catalog.json', 'utf8')) as Catalog
const dataset = datasetFromCatalog()
const engine = createEngine(dataset)
type Row = [string, RecordEntryLike['status'], number?]
const record = (...rows: Row[]) => new Map(rows.map(([code, status, grade]) =>
  [code.includes(':') ? code : `UTM:${code}`, grade === undefined ? { status } : { status, grade }] as [string, RecordEntryLike]))
const completed = (codes: string[], grades: Record<string, number> = {}) =>
  record(...codes.map((code): Row => [code, 'completed', grades[code]]))
const evaluate = (code: string, rows: Map<string, RecordEntryLike>) => engine.evaluateCourse(`UTM:${code}`, rows)

function mirrors(rule: Rule, node: EvalNode): boolean {
  if (rule.kind !== node.kind) return false
  if (rule.kind === 'all' || rule.kind === 'any') return rule.items.length === node.children?.length && rule.items.every((item, i) => mirrors(item, node.children![i]))
  if (rule.kind === 'applicability') return node.children?.length === 1 && mirrors(rule.rule, node.children[0])
  if (rule.kind === 'course' || rule.kind === 'minGrade') return rule.courseId === node.courseId
  return true
}

describe('current official Calendar integration', () => {
  it('keeps a complete single-campus catalog with full unique identities', () => {
    expect(catalog.metadata.complete).toBe(true)
    expect(new Set(catalog.courses.map(item => item.id)).size).toBe(catalog.courses.length)
    expect(catalog.courses.every(item => item.campus === 'UTM' && item.id === `UTM:${item.code}`)).toBe(true)
    expect(new Set(catalog.programs.map(item => item.type)).size).toBeGreaterThanOrEqual(3)
    expect(dataset.courses).toHaveLength(catalog.courses.length)
  })

  it('ANT202H5 accepts either ANT101H5 or BIO152H5, finished or in progress', () => {
    expect(evaluate('ANT202H5', record()).prerequisites?.status).toBe('unmet')
    expect(evaluate('ANT202H5', completed(['ANT101H5'])).prerequisites?.status).toBe('met')
    expect(evaluate('ANT202H5', completed(['BIO152H5'])).prerequisites?.status).toBe('met')
    expect(evaluate('ANT202H5', record(['ANT101H5', 'inProgress'])).prerequisites?.status).toBe('met')
    expect(evaluate('ANT202H5', record(['ANT101H5', 'planned'])).prerequisites?.status).toBe('unmet')
  })

  it('CHM242H5 preserves the CHM120 grade scope and complete nested mathematics alternative', () => {
    const base = ['CHM110H5', 'CHM120H5', 'MAT132H5', 'MAT134H5']
    expect(evaluate('CHM242H5', completed(base, { CHM120H5: 60 })).prerequisites?.status).toBe('met')
    expect(evaluate('CHM242H5', completed(base, { CHM120H5: 59 })).prerequisites?.status).toBe('unmet')
    expect(evaluate('CHM242H5', completed(base)).prerequisites?.status).toBe('unknown')
    expect(evaluate('CHM242H5', completed(base.filter(code => code !== 'MAT134H5'), { CHM120H5: 60 })).prerequisites?.status).toBe('unmet')
  })

  it('keeps recommended CHM110 corequisites advisory and high-school qualifications unresolved', () => {
    const chm = catalog.courses.find(item => item.code === 'CHM110H5')!
    expect(chm.recommended.rawText.toLowerCase()).toContain('recommend')
    const result = evaluate('CHM110H5', record())
    expect(result.corequisites?.status ?? 'met').toBe('met')
    expect(result.overall).not.toBe('met')
  })

  it('preserves mandatory corequisites and blocks on external-campus exclusions', () => {
    const phy = dataset.courses.find(item => item.code === 'PHY147H5')!
    expect(phy.coreq?.ids.length).toBeGreaterThan(0)
    expect(phy.exclusion?.ids.some(id => id.startsWith('UTSG:') || id.startsWith('UTSC:'))).toBe(true)
    const ant = evaluate('ANT101H5', record(['UTSG:ANT100Y1', 'completed']))
    expect(ant.exclusions).toEqual({ status: 'blocked', blockedBy: ['UTSG:ANT100Y1'] })
    expect(ant.overall).toBe('unmet')
  })

  it('CS Major keeps cohort-sensitive text and certifies no admission group from a blank record', () => {
    const cs = catalog.programs.find(item => item.code === 'ERMAJ1688')!
    expect(cs.admission.rawText).toMatch(/2026|2027|cohort|admission category/i)
    expect(cs.completion.rawText.length).toBeGreaterThan(300)
    const lite: ProgramLite = {
      id: cs.id, code: cs.code, title: cs.title, type: cs.type, sourceUrl: cs.sourceUrl, description: '',
      admissionText: cs.admission.rawText, completionText: cs.completion.rawText,
      groups: cs.groups.map(group => ({ id: group.id, label: group.label, category: group.category, text: group.rawText, rule: group.rule, ids: group.courseIds })),
    }
    const progress = engine.programProgress(lite, new Map())
    expect(progress.groups.some(group => cs.groups.find(g => g.id === group.groupId)?.category === 'admission')).toBe(true)
    expect(progress.groups.filter(group => cs.groups.find(g => g.id === group.groupId)?.category === 'admission').every(group => group.status !== 'met')).toBe(true)
    expect(progress.completion).not.toBe('met')
    expect(progress.courseIds).toContain('UTM:CSC148H5')
  })

  it('returns structured trees for the whole catalog that agree with eligibility', () => {
    const rows = record(['CSC108H5', 'completed', 82], ['MAT102H5', 'completed'], ['CSC148H5', 'inProgress'], ['STA107H5', 'planned'])
    const eligibility = engine.eligibility(rows)
    expect(eligibility.size).toBe(dataset.courses.length - 3)
    for (const course of dataset.courses) {
      const result = engine.evaluateCourse(course.id, rows)
      if (eligibility.has(course.id)) expect(result.overall, course.id).toBe(eligibility.get(course.id))
      if (course.prereq) expect(mirrors(course.prereq.rule, result.prerequisites!), course.id).toBe(true)
      if (course.coreq) expect(mirrors(course.coreq.rule, result.corequisites!), course.id).toBe(true)
      expect(result.restrictions?.status ?? 'unknown').toBe('unknown')
    }
  })
})
