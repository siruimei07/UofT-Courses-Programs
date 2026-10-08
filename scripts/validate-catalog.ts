// Validates data/<dataDir>/ (default utm): `tsx scripts/validate-catalog.ts [dataDir]`.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Catalog, Requirement, Rule } from '../src/domain/types'
import { ruleCourseIds } from '../src/domain/rules'

const dataDir = process.argv[2] ?? 'utm'
const dataPath = (file: string) => join('data', dataDir, file)
const catalog = JSON.parse(readFileSync(dataPath('catalog.json'), 'utf8')) as Catalog
const registry = JSON.parse(readFileSync(join('data', 'campuses.json'), 'utf8')) as {
  campuses: { id: string; dataDir: string; calendarUrl: string; campusDigit: string }[]
}
const campus = registry.campuses.find(entry => entry.dataDir === dataDir)
assert.ok(campus, `No campus in data/campuses.json uses dataDir ${dataDir}`)
assert.equal(catalog.metadata.campus, campus.id, 'Catalog campus differs from the campus registry')
/** Same-campus id prefix, e.g. `UTM:`. */
const prefix = `${catalog.metadata.campus}:`
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const sourceUrl = new RegExp(`^${escapeRegExp(campus.calendarUrl)}`)
const courseCode = new RegExp(`^[A-Z]{3}\\d{3}[HY]${campus.campusDigit}$`)
const validId = /^(UTM|UTSG|UTSC|external):[A-Z0-9]+$/
const catalogIds = new Set(catalog.courses.map(course => course.id))
const counters: Record<string, number> = {}
/** Same-campus references that point at no course in this calendar (should become unresolvedIds). */
const dangling = new Set<string>()
let mentionedCount = 0
let unresolvedCount = 0
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
function idList(ids: unknown, label: string): string[] {
  assert.ok(Array.isArray(ids), `${label} must be an array`)
  assert.equal(new Set(ids).size, ids.length, `Duplicated ${label} reference`)
  ids.forEach(id => assert.match(id, validId))
  return ids as string[]
}
function requirementCheck(req: Requirement): void {
  assert.equal(typeof req.rawText, 'string')
  assert.match(req.sourceUrl, sourceUrl)
  idList(req.courseIds, 'courseIds')
  ruleCheck(req.rule)
  const structured = ruleCourseIds(req.rule)
  structured.forEach(id => assert.ok(req.courseIds.includes(id), `AST reference absent from source references: ${id}`))
  req.courseIds.forEach(id => { if (id.startsWith(prefix) && !catalogIds.has(id)) dangling.add(id) })
  // Mentioned and unresolved codes are never requirements: the rule AST must not use them, and
  // they never become graph references.
  if (req.mentionedIds !== undefined) {
    for (const id of idList(req.mentionedIds, 'mentionedIds')) {
      assert.ok(!structured.includes(id), `Mentioned code used by the rule AST: ${id}`)
      assert.ok(!req.courseIds.includes(id), `Mentioned code is also a graph reference: ${id}`)
      mentionedCount++
    }
  }
  if (req.unresolvedIds !== undefined) {
    for (const id of idList(req.unresolvedIds, 'unresolvedIds')) {
      assert.ok(id.startsWith(prefix), `Unresolved code is not a same-campus code: ${id}`)
      assert.ok(!catalogIds.has(id), `Unresolved code exists in the catalog: ${id}`)
      assert.ok(!structured.includes(id), `Unresolved code used by the rule AST: ${id}`)
      assert.ok(!req.courseIds.includes(id), `Unresolved code is also a graph reference: ${id}`)
      unresolvedCount++
    }
  }
}
function optionalText(value: unknown, label: string): void {
  if (value !== undefined) assert.equal(typeof value, 'string', `${label} must be text when present`)
}

assert.equal(catalog.schemaVersion, 1)
assert.equal(catalog.metadata.complete, true, 'Do not ship a partial catalog')
assert.match(catalog.metadata.academicYear, /20\d{2}\D+20\d{2}/)
assert.ok(catalog.metadata.academicYearSource && catalog.metadata.parserVersion)
assert.ok(Number.isFinite(Date.parse(catalog.metadata.fetchedAt)))
assert.ok(catalog.courses.length > 0 && catalog.programs.length > 0)
for (const entities of [catalog.courses, catalog.programs]) {
  assert.equal(new Set(entities.map(e => e.id)).size, entities.length, 'Duplicate catalog identity')
  for (const entity of entities) {
    assert.ok(entity.id.startsWith(prefix))
    assert.equal(entity.campus, catalog.metadata.campus)
    assert.ok(entity.title && entity.sourceUrl)
    assert.match(entity.contentHash, /^[a-f\d]{64}$/)
    assert.ok(Number.isFinite(Date.parse(entity.fetchedAt)))
  }
}
for (const course of catalog.courses) {
  assert.equal(course.id, `${prefix}${course.code}`)
  assert.match(course.code, courseCode)
  assert.equal(course.subject, course.code.slice(0, 3))
  assert.equal(course.credits, course.code.endsWith(`Y${campus.campusDigit}`) ? 1 : 0.5)
  for (const field of ['distribution', 'deliveryCampus', 'courseExperience', 'internationalComponent'] as const) {
    optionalText(course[field], `${course.id} ${field}`)
  }
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
const quality = JSON.parse(readFileSync(dataPath('quality-report.json'), 'utf8')) as {
  academicYear: string
  parserVersion: string
  complete: boolean
  failures: unknown[]
  coverage: Record<'courses' | 'programs', { discovered: number; collected: number; pages: number; pageNumbers: number[]; duplicates: unknown[] }>
}
const manifest = JSON.parse(readFileSync(dataPath('manifest.json'), 'utf8')) as {
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
  for (const entity of catalog[plural]) assert.ok(discovered.has(entity.id.slice(prefix.length)), `Undiscovered ${entity.id}`)
  const successful = new Set(manifest.details.filter(detail => detail.kind === kind && detail.status === 'ok').map(detail => detail.code))
  assert.equal(successful.size, discovered.size)
  for (const code of discovered) assert.ok(successful.has(code), `Missing successful detail: ${code}`)
  const details = new Map(manifest.details.filter(detail => detail.kind === kind).map(detail => [detail.code, detail]))
  for (const entity of catalog[plural]) {
    const detail = details.get(entity.id.slice(prefix.length))!
    assert.equal(entity.contentHash, detail.contentHash, `Manifest hash mismatch: ${entity.id}`)
    assert.equal(entity.fetchedAt, detail.fetchedAt, `Manifest retrieval mismatch: ${entity.id}`)
  }
}
console.log(JSON.stringify({
  passed: true,
  campus: catalog.metadata.campus,
  academicYear: catalog.metadata.academicYear,
  courses: catalog.courses.length,
  programs: catalog.programs.length,
  ruleNodes: counters,
  mentionedReferences: mentionedCount,
  unresolvedReferences: unresolvedCount,
  danglingReferences: { count: dangling.size, sample: [...dangling].sort().slice(0, 10) },
}, null, 2))
