import { describe, expect, it } from 'vitest'
import { classifyRequirements } from '../src/app/readout'
import { format } from '../src/i18n'
import type { GraphCourse, RequirementLite } from '../src/data/schema'
import type { CourseEvaluation, EvalNode } from '../src/domain/engine-types'
import type { Rule } from '../src/domain/types'
import type { EdgeKind, ExcludedEdge, Topology } from '../src/graph/types'
import { panelStrings } from '../src/ui/panels/strings'
import {
  chainOf, exclusionNote, isUnparsed, mentionsOf, missingCourses, missingText, nextReason, relationsOf, ruleAsEval, unlocksReadout,
  unresolvedOf,
} from '../src/ui/panels/summary'

const en = panelStrings.en
const zh = panelStrings.zh

/** Minimal topology: only the fields the panel summary reads. Edges are prerequisites unless marked. */
function topologyOf(codes: string[], edges: ([string, string] | [string, string, EdgeKind])[], excluded: (ExcludedEdge & { codes?: never })[] = []): Topology {
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
    edges: edges.map(([from, to, kind = 'prereq']) => ({ from: at(from), to: at(to), kind })),
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

describe('chain lists and the shared readout classifier', () => {
  // P → F (prerequisite), Q → F (corequisite), R → Q (prerequisite of the corequisite), F → G.
  const split = topologyOf(['P100', 'Q100', 'R100', 'F200', 'G300'], [
    ['P100', 'F200'], ['Q100', 'F200', 'coreq'], ['R100', 'Q100'], ['F200', 'G300'],
  ])
  const focus = split.indexById.get('UTM:F200') as number
  const codesIn = (indices: number[]) => indices.map(i => split.nodes[i].code)

  it('lists corequisites apart from the direct prerequisites', () => {
    const chain = chainOf(split, focus)
    expect(codesIn(chain.directPreds)).toEqual(['P100'])
    expect(codesIn(chain.directCoreqs)).toEqual(['Q100'])
    expect(codesIn(chain.earlierPreds)).toEqual(['R100'])
    const relations = relationsOf(chain)
    expect(relations.get(split.indexById.get('UTM:Q100') as number)).toBe('prereq-direct')
    expect(relations.get(split.indexById.get('UTM:R100') as number)).toBe('prereq')
  })

  it('agrees with the card head classifier on direct counts', () => {
    const graphCourse: GraphCourse = {
      id: 'UTM:F200', code: 'F200', title: 'F', subject: 'F20', level: 200, credits: 0.5,
      prereq: course(c('P100'), ['UTM:P100']),
      coreq: course(c('Q100'), ['UTM:Q100']),
    }
    const chain = chainOf(split, focus)
    const readout = classifyRequirements(graphCourse, split, focus)
    expect(readout.needs).toMatchObject({ kind: 'plain', direct: chain.directPreds.length })
    expect(readout.coreqs).toEqual({ kind: 'plain', count: chain.directCoreqs.length })
  })

  it('unlocks readout', () => {
    expect(unlocksReadout(chainOf(topo, at('A100')))).toEqual({ kind: 'plain', direct: 1, total: 3 })
    expect(unlocksReadout(chainOf(topo, at('E400')))).toEqual({ kind: 'none' })
  })

  it('treats a top-level unknown rule as unparsed, also below a cohort wrapper', () => {
    const unknown: Rule = { kind: 'unknown', text: 'see calendar', reason: 'x' }
    expect(isUnparsed({ kind: 'applicability', cohort: 'Fall 2026', rule: unknown })).toBe(true)
    expect(isUnparsed({ kind: 'all', items: [unknown, c('A100')] })).toBe(false)
    expect(isUnparsed(undefined)).toBe(false)
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
    expect(missingCourses(node)).toEqual({ required: ['UTM:B100', 'UTM:X100'], choices: [] })
    const any: EvalNode = { kind: 'applicability', status: 'unmet', text: 'cohort', children: [{ kind: 'any', status: 'unmet', children: [leaf('A100', 'unmet'), leaf('B100', 'unmet')] }] }
    expect(missingCourses(any)).toEqual({ required: [], choices: [['UTM:A100', 'UTM:B100']] })
    expect(missingCourses({ ...node, status: 'met' })).toEqual({ required: [], choices: [] })
    expect(missingCourses(null)).toEqual({ required: [], choices: [] })
  })

  it('keeps nested "one of" groups apart from required courses', () => {
    // all(any(A, B), C): A and B are alternatives, C is required.
    const node: EvalNode = { kind: 'all', status: 'unmet', children: [
      { kind: 'any', status: 'unmet', children: [leaf('A100', 'unmet'), leaf('B100', 'unmet')] },
      leaf('C200', 'unmet'),
    ] }
    const missing = missingCourses(node)
    expect(missing).toEqual({ required: ['UTM:C200'], choices: [['UTM:A100', 'UTM:B100']] })
    expect(missingText(missing, en)).toBe('C200; one of A100, B100')
    expect(missingText(missing, zh)).toBe('C200；A100、B100 中任一门')
    // A met alternative satisfies its group; a one-option group is simply required.
    const metGroup: EvalNode = { ...node, children: [{ kind: 'any', status: 'met', children: [leaf('A100', 'met'), leaf('B100', 'unmet')] }, leaf('C200', 'unmet')] }
    expect(missingCourses(metGroup)).toEqual({ required: ['UTM:C200'], choices: [] })
    const single: EvalNode = { kind: 'any', status: 'unmet', children: [leaf('A100', 'unmet'), { kind: 'permission', status: 'unknown', text: 'x' }] }
    expect(missingCourses(single)).toEqual({ required: ['UTM:A100'], choices: [] })
  })

  it('caps the reason line at two codes per part and two parts', () => {
    const many = { required: ['UTM:A1', 'UTM:B2', 'UTM:C3'], choices: [['UTM:D4', 'UTM:E5'], ['UTM:F6', 'UTM:G7']] }
    expect(missingText(many, en)).toBe('A1, B2 +1 more; one of D4, E5 +1 more')
    expect(missingText({ required: [], choices: [] }, en)).toBeNull()
  })

  it('shows a red exclusion only for parsed matches and a soft note for possible ones', () => {
    expect(exclusionNote({ status: 'blocked', blockedBy: ['UTM:CSC108H5'] })).toEqual({ tone: 'blocked', ids: ['UTM:CSC108H5'] })
    expect(exclusionNote({ status: 'unknown', blockedBy: ['UTM:CSC108H5'] })).toEqual({ tone: 'maybe', ids: ['UTM:CSC108H5'] })
    expect(exclusionNote({ status: 'unknown', blockedBy: [] })).toBeNull()
    expect(exclusionNote({ status: 'clear', blockedBy: [] })).toBeNull()
    expect(exclusionNote(null)).toBeNull()
    expect(format(en.mayExclude, { codes: 'CSC108H5' })).toMatch(/^May exclude: /)
    expect(format(zh.mayExclude, { codes: 'CSC108H5' })).toMatch(/^可能互斥：/)
  })

  it('words "Take next" reasons from the engine reason and the evaluation', () => {
    const evaluation = (prerequisites: EvalNode | null, corequisites: EvalNode | null): CourseEvaluation => ({
      courseId: 'UTM:F200', overall: 'unmet', prerequisites, corequisites, exclusions: null, restrictions: null,
    })
    const nested: EvalNode = { kind: 'all', status: 'unmet', children: [
      { kind: 'any', status: 'unmet', children: [leaf('A100', 'unmet'), leaf('B100', 'unmet')] },
      leaf('C200', 'unmet'),
    ] }
    expect(nextReason('ready', null, en)).toBe(en.reasonReady)
    expect(nextReason('check-requirements', null, en)).toBe(en.reasonCheck)
    expect(nextReason('needs-prerequisites', evaluation(nested, null), en)).toBe('Needs C200; one of A100, B100')
    expect(nextReason('needs-corequisites', evaluation(null, leaf('Q100', 'unmet')), en)).toBe('Take with Q100')
    expect(nextReason('needs-corequisites', evaluation(null, null), en)).toBe(en.reasonCoreqSome)
    // No course to name (credits, permission): the generic line.
    expect(nextReason('needs-prerequisites', evaluation({ kind: 'credits', status: 'unmet', minimum: 4 }, null), en)).toBe(en.reasonNeedsSome)
    // An unmet corequisite reported as needs-prerequisites still names the corequisite.
    expect(nextReason('needs-prerequisites', evaluation(null, leaf('Q100', 'unmet')), en)).toBe('Take with Q100')
    expect(nextReason('needs-prerequisites', evaluation(nested, null), zh)).toBe('还需 C200；A100、B100 中任一门')
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
