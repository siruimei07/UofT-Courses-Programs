import { readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { performance } from 'node:perf_hooks'
import ELK from 'elkjs/lib/elk.bundled.js'
import { buildSwimlaneGraph, type Relation } from '../src/components/graph-layout'
import { createEmptyProfile, evaluateEligibility, recommendCourses } from '../src/domain'
import type { Catalog, Course } from '../src/domain/types'

const catalog = JSON.parse(readFileSync('public/data/catalog.json', 'utf8')) as Catalog
const profile = createEmptyProfile()
function timed<T>(fn: () => T): { value: T; ms: number } {
  const start = performance.now()
  const value = fn()
  return { value, ms: +(performance.now() - start).toFixed(2) }
}
const evaluation = timed(() => new Map(catalog.courses.map(course => [course.id, evaluateEligibility(course, profile, catalog.courses).status])))
const relations: Relation[] = ['prerequisite', 'corequisite', 'exclusion', 'recommended']
function project(courses: Course[]) {
  return buildSwimlaneGraph(courses, null, new Set(), evaluation.value, new Map(), relations)
}
const full = timed(() => project(catalog.courses))
const subjectGraphs = [...new Set(catalog.courses.map(course => course.subject))].map(subject => {
  const courses = catalog.courses.filter(course => course.subject === subject)
  return { subject, courses, graph: project(courses) }
}).sort((a, b) => b.graph.edges.length - a.graph.edges.length)
const densest = subjectGraphs[0]
const denseProjection = timed(() => project(densest.courses))
const elkStart = performance.now()
const elkResult = await new ELK().layout({
  id: 'root',
  layoutOptions: { 'elk.algorithm': 'layered', 'elk.direction': 'RIGHT' },
  children: densest.courses.map(course => ({ id: course.id, width: 240, height: 110 })),
  edges: densest.graph.edges.map(edge => ({ id: edge.id, sources: [edge.source], targets: [edge.target] })),
})
const elkMs = +(performance.now() - elkStart).toFixed(2)
const program = catalog.programs.find(program => program.code === 'ERMAJ1688') ?? catalog.programs[0]
const recommendations = timed(() => recommendCourses(program, catalog, profile))
const report = {
  measuredAt: new Date().toISOString(),
  environment: { platform: os.platform(), release: os.release(), cpu: os.cpus()[0].model, node: process.version },
  catalog: { academicYear: catalog.metadata.academicYear, courses: catalog.courses.length, programs: catalog.programs.length },
  allEligibilityMs: evaluation.ms,
  fullGraph: { courseNodes: catalog.courses.length, totalNodes: full.value.nodes.length, edges: full.value.edges.length, projectionMs: full.ms },
  densestSubject: { subject: densest.subject, courseNodes: densest.courses.length, edges: densest.graph.edges.length, projectionMs: denseProjection.ms, elkMs, elkNodes: elkResult.children?.length },
  recommendation: { program: program.code, candidates: recommendations.value.length, ms: recommendations.ms },
  strategy: 'Fixed course-level columns and subject lanes for default projection; optional lazy ELK only orders rows within those columns. All-catalog access uses search/list and bounded progressive graph rendering.',
  caveat: 'Local single-run timings are observations, not a hardware-independent guarantee. Browser rendering is verified separately.',
}
writeFileSync('reports/performance.json', JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report, null, 2))
