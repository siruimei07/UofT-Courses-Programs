import { describe, expect, it } from 'vitest'
import type { GraphCourse, RequirementLite } from '../src/data/schema'
import type { EvalNode } from '../src/domain/engine-types'
import type { Rule } from '../src/domain/types'
import type { ExcludedEdge, Topology } from '../src/graph/types'
import {
  anyGroups, chainOf, isUnparsed, mentionsOf, missingCourses, needsReadout, relationsOf, ruleAsEval, unlocksReadout,
  unresolvedOf, unwrapEval, unwrapRule,
} from '../src/ui/panels/summary'

/** Minimal topology: only the fields the panel summary reads. */
function topologyOf(codes: string[], edges: [string, string][], excluded: (ExcludedEdge & { codes?: never })[] = []): Topology {
  const indexById = new Map(codes.map((code, index) => [`UTM:${code}`, index]))
  const at = (code: string) => indexById.get(`UTM:${code}`) as number
  const preds: number[][] = codes.map(() => [])
  const succs: number[][] = codes.map(() => [])
  for (const [from, to] of edges) {
    preds[at(to)].push(at(from))
    succs[at(from)].push(at(to))
  }
  return {
    nodes: codes.map((code, index) => ({ index, id: `UTM:${code}`, code, title: code, subject: code.slice(0, 3), level: 100, lane: 0, band: 0, col: 0, order: 0 })),
    indexById,
    edges: edges.map(([from, to]) => ({ from: at(from), to: at(to), kind: 'prereq' as const })),
    excludedEdges: excluded,
    preds,
    succs,
    lanes: [],
    bands: [],
    columnCount: 0,
    cells: [],
  }
}

// A → C, B → C, C → D, D → E, X → C
const topo = topologyOf(['A100', 'B100', 'C200', 'D300', 'E400', 'X100'], [
  ['A100', 'C200'], ['B100', 'C200'], ['X100', 'C200'], ['C200', 'D300'], ['D300', 'E400'], ['B100', 'D300'],
])
const at = (code: string) => topo.indexById.get(`UTM:${code}`) as number
const codesOf = (indices: number[]) => indices.map(i => topo.nodes[i].code)
const course = (rule: Rule, ids: string[]): RequirementLite => ({ text: 'official', rule, ids })
const c = (code: string): Rule => ({ kind: 'course', courseId: `UTM:${code}` })

describe('chain lists', () => {
  it('splits direct and earlier prerequisites and unlocks, sorted by code', () => {
    const chain = chainOf(topo, at('D300'))
    expect(codesOf(chain.directPreds)).toEqual(['B100', 'C200'])
    expect(codesOf(chain.earlierPreds)).toEqual(['A100', 'X100'])
    expect(codesOf(chain.directSuccs)).toEqual(['E400'])
    expect(codesOf(chain.laterSuccs)).toEqual([])
  })

  it('gives every chain node its relation, direct winning over transitive', () => {
    const relations = relationsOf(chainOf(topo, at('A100')))
    expect(relations.get(at('C200'))).toBe('unlock-direct')
    expect(relations.get(at('D300'))).toBe('unlock')
    expect(relations.get(at('E400'))).toBe('unlock')
    expect(relations.has(at('B100'))).toBe(false)
  })
})

describe('needs readout (design-spec 6.3)', () => {
  const chainC = chainOf(topo, at('C200'))

  it('plain parsed rule', () => {
    const prereq = course({ kind: 'all', items: [c('A100'), c('B100'), c('X100')] }, ['UTM:A100', 'UTM:B100', 'UTM:X100'])
    expect(needsReadout(prereq, chainC, topo.indexById)).toEqual({ kind: 'plain', direct: 3, total: 3 })
  })

  it('one top-level any group covering every direct prerequisite', () => {
    const prereq = course({ kind: 'any', items: [c('A100'), c('B100'), { kind: 'minGrade', courseId: 'UTM:X100', minimum: 60 }, c('MAT137Y5')] }, [])
    expect(needsReadout(prereq, chainC, topo.indexById)).toEqual({ kind: 'oneOf', options: 3, total: 3 })
  })

  it('alternatives inside a larger rule', () => {
    const prereq = course({ kind: 'all', items: [c('A100'), { kind: 'any', items: [c('B100'), c('X100')] }] }, [])
    expect(needsReadout(prereq, chainC, topo.indexById)).toEqual({ kind: 'someAlternatives', direct: 3, total: 3 })
    // A top-level any that does not account for every direct prerequisite is not "1 of n".
    const partial = course({ kind: 'any', items: [c('A100'), c('B100')] }, [])
    expect(needsReadout(partial, chainC, topo.indexById).kind).toBe('someAlternatives')
  })

  it('top-level unknown, also below a cohort wrapper', () => {
    const unknown: Rule = { kind: 'unknown', text: 'see calendar', reason: 'x' }
    expect(needsReadout(course(unknown, []), chainC, topo.indexById)).toEqual({ kind: 'unknown', direct: 3, total: 3 })
    const wrapped: Rule = { kind: 'applicability', cohort: 'Fall 2026', rule: unknown }
    expect(needsReadout(course(wrapped, []), chainC, topo.indexById).kind).toBe('unknown')
    expect(isUnparsed(wrapped)).toBe(true)
    expect(isUnparsed({ kind: 'all', items: [unknown, c('A100')] })).toBe(false)
    expect(isUnparsed(undefined)).toBe(false)
  })

  it('no courses on the map vs nothing listed', () => {
    const chainA = chainOf(topo, at('A100'))
    expect(needsReadout(undefined, chainA, topo.indexById)).toEqual({ kind: 'none' })
    expect(needsReadout(course({ kind: 'true' }, []), chainA, topo.indexById)).toEqual({ kind: 'none' })
    expect(needsReadout(course({ kind: 'permission', text: 'Permission of instructor' }, []), chainA, topo.indexById)).toEqual({ kind: 'noCourses' })
  })

  it('unlocks readout', () => {
    expect(unlocksReadout(chainOf(topo, at('A100')))).toEqual({ kind: 'plain', direct: 1, total: 3 })
    expect(unlocksReadout(chainOf(topo, at('E400')))).toEqual({ kind: 'none' })
  })

  it('collects any groups with at least two direct prerequisites', () => {
    const rule: Rule = { kind: 'all', items: [{ kind: 'any', items: [c('A100'), c('B100')] }, { kind: 'any', items: [c('X100'), c('MAT137Y5')] }] }
    expect(anyGroups(rule, chainC, topo.indexById)).toEqual([[at('A100'), at('B100')].sort((a, b) => a - b)])
    expect(unwrapRule({ kind: 'applicability', cohort: 'x', rule: c('A100') })).toEqual(c('A100'))
  })
})

describe('mentions and unresolved references', () => {
  const graphCourse = (overrides: Partial<GraphCourse>): GraphCourse => ({
    id: 'UTM:C200', code: 'C200', title: 'C', subject: 'C20', level: 200, credits: 0.5, ...overrides,
  })

  it('lists excluded layout references into the focus and mentioned codes once each', () => {
    const excluded: ExcludedEdge[] = [
      { from: at('E400'), to: at('C200'), kind: 'prereq', reason: 'backward' },
      { from: at('D300'), to: at('C200'), kind: 'prereq', reason: 'cycle' },
      { from: at('A100'), to: at('B100'), kind: 'prereq', reason: 'cycle' },
    ]
    const t = { ...topo, excludedEdges: excluded }
    const prereq: RequirementLite = { text: '', rule: { kind: 'true' }, ids: [], mentioned: ['UTM:E400', 'UTM:ENG100H5', 'UTM:C200'] }
    expect(mentionsOf(graphCourse({ prereq }), t, at('C200'), [prereq, undefined])).toEqual([
      { id: 'UTM:E400', reason: 'backward' },
      { id: 'UTM:D300', reason: 'cycle' },
      { id: 'UTM:ENG100H5', reason: 'mentioned' },
    ])
  })

  it('collects unresolved ids from every field plus same-campus ids missing from the calendar', () => {
    const has = (id: string) => topo.indexById.has(id)
    const result = unresolvedOf(graphCourse({
      prereq: { text: '', rule: { kind: 'true' }, ids: ['UTM:A100', 'UTM:MAT137Y5', 'UTSG:MAT137Y1'], unresolved: ['UTM:MAT157Y5'] },
      recommended: { text: '', rule: { kind: 'true' }, ids: [], mentioned: ['UTM:OLD100H5'] },
    }), has)
    expect(result).toEqual(['UTM:MAT137Y5', 'UTM:MAT157Y5', 'UTM:OLD100H5'])
  })
})

describe('evaluated trees', () => {
  const leaf = (id: string, status: EvalNode['status']): EvalNode => ({ kind: 'course', courseId: `UTM:${id}`, status })

  it('finds unmet course leaves for "Needs …" reasons', () => {
    const node: EvalNode = { kind: 'all', status: 'unmet', children: [leaf('A100', 'met'), leaf('B100', 'unmet'), { kind: 'minGrade', courseId: 'UTM:X100', minimum: 60, status: 'unknown' }] }
    expect(missingCourses(node)).toEqual({ ids: ['UTM:B100', 'UTM:X100'], oneOf: false })
    const any: EvalNode = { kind: 'applicability', status: 'unmet', text: 'cohort', children: [{ kind: 'any', status: 'unmet', children: [leaf('A100', 'unmet'), leaf('B100', 'unmet')] }] }
    expect(missingCourses(any)).toEqual({ ids: ['UTM:A100', 'UTM:B100'], oneOf: true })
    expect(missingCourses({ ...node, status: 'met' })).toEqual({ ids: [], oneOf: false })
    expect(missingCourses(null)).toEqual({ ids: [], oneOf: false })
  })

  it('unwraps single-child groups and cohorts', () => {
    expect(unwrapEval({ kind: 'all', status: 'met', children: [{ kind: 'any', status: 'met', children: [leaf('A100', 'met')] }] })).toEqual(leaf('A100', 'met'))
  })

  it('turns a rule into an unevaluated tree', () => {
    const rule: Rule = { kind: 'all', items: [
      c('A100'),
      { kind: 'minGrade', courseId: 'UTM:B100', minimum: 60 },
      { kind: 'credits', minimum: 4 },
      { kind: 'program', programId: 'UTM:ERMAJ1688' },
      { kind: 'applicability', cohort: 'Fall 2026', rule: { kind: 'permission', text: 'Permission' } },
    ] }
    expect(ruleAsEval(rule)).toEqual({ kind: 'all', status: 'unknown', children: [
      { kind: 'course', status: 'unknown', courseId: 'UTM:A100' },
      { kind: 'minGrade', status: 'unknown', courseId: 'UTM:B100', minimum: 60 },
      { kind: 'credits', status: 'unknown', minimum: 4 },
      { kind: 'program', status: 'unknown', text: 'UTM:ERMAJ1688' },
      { kind: 'applicability', status: 'unknown', text: 'Fall 2026', children: [{ kind: 'permission', status: 'unknown', text: 'Permission' }] },
    ] })
    expect(ruleAsEval({ kind: 'true' })).toEqual({ kind: 'true', status: 'met' })
  })
})
