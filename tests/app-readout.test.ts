import { describe, expect, it } from 'vitest'
import { boxFitsPlot, chainBox, FRAME_ZOOM_FLOOR } from '../src/app/framing'
import { academicYearLabel, formatFetchDate } from '../src/app/format'
import { anyGroupsOf, computeReadout, reachCount, shownCounts, unwrapRule } from '../src/app/readout'
import type { GraphCourse } from '../src/data/schema'
import type { Rule } from '../src/domain/types'
import type { Geometry, NodeBox, NodeRole, Presentation, Topology } from '../src/graph/types'

/** Minimal topology: only the fields the readout helpers read. */
function topology(ids: string[], edges: [number, number][]): Topology {
  const preds: number[][] = ids.map(() => [])
  const succs: number[][] = ids.map(() => [])
  for (const [from, to] of edges) {
    preds[to].push(from)
    succs[from].push(to)
  }
  return {
    nodes: ids.map((id, index) => ({ index, id, code: id.split(':')[1], title: id, subject: id.slice(4, 7), level: 100, lane: 0, band: 0, col: 0, order: index })),
    indexById: new Map(ids.map((id, index) => [id, index])),
    edges: edges.map(([from, to]) => ({ from, to, kind: 'prereq' as const })),
    excludedEdges: [],
    preds,
    succs,
    lanes: [{ index: 0, key: 'UTM:X', subject: 'X', name: 'X', department: '', division: '', nodes: ids.map((_, index) => index) }],
    bands: [],
    columnCount: 1,
    cells: [],
  }
}

const course = (id: string, rule?: Rule): GraphCourse => ({
  id, code: id.split(':')[1], title: id, subject: 'MAT', level: 200, credits: 0.5,
  ...(rule ? { prereq: { text: 'official text', rule, ids: [] } } : {}),
})

const leaf = (code: string): Rule => ({ kind: 'course', courseId: `UTM:${code}` })

function presentation(roles: NodeRole[], hidden: number[] = []): Presentation {
  return {
    cls: roles.map((_, index) => (hidden.includes(index) ? 'hidden' : 'full')),
    role: roles,
    record: roles.map(() => null),
    eligibility: roles.map(() => null),
    inProgram: roles.map(() => false),
    edgeRole: [],
    dimming: true,
  }
}

// A, B, C, D → F (focus 4) → G → H
const ids = ['UTM:A100H5', 'UTM:B100H5', 'UTM:C100H5', 'UTM:D100H5', 'UTM:F200H5', 'UTM:G300H5', 'UTM:H400H5', 'UTM:Z100H5']
const topo = topology(ids, [[0, 4], [1, 4], [2, 4], [3, 4], [7, 0], [4, 5], [5, 6]])
const roles: NodeRole[] = ['prereq-direct', 'prereq-direct', 'prereq-direct', 'prereq-direct', 'focus', 'unlock-direct', 'unlock', 'prereq']

describe('anyGroupsOf', () => {
  it('collects course leaves of top-level and nested any nodes that are direct predecessors', () => {
    const rule: Rule = { kind: 'all', items: [leaf('A100H5'), { kind: 'any', items: [leaf('B100H5'), { kind: 'minGrade', courseId: 'UTM:C100H5', minimum: 60 }, leaf('Q999H5')] }] }
    expect(anyGroupsOf(rule, topo, 4)).toEqual([[1, 2]])
  })

  it('drops groups with fewer than two drawn leaves and unknown rules', () => {
    expect(anyGroupsOf({ kind: 'any', items: [leaf('A100H5'), leaf('Q999H5')] }, topo, 4)).toEqual([])
    expect(anyGroupsOf({ kind: 'unknown', text: 'x', reason: 'y' }, topo, 4)).toEqual([])
    expect(anyGroupsOf(undefined, topo, 4)).toEqual([])
  })

  it('looks through cohort wrappers', () => {
    const rule: Rule = { kind: 'applicability', cohort: 'x', rule: { kind: 'any', items: [leaf('A100H5'), leaf('D100H5')] } }
    expect(unwrapRule(rule).kind).toBe('any')
    expect(anyGroupsOf(rule, topo, 4)).toEqual([[0, 3]])
  })
})

describe('computeReadout (design-spec 6.3)', () => {
  const pres = presentation(roles)

  it('counts direct and total prerequisites and unlocks', () => {
    const readout = computeReadout(topo, pres, 4, course(ids[4], { kind: 'all', items: ['A100H5', 'B100H5', 'C100H5', 'D100H5'].map(leaf) }))
    expect(readout.needs).toEqual({ kind: 'plain', direct: 4, total: 5 })
    expect(readout.unlocks).toEqual({ kind: 'plain', direct: 1, total: 2 })
    expect(readout.hiddenByFilters).toBe(0)
  })

  it('says "1 of N" only for one top-level any group covering every direct prerequisite', () => {
    const oneOf = computeReadout(topo, pres, 4, course(ids[4], { kind: 'any', items: ['A100H5', 'B100H5', 'C100H5', 'D100H5'].map(leaf) }))
    expect(oneOf.needs).toEqual({ kind: 'oneOf', of: 4, total: 5 })
    const mixed = computeReadout(topo, pres, 4, course(ids[4], { kind: 'all', items: [leaf('A100H5'), leaf('B100H5'), { kind: 'any', items: [leaf('C100H5'), leaf('D100H5')] }] }))
    expect(mixed.needs).toEqual({ kind: 'alternatives', direct: 4, total: 5 })
  })

  it('uses the neutral form for a top-level unknown rule', () => {
    const readout = computeReadout(topo, pres, 4, course(ids[4], { kind: 'unknown', text: 'x', reason: 'y' }))
    expect(readout.needs).toEqual({ kind: 'unknown', direct: 4, total: 5 })
  })

  it('distinguishes no prerequisites from prerequisites that are not on the map', () => {
    const lone = topology(['UTM:A100H5'], [])
    const single = presentation(['focus'])
    expect(computeReadout(lone, single, 0, course('UTM:A100H5')).needs).toEqual({ kind: 'none' })
    expect(computeReadout(lone, single, 0, course('UTM:A100H5', { kind: 'permission', text: 'instructor' })).needs).toEqual({ kind: 'offMap' })
    expect(computeReadout(lone, single, 0, course('UTM:A100H5')).unlocks).toEqual({ kind: 'none' })
  })

  it('counts chain courses hidden by filters', () => {
    const readout = computeReadout(topo, presentation(roles, [6, 7]), 4, course(ids[4]))
    expect(readout.hiddenByFilters).toBe(2)
  })

  it('reachCount excludes the start node', () => {
    expect(reachCount(topo.preds, 4)).toBe(5)
    expect(reachCount(topo.succs, 6)).toBe(0)
  })

  it('shownCounts counts visible courses and subjects with any visible course', () => {
    expect(shownCounts(topo, presentation(roles, [6, 7]))).toEqual({ courses: 6, subjects: 1 })
  })
})

describe('chain titles auto (design-spec 8.2)', () => {
  const box = (x: number, w: number): NodeBox => ({ x, y: 100, w, h: 30, cx: x - 12, cy: 115, cls: 'full', track: 0, overflow: false })
  const geometry = (nodes: NodeBox[]): Geometry => ({ nodes, columns: [], lanes: [], bands: [], width: 3000, height: 1000 })

  it('unions dot and label boxes of visible chain nodes plus 12 px', () => {
    const pres = presentation(['prereq-direct', 'focus', 'none'])
    const result = chainBox(pres, geometry([box(200, 100), box(500, 200), box(2000, 100)]))
    // Left: dot at 188 − 8.5; right: label end 700; plus 12 px each side.
    expect(result).toEqual({ x: 188 - 8.5 - 12, y: 100 - 12, w: 700 - 179.5 + 24, h: 30 + 24 })
    expect(chainBox(presentation(['none']), geometry([box(0, 10)]))).toBeNull()
  })

  it('fits when the box is narrower than the plot minus margins at the 0.92 floor', () => {
    // 994 − 2 × 16 = 962 px available: 1045 × 0.92 = 961.4 fits, 1046 × 0.92 = 962.3 does not.
    expect(FRAME_ZOOM_FLOOR).toBe(0.92)
    const fits = { x: 0, y: 0, w: 1045, h: 10 }
    expect(boxFitsPlot(fits, { width: 994, height: 582 })).toBe(true)
    expect(boxFitsPlot({ ...fits, w: 1046 }, { width: 994, height: 582 })).toBe(false)
    expect(boxFitsPlot(null, { width: 994, height: 582 })).toBe(true)
    expect(boxFitsPlot(fits, null)).toBe(true)
  })
})

describe('format', () => {
  it('formats the academic year and the fetch date in Toronto time', () => {
    expect(academicYearLabel('2026-2027')).toBe('2026–2027')
    expect(academicYearLabel('2026-2027', true)).toBe('2026–27')
    expect(academicYearLabel('next year')).toBe('next year')
    expect(formatFetchDate('2026-10-08T04:33:00+00:00', 'en')).toBe('Oct 8, 2026')
    expect(formatFetchDate('2026-10-08T04:33:00+00:00', 'zh')).toBe('2026年10月8日')
  })
})
