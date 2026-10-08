import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildSwimlaneGraph, CARD_HEIGHT, CARD_WIDTH, type CardNode, type GraphLayout } from '../src/components/graph-layout'
import { getRelatedCourses } from '../src/domain/planner'
import type { Catalog, Course, Requirement } from '../src/domain/types'

const catalog = JSON.parse(readFileSync('public/data/catalog.json', 'utf8')) as Catalog
const cards = (graph: GraphLayout) => graph.nodes.filter((node): node is CardNode => node.type === 'course')
const card = (graph: GraphLayout, code: string) => cards(graph).find(node => node.data.course.code === code)!
function relatedTo(code: string) {
  const related = getRelatedCourses(`UTM:${code}`, catalog.courses)
  return new Set([...related.transitivePrerequisites, ...related.transitiveDependents])
}
function focused(code: string, width?: number) {
  return buildSwimlaneGraph(catalog.courses, `UTM:${code}`, relatedTo(code), new Map(), new Map(), ['prerequisite', 'corequisite'], undefined, { width })
}
function overlaps(graph: GraphLayout) {
  const ordered = cards(graph).sort((a, b) => a.position.x - b.position.x)
  const collisions: string[] = []
  ordered.forEach((a, index) => {
    for (let next = index + 1; next < ordered.length; next++) {
      const b = ordered[next]
      if (b.position.x >= a.position.x + CARD_WIDTH) break
      if (a.position.y < b.position.y + CARD_HEIGHT && b.position.y < a.position.y + CARD_HEIGHT) collisions.push(`${a.id}/${b.id}`)
    }
  })
  return collisions
}
function requirement(ids: string[]): Requirement {
  return { rawText: ids.join(' and '), sourceUrl: 'https://utm.calendar.utoronto.ca/', courseIds: ids, rule: { kind: 'all', items: ids.map(courseId => ({ kind: 'course', courseId })) } }
}
function fixture(code: string, prerequisites: string[] = [], overrides: Partial<Course> = {}): Course {
  return { ...catalog.courses[0], id: `UTM:${code}`, code, subject: code.slice(0, 3), level: Number(code[3]) * 100, prerequisites: requirement(prerequisites), corequisites: requirement([]), exclusions: requirement([]), recommended: requirement([]), ...overrides }
}

describe('full-catalog graph projection', () => {
  it('retains every catalog course, including isolated courses, in subject lanes', () => {
    const graph = buildSwimlaneGraph(catalog.courses, null, new Set(), new Map(), new Map(), ['prerequisite', 'corequisite'])
    const cards = graph.nodes.filter(node => node.type === 'course')
    expect(cards).toHaveLength(catalog.courses.length)
    expect(new Set(cards.map(node => node.id)).size).toBe(catalog.courses.length)
    expect(cards.every(node => Number.isFinite(node.position.x) && Number.isFinite(node.position.y))).toBe(true)
    expect(graph.nodes.filter(node => node.type === 'lane')).toHaveLength(new Set(catalog.courses.map(course => course.subject)).size)
    const positions = cards.map(node => `${node.position.x},${node.position.y}`)
    expect(new Set(positions).size).toBe(positions.length)
    expect(overlaps(graph)).toEqual([])
  })

  it('makes hidden prerequisite references explicit after filtering', () => {
    const course = catalog.courses.find(course => course.code === 'ANT202H5')!
    const graph = buildSwimlaneGraph([course], course.id, new Set(), new Map(), new Map(), ['prerequisite'])
    expect(graph.hiddenCount).toBe(2)
    expect(graph.edges).toHaveLength(0)
  })

  it('keeps OR labels and separate relation types when selected', () => {
    const course = catalog.courses.find(course => course.code === 'ANT202H5')!
    const ids = new Set([course.id, ...course.prerequisites.courseIds])
    const graph = buildSwimlaneGraph(catalog.courses.filter(item => ids.has(item.id)), course.id, ids, new Map(), new Map(), ['prerequisite'])
    const incoming = graph.edges.filter(edge => edge.target === course.id)
    expect(incoming).toHaveLength(2)
    expect(incoming.every(edge => String(edge.label).includes('OR'))).toBe(true)
    expect(incoming.every(edge => edge.id.startsWith('prerequisite:'))).toBe(true)
  })

  it('uses available width while retaining readable card sizes on narrow canvases', () => {
    const project = (width: number) => buildSwimlaneGraph(catalog.courses, null, new Set(), new Map(), new Map(), ['prerequisite'], undefined, { width })
    const standard = project(1800)
    const wide = project(3200)
    const narrow = project(390)
    expect(standard.width).toBe(1800)
    expect(wide.width).toBe(3200)
    expect(card(wide, 'CSC413H5').position.x).toBeGreaterThan(card(standard, 'CSC413H5').position.x + 1000)
    expect(Math.max(...cards(wide).map(node => node.position.x + CARD_WIDTH))).toBeGreaterThan(wide.width - 60)
    expect(wide.nodes.filter(node => node.type === 'lane').every(node => node.style?.width === 3200)).toBe(true)
    expect(cards(narrow).every(node => node.width === CARD_WIDTH && node.height === CARD_HEIGHT)).toBe(true)
    expect(narrow.width).toBeGreaterThan(390)
    expect(overlaps(narrow)).toEqual([])
  })

  it('keeps overview levels in single columns and unfolds the real CSC108 to CSC148 chain', () => {
    const overview = buildSwimlaneGraph(catalog.courses, null, new Set(), new Map(), new Map(), ['prerequisite'])
    const selected = focused('CSC108H5', 3400)
    expect(card(overview, 'CSC108H5').position.x).toBe(card(overview, 'CSC148H5').position.x)
    expect(card(selected, 'CSC148H5').position.x).toBeGreaterThan(card(selected, 'CSC108H5').position.x + CARD_WIDTH)
    expect(card(selected, 'CSC148H5').position.y).toBe(card(selected, 'CSC108H5').position.y)
    expect(card(selected, 'CSC209H5').position.x).toBeGreaterThan(card(selected, 'CSC207H5').position.x + CARD_WIDTH)
    const expectedIds = new Set(['UTM:CSC108H5', ...relatedTo('CSC108H5')])
    expect(cards(selected).map(node => node.id).sort()).toEqual(catalog.courses.filter(course => expectedIds.has(course.id)).map(course => course.id).sort())
    expect(card(selected, 'CSC105H5')).toBeUndefined()
    expect(selected.nodes.find(node => node.type === 'lane')?.data.subject).toBe('CSC')
    expect(overlaps(selected)).toEqual([])
  })

  it('reorders every preceding level when a 300-level course is selected', () => {
    const graph = focused('CSC301H5')
    for (const [source, target] of [['CSC108H5', 'CSC148H5'], ['CSC110Y5', 'CSC111H5'], ['CSC207H5', 'CSC209H5'], ['CSC209H5', 'CSC301H5']]) {
      expect(card(graph, target).position.x).toBeGreaterThan(card(graph, source).position.x + CARD_WIDTH)
    }
    expect(card(graph, 'CSC108H5').position.y).toBe(card(graph, 'CSC148H5').position.y)
    expect(card(graph, 'CSC110Y5').position.y).toBe(card(graph, 'CSC111H5').position.y)
    expect(card(graph, 'CSC301H5').position.y).toBe(card(graph, 'CSC209H5').position.y)
    expect(graph.edges.filter(edge => edge.label).every(edge => edge.source === 'UTM:CSC301H5' || edge.target === 'UTM:CSC301H5')).toBe(true)
    expect(overlaps(graph)).toEqual([])
  })

  it('keeps cross-subject paths, external references, and safe routing metadata explicit', () => {
    const graph = focused('CSC309H5')
    expect(graph.nodes.some(node => node.type === 'lane' && node.data.subject === 'MAT')).toBe(true)
    expect(graph.hiddenCount).toBeGreaterThan(0)
    const nodeIds = new Set(cards(graph).map(node => node.id))
    expect(graph.edges.every(edge => nodeIds.has(edge.source) && nodeIds.has(edge.target))).toBe(true)
    const crossLaneEdges = graph.edges.filter(edge => edge.data?.sourceLaneY !== edge.data?.targetLaneY)
    expect(crossLaneEdges.length).toBeGreaterThan(0)
    expect(crossLaneEdges.every(edge => edge.data?.skip && Number.isFinite(edge.data?.routeY))).toBe(true)
    expect(graph.edges.every(edge => Number(edge.data?.routeY) < Math.min(cards(graph).find(node => node.id === edge.source)!.position.y, cards(graph).find(node => node.id === edge.target)!.position.y))).toBe(true)
    expect(overlaps(graph)).toEqual([])
  })

  it('handles cyclic same-level dependencies without losing nodes or treating exclusions as progression', () => {
    const courses = [
      fixture('CSC101H5', ['UTM:CSC102H5']),
      fixture('CSC102H5', [], { corequisites: requirement(['UTM:CSC101H5']) }),
      fixture('CSC103H5', ['UTM:CSC102H5']),
      fixture('CSC104H5', [], { exclusions: requirement(['UTM:CSC103H5']) }),
    ]
    const graph = buildSwimlaneGraph(courses, courses[0].id, new Set(courses.map(course => course.id)), new Map(), new Map(), ['prerequisite', 'corequisite', 'exclusion'])
    expect(cards(graph)).toHaveLength(4)
    expect(card(graph, 'CSC101H5').position.x).toBe(card(graph, 'CSC102H5').position.x)
    expect(card(graph, 'CSC103H5').position.x).toBeGreaterThan(card(graph, 'CSC102H5').position.x + CARD_WIDTH)
    expect(card(graph, 'CSC104H5').position.x).toBe(card(graph, 'CSC101H5').position.x)
    expect(graph.edges).toHaveLength(4)
    expect(graph.edges.find(edge => edge.id.startsWith('exclusion:'))?.markerEnd).toBeUndefined()
    expect(graph.edges.find(edge => edge.id.startsWith('corequisite:'))?.style?.strokeDasharray).toBeTruthy()
    expect(overlaps(graph)).toEqual([])
    expect(Number.isFinite(graph.width) && Number.isFinite(graph.height)).toBe(true)
  })

  it('retains courses and record states when a selection is absent from the filtered view', () => {
    const course = catalog.courses.find(course => course.code === 'ANT101H5')!
    const graph = buildSwimlaneGraph([course], 'UTM:CSC108H5', new Set(), new Map([[course.id, 'met']]), new Map([[course.id, 'completed']]), ['prerequisite'])
    expect(cards(graph)).toHaveLength(1)
    expect(cards(graph)[0].data).toMatchObject({ selected: false, dimmed: false, status: 'met', record: 'completed' })
  })
})
