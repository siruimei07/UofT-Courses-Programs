import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { Catalog, Requirement, Rule } from '../src/domain/types'
import { ruleCourseIds } from '../src/domain/planner'

const catalog = JSON.parse(readFileSync('data/utm/catalog.json', 'utf8')) as Catalog
const validId = /^(UTM|UTSG|UTSC|external):[A-Z0-9]+$/
const counters: Record<string, number> = {}
function ruleCheck(rule: Rule): void {
  assert.ok(rule && typeof rule.kind === 'string', 'Missing rule AST')
  counters[rule.kind] = (counters[rule.kind] || 0) + 1
  switch (rule.kind) {
    case 'true': break
    case 'all': case 'any':
      assert.ok(Array.isArray(rule.items) && rule.items.length > 0, 'Empty Boolean group')
      rule.items.forEach(ruleCheck)
      break
    case 'course': case 'minGrade':
      assert.match(rule.courseId, validId)
      if (rule.kind === 'minGrade') assert.ok(rule.minimum >= 0 && rule.minimum <= 100)
      break
    case 'credits':
      assert.ok(Number.isFinite(rule.minimum) && rule.minimum >= 0)
      rule.courseIds?.forEach(id => assert.match(id, validId))
      break
    case 'permission': assert.ok(rule.text); break
    case 'program': assert.ok(rule.programId); break
    case 'unknown': assert.equal(typeof rule.text, 'string'); assert.ok(rule.reason, 'Unknown needs a reason'); break
    case 'applicability': assert.ok(rule.cohort); ruleCheck(rule.rule); break
    default: assert.fail(`Unsupported rule: ${JSON.stringify(rule)}`)
  }
}
function requirementCheck(req: Requirement): void {
  assert.equal(typeof req.rawText, 'string')
  assert.match(req.sourceUrl, /^https:\/\/utm\.calendar\.utoronto\.ca\//)
  assert.ok(Array.isArray(req.courseIds))
  assert.equal(new Set(req.courseIds).size, req.courseIds.length, 'Duplicated requirement reference')
  req.courseIds.forEach(id => assert.match(id, validId))
  ruleCheck(req.rule)
  ruleCourseIds(req.rule).forEach(id => assert.ok(req.courseIds.includes(id), `AST reference absent from source references: ${id}`))
}

assert.equal(catalog.schemaVersion, 1)
assert.equal(catalog.metadata.campus, 'UTM')
assert.equal(catalog.metadata.complete, true, 'Do not ship a partial catalog')
assert.match(catalog.metadata.academicYear, /20\d{2}\D+20\d{2}/)
assert.ok(catalog.metadata.academicYearSource && catalog.metadata.parserVersion)
assert.ok(Number.isFinite(Date.parse(catalog.metadata.fetchedAt)))
assert.ok(catalog.courses.length > 0 && catalog.programs.length > 0)
for (const entities of [catalog.courses, catalog.programs]) {
  assert.equal(new Set(entities.map(e => e.id)).size, entities.length, 'Duplicate catalog identity')
  for (const entity of entities) {
    assert.ok(entity.id.startsWith('UTM:'))
    assert.equal(entity.campus, 'UTM')
    assert.ok(entity.title && entity.sourceUrl)
    assert.match(entity.contentHash, /^[a-f\d]{64}$/)
    assert.ok(Number.isFinite(Date.parse(entity.fetchedAt)))
  }
}
for (const course of catalog.courses) {
  assert.equal(course.id, `UTM:${course.code}`)
  assert.match(course.code, /^[A-Z]{3}\d{3}[HY]5$/)
  assert.equal(course.subject, course.code.slice(0, 3))
  assert.equal(course.credits, course.code.endsWith('Y5') ? 1 : 0.5)
  for (const field of ['prerequisites', 'corequisites', 'exclusions', 'recommended', 'restrictions'] as const) {
    requirementCheck(course[field])
  }
}
for (const program of catalog.programs) {
  assert.ok(program.type)
  requirementCheck(program.admission)
  requirementCheck(program.completion)
  assert.equal(new Set(program.groups.map(g => g.id)).size, program.groups.length)
  for (const group of program.groups) {
    assert.ok(group.label && ['admission', 'completion'].includes(group.category))
    requirementCheck(group)
  }
}
const quality = JSON.parse(readFileSync('data/utm/quality-report.json', 'utf8')) as {
  academicYear: string
  parserVersion: string
  complete: boolean
  failures: unknown[]
  coverage: Record<'courses' | 'programs', { discovered: number; collected: number; pages: number; pageNumbers: number[]; duplicates: unknown[] }>
}
const manifest = JSON.parse(readFileSync('data/utm/manifest.json', 'utf8')) as {
  academicYear: string
  complete: boolean
  directories: Record<'course' | 'program', { pages: { page: number; count: number; codes: string[] }[]; entities: { code: string }[] }>
  details: { kind: 'course' | 'program'; code: string; status: string; contentHash: string; fetchedAt: string }[]
  failures: unknown[]
}
assert.equal(quality.complete, true)
assert.equal(manifest.complete, true)
assert.equal(quality.academicYear, catalog.metadata.academicYear)
assert.equal(manifest.academicYear, catalog.metadata.academicYear)
assert.equal(quality.parserVersion, catalog.metadata.parserVersion)
assert.equal(quality.failures.length, 0)
assert.equal(manifest.failures.length, 0)
for (const [kind, plural] of [['course', 'courses'], ['program', 'programs']] as const) {
  const coverage = quality.coverage[plural]
  const directory = manifest.directories[kind]
  assert.equal(coverage.discovered, catalog[plural].length)
  assert.equal(coverage.collected, catalog[plural].length)
  assert.equal(directory.pages.length, coverage.pages)
  assert.deepEqual(directory.pages.map(page => page.page).sort((a, b) => a - b), Array.from({ length: coverage.pages }, (_, i) => i))
  const discovered = new Set(directory.pages.flatMap(page => page.codes))
  assert.equal(discovered.size, catalog[plural].length)
  for (const entity of catalog[plural]) assert.ok(discovered.has(entity.id.slice(4)), `Undiscovered ${entity.id}`)
  const successful = new Set(manifest.details.filter(detail => detail.kind === kind && detail.status === 'ok').map(detail => detail.code))
  assert.equal(successful.size, discovered.size)
  for (const code of discovered) assert.ok(successful.has(code), `Missing successful detail: ${code}`)
  const details = new Map(manifest.details.filter(detail => detail.kind === kind).map(detail => [detail.code, detail]))
  for (const entity of catalog[plural]) {
    const detail = details.get(entity.id.slice(4))!
    assert.equal(entity.contentHash, detail.contentHash, `Manifest hash mismatch: ${entity.id}`)
    assert.equal(entity.fetchedAt, detail.fetchedAt, `Manifest retrieval mismatch: ${entity.id}`)
  }
}
console.log(JSON.stringify({
  passed: true,
  academicYear: catalog.metadata.academicYear,
  courses: catalog.courses.length,
  programs: catalog.programs.length,
  ruleNodes: counters,
}, null, 2))
