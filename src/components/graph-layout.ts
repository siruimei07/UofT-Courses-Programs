import type { Edge, Node, MarkerType } from '@xyflow/react'
import type { Course, Rule, Status, StudentCourse } from '../domain/types'

export const CARD_WIDTH = 244
export const CARD_HEIGHT = 110
const COLUMN_GAP = 88
const ROW_GAP = 34
const LEFT_INSET = 112
const RIGHT_INSET = 42
const LANE_HEADER = 82

type CardData = { course: Course; status: Status; record?: StudentCourse['status']; hidden: number; dimmed: boolean; selected: boolean; [key: string]: unknown }
export type CardNode = Node<CardData, 'course'>
export type LaneNode = Node<{ subject: string; count: number; index: number; focusedCount: number; [key: string]: unknown }, 'lane'>
export type HeadingNode = Node<{ label: string; columns: number; [key: string]: unknown }, 'heading'>
export type GraphNode = CardNode | LaneNode | HeadingNode
export type Relation = 'prerequisite' | 'corequisite' | 'exclusion' | 'recommended'
export type GraphLayout = { nodes: GraphNode[]; edges: Edge[]; hiddenCount: number; width: number; height: number }
export type GraphEdgeData = {
  relation: Relation
  direct: boolean
  focused: boolean
  sourceColumn: number
  targetColumn: number
  skip: boolean
  routeY: number
  sourceLaneY: number
  targetLaneY: number
  [key: string]: unknown
}

const relationStyle: Record<Relation, { stroke: string; dash?: string; label: string }> = {
  prerequisite: { stroke: '#5f849e', label: '先修' },
  corequisite: { stroke: '#9281b0', dash: '6 4', label: '并修' },
  exclusion: { stroke: '#c88176', dash: '3 4', label: '排除' },
  recommended: { stroke: '#8ba091', dash: '1 5', label: '建议' },
}

function ruleLabels(rule: Rule, id: string, parent: string[] = []): string[] {
  switch (rule.kind) {
    case 'all': case 'any': return rule.items.flatMap(item => ruleLabels(item, id, [...parent, rule.kind === 'all' ? 'AND' : 'OR']))
    case 'course': return rule.courseId === id ? parent : []
    case 'minGrade': return rule.courseId === id ? [...parent, `≥${rule.minimum}%`] : []
    case 'credits': return [...parent, `≥${rule.minimum} 学分`]
    case 'unknown': case 'permission': return [...parent, '待确认']
    case 'applicability': return ruleLabels(rule.rule, id, [...parent, rule.cohort])
    default: return parent
  }
}

const courseLevel = (course: Course) => Math.max(100, course.level)
const dependencyIds = (course: Course) => [...new Set([...course.prerequisites.courseIds, ...course.corequisites.courseIds])]

/** Collapse same-level cycles before finding horizontal dependency depth. SCCs only
 * affect placement: all original courses, relations, and rule semantics survive. */
function dependencyRanks(courses: Course[]): Map<string, number> {
  const byId = new Map(courses.map(course => [course.id, course]))
  const outgoing = new Map(courses.map(course => [course.id, [] as string[]]))
  for (const target of courses) for (const source of dependencyIds(target)) {
    const sourceCourse = byId.get(source)
    if (sourceCourse && courseLevel(sourceCourse) === courseLevel(target)) outgoing.get(source)!.push(target.id)
  }
  const indices = new Map<string, number>()
  const lowLinks = new Map<string, number>()
  const stack: string[] = []
  const onStack = new Set<string>()
  const componentById = new Map<string, number>()
  let nextIndex = 0
  let componentCount = 0
  function visit(id: string) {
    indices.set(id, nextIndex)
    lowLinks.set(id, nextIndex++)
    stack.push(id)
    onStack.add(id)
    for (const target of outgoing.get(id)!) {
      if (!indices.has(target)) {
        visit(target)
        lowLinks.set(id, Math.min(lowLinks.get(id)!, lowLinks.get(target)!))
      } else if (onStack.has(target)) lowLinks.set(id, Math.min(lowLinks.get(id)!, indices.get(target)!))
    }
    if (lowLinks.get(id) !== indices.get(id)) return
    let member: string
    do {
      member = stack.pop()!
      onStack.delete(member)
      componentById.set(member, componentCount)
    } while (member !== id)
    componentCount++
  }
  for (const course of courses) if (!indices.has(course.id)) visit(course.id)
  const componentEdges = Array.from({ length: componentCount }, () => new Set<number>())
  const indegrees = Array<number>(componentCount).fill(0)
  for (const [source, targets] of outgoing) for (const target of targets) {
    const from = componentById.get(source)!
    const to = componentById.get(target)!
    if (from !== to && !componentEdges[from].has(to)) {
      componentEdges[from].add(to)
      indegrees[to]++
    }
  }
  const ranks = Array<number>(componentCount).fill(0)
  const queue = indegrees.flatMap((degree, index) => degree === 0 ? [index] : [])
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const from = queue[cursor]
    for (const to of componentEdges[from]) {
      ranks[to] = Math.max(ranks[to], ranks[from] + 1)
      if (--indegrees[to] === 0) queue.push(to)
    }
  }
  return new Map(courses.map(course => [course.id, ranks[componentById.get(course.id)!]]))
}

export function buildSwimlaneGraph(
  courses: Course[], selectedId: string | null, relatedIds: Set<string>,
  statuses: Map<string, Status>, records: Map<string, StudentCourse['status']>,
  relations: Relation[], ordering?: Map<string, number>, options: { width?: number } = {},
): GraphLayout {
  const selectedCourse = courses.find(course => course.id === selectedId)
  selectedId = selectedCourse?.id ?? null
  const visibleCourses = selectedId ? courses.filter(course => course.id === selectedId || relatedIds.has(course.id)) : courses
  const ids = new Set(visibleCourses.map(course => course.id))
  const bySubject = new Map<string, Course[]>()
  for (const course of visibleCourses) {
    if (!bySubject.has(course.subject)) bySubject.set(course.subject, [])
    bySubject.get(course.subject)!.push(course)
  }
  const subjects = [...bySubject.keys()].sort((a, b) => Number(b === selectedCourse?.subject) - Number(a === selectedCourse?.subject) || a.localeCompare(b))
  const nodes: GraphNode[] = []
  const edges: Edge[] = []
  const ranks = selectedId ? dependencyRanks(visibleCourses) : new Map<string, number>()
  const maxLevel = Math.max(400, ...visibleCourses.map(course => courseLevel(course)))
  const levels = Array.from({ length: Math.ceil(maxLevel / 100) }, (_, index) => (index + 1) * 100)
  const levelColumns = new Map(levels.map(level => [level, 1]))
  for (const course of visibleCourses) levelColumns.set(courseLevel(course), Math.max(levelColumns.get(courseLevel(course)) ?? 1, (ranks.get(course.id) ?? 0) + 1))
  const levelStarts = new Map<number, number>()
  let columnCount = 0
  for (const level of levels) {
    levelStarts.set(level, columnCount)
    columnCount += levelColumns.get(level)!
  }
  const minWidth = LEFT_INSET + columnCount * CARD_WIDTH + (columnCount - 1) * COLUMN_GAP + RIGHT_INSET
  const requestedWidth = Number.isFinite(options.width) ? options.width! : 0
  const width = Math.max(minWidth, requestedWidth)
  const columnStep = CARD_WIDTH + COLUMN_GAP + (width - minWidth) / Math.max(1, columnCount - 1)
  const columnFor = (course: Course) => levelStarts.get(courseLevel(course))! + (ranks.get(course.id) ?? 0)
  const xFor = (column: number) => LEFT_INSET + column * columnStep
  for (const level of levels) {
    const columns = levelColumns.get(level)!
    nodes.push({ id: `level:${level}`, type: 'heading', position: { x: xFor(levelStarts.get(level)!), y: 8 }, data: { label: `${level} LEVEL`, columns }, style: { width: (columns - 1) * columnStep + CARD_WIDTH }, selectable: false, draggable: false, focusable: false })
  }
  const directIds = new Set<string>()
  if (selectedId) for (const course of visibleCourses) {
    const sources = dependencyIds(course)
    if (course.id === selectedId) sources.forEach(id => directIds.add(id))
    if (sources.includes(selectedId)) directIds.add(course.id)
  }
  const priority = (course: Course) => course.id === selectedId ? 0 : directIds.has(course.id) ? 1 : 2
  const compare = (a: Course, b: Course) => priority(a) - priority(b) || (ordering ? (ordering.get(a.id) ?? 0) - (ordering.get(b.id) ?? 0) : 0) || a.code.localeCompare(b.code) || a.id.localeCompare(b.id)
  const laneByCourse = new Map<string, number>()
  const columnByCourse = new Map<string, number>()
  const rowByCourse = new Map<string, number>()
  let laneY = 64
  let hiddenCount = 0
  for (const [laneIndex, subject] of subjects.entries()) {
    const laneCourses = bySubject.get(subject)!
    const columns = Array.from({ length: columnCount }, () => [] as Course[])
    for (const course of laneCourses) columns[columnFor(course)].push(course)
    columns.forEach(column => column.sort(compare))
    // Order branches by their already placed predecessors. In overview mode the
    // stable catalogue order is retained; selecting a path unfolds its branches.
    columns.forEach((column, columnIndex) => {
      if (selectedId) {
        const barycenter = (course: Course) => {
          const rows = dependencyIds(course).filter(id => columnByCourse.get(id)! < columnIndex && rowByCourse.has(id) && laneByCourse.get(id) === laneY).map(id => rowByCourse.get(id)!)
          return rows.length ? rows.reduce((sum, row) => sum + row, 0) / rows.length : 0
        }
        column.sort((a, b) => priority(a) - priority(b) || barycenter(a) - barycenter(b) || compare(a, b))
      }
      column.forEach((course, row) => {
        columnByCourse.set(course.id, columnIndex)
        rowByCourse.set(course.id, row)
        laneByCourse.set(course.id, laneY)
      })
    })
    const rowCount = Math.max(...columns.map(column => column.length), 1)
    const height = LANE_HEADER + rowCount * (CARD_HEIGHT + ROW_GAP) + 14
    nodes.push({ id: `lane:${subject}`, type: 'lane', position: { x: 0, y: laneY }, data: { subject, count: laneCourses.length, index: laneIndex, focusedCount: selectedId ? laneCourses.length : 0 }, style: { width, height }, selectable: false, draggable: false, focusable: false, zIndex: -1 })
    columns.forEach((column, columnIndex) => column.forEach((course, row) => {
      const hidden = dependencyIds(course).filter(id => !ids.has(id)).length
      hiddenCount += hidden
      nodes.push({ id: course.id, type: 'course', position: { x: xFor(columnIndex), y: laneY + LANE_HEADER + row * (CARD_HEIGHT + ROW_GAP) }, width: CARD_WIDTH, height: CARD_HEIGHT, data: { course, status: statuses.get(course.id) ?? 'unknown', record: records.get(course.id), hidden, dimmed: false, selected: selectedId === course.id }, selected: course.id === selectedId, ariaLabel: `${course.code} ${course.title}`, draggable: false })
    }))
    laneY += height + 20
  }
  for (const course of visibleCourses) {
    const requirements = { prerequisite: course.prerequisites, corequisite: course.corequisites, exclusion: course.exclusions, recommended: course.recommended }
    for (const relation of relations) {
      const requirement = requirements[relation]
      for (const source of new Set(requirement.courseIds)) {
        if (!ids.has(source) || source === course.id) continue
        const direct = selectedId !== null && (source === selectedId || course.id === selectedId)
        const style = relationStyle[relation]
        const logic = [...new Set(ruleLabels(requirement.rule, source))].join(' · ')
        const sourceColumn = columnByCourse.get(source)!
        const targetColumn = columnByCourse.get(course.id)!
        const sourceLaneY = laneByCourse.get(source)!
        const targetLaneY = laneByCourse.get(course.id)!
        const data: GraphEdgeData = { relation, direct, focused: selectedId !== null, sourceColumn, targetColumn, skip: targetColumn !== sourceColumn + 1 || sourceLaneY !== targetLaneY, routeY: Math.min(sourceLaneY, targetLaneY) + 42 + (edges.length % 4) * 7, sourceLaneY, targetLaneY }
        edges.push({ id: `${relation}:${source}->${course.id}`, source, target: course.id, type: 'default', data, animated: direct && relation !== 'exclusion', label: direct ? `${style.label}${logic ? ` · ${logic}` : ''}` : undefined, ariaLabel: `${source} ${style.label} ${course.code} ${logic}`, markerEnd: relation === 'exclusion' ? undefined : { type: 'arrowclosed' as MarkerType, width: 12, height: 12, color: style.stroke }, style: { stroke: style.stroke, strokeWidth: direct ? 2.2 : 1.25, strokeDasharray: style.dash, opacity: selectedId ? direct ? 0.98 : 0.62 : 0.24 }, labelStyle: { fontSize: 11, fill: '#3e5967' }, labelBgStyle: { fill: '#fff', fillOpacity: 0.96 }, labelBgPadding: [6, 4], zIndex: direct ? 2 : 0 })
      }
    }
  }
  return { nodes, edges, hiddenCount, width, height: subjects.length ? laneY : 160 }
}
