// Evaluator core, Rule helpers and record merging (src/domain). Synthetic ids only; real-data
// regressions live in domain-official.test.ts and catalog.test.ts, the engine API in domain-engine.test.ts.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { containsOpaque, recordFromRows, ruleCourseIds } from '../src/domain'
import type { RecordEntryLike, Rule } from '../src/domain'
import { combine, createEvalContext, evaluateRule, usedCourses, type Counting, type RuleIndex } from '../src/domain/evaluate'

const id = (code: string) => (code.includes(':') ? code : `UTM:${code}`)
const course = (code: string): Rule => ({ kind: 'course', courseId: id(code) })
const minGrade = (code: string, minimum: number): Rule => ({ kind: 'minGrade', courseId: id(code), minimum })
const all = (...items: Rule[]): Rule => ({ kind: 'all', items })
const any = (...items: Rule[]): Rule => ({ kind: 'any', items })
const unknown = (text = 'Unparsed wording'): Rule => ({ kind: 'unknown', text, reason: 'test' })

// TST = subject, digit 1-4 = level, H/Y = half/full credit.
const CODES = ['TST100H5', 'TST101H5', 'TST102Y5', 'TST200H5', 'TST201H5', 'TST300H5', 'OTH100H5', 'OTH300Y5']
function index(exclusionPairs: [string, string][] = []): RuleIndex {
  const courses = new Map(CODES.map(code => [id(code), {
    credits: code[6] === 'Y' ? 1 : 0.5, subject: code.slice(0, 3), level: Number(code[3]) * 100,
  }]))
  const exclusionPeers = new Map<string, Set<string>>()
  for (const [a, b] of exclusionPairs) {
    for (const [x, y] of [[a, b], [b, a]]) {
      if (!exclusionPeers.has(id(x))) exclusionPeers.set(id(x), new Set())
      exclusionPeers.get(id(x))!.add(id(y))
    }
  }
  return { courses, exclusionPeers }
}
type Row = [string, RecordEntryLike['status'], number?]
const record = (...rows: Row[]) => new Map(rows.map(([code, status, grade]) =>
  [id(code), grade === undefined ? { status } : { status, grade }] as [string, RecordEntryLike]))
const status = (rule: Rule, rows: Row[], counting: Counting = 'current', pairs: [string, string][] = []) =>
  evaluateRule(rule, createEvalContext(index(pairs), record(...rows)), counting).status

describe('three-valued logic', () => {
  it('combines AND / OR with unknown propagation', () => {
    expect(combine('all', ['met', 'met'])).toBe('met')
    expect(combine('all', ['met', 'unknown'])).toBe('unknown')
    expect(combine('all', ['unknown', 'unmet'])).toBe('unmet')
    expect(combine('any', ['unmet', 'met'])).toBe('met')
    expect(combine('any', ['unmet', 'unknown'])).toBe('unknown')
    expect(combine('any', ['unmet', 'unmet'])).toBe('unmet')
    expect(combine('all', [])).toBe('met')
  })

  it('(A OR B) AND C requires both groups', () => {
    const rule = all(any(course('TST100H5'), course('TST101H5')), course('TST200H5'))
    expect(status(rule, [['TST100H5', 'completed']])).toBe('unmet')
    expect(status(rule, [['TST101H5', 'completed'], ['TST200H5', 'completed']])).toBe('met')
    expect(status(rule, [])).toBe('unmet')
  })

  it('keeps unparsed text unknown instead of dropping it', () => {
    expect(status(all(course('TST100H5'), unknown()), [])).toBe('unmet')
    expect(status(all(course('TST100H5'), unknown()), [['TST100H5', 'completed']])).toBe('unknown')
    expect(status(any(course('TST100H5'), unknown()), [['TST100H5', 'completed']])).toBe('met')
    expect(status(any(course('TST100H5'), unknown()), [])).toBe('unknown')
    expect(status({ kind: 'permission', text: 'Permission of instructor' }, [])).toBe('unknown')
    expect(status({ kind: 'program', programId: 'UTM:ERMAJ0001' }, [])).toBe('unknown')
    expect(status({ kind: 'true' }, [])).toBe('met')
  })

  it('returns an EvalNode tree that mirrors the AST, with no prose', () => {
    const rule = all(course('TST100H5'), any(minGrade('TST101H5', 60), unknown('Grade 12 Calculus')), { kind: 'credits', minimum: 1 })
    const node = evaluateRule(rule, createEvalContext(index(), record(['TST100H5', 'completed'], ['TST101H5', 'completed', 72])), 'current')
    expect(node).toEqual({
      kind: 'all', status: 'met', children: [
        { kind: 'course', status: 'met', courseId: 'UTM:TST100H5' },
        { kind: 'any', status: 'met', children: [
          { kind: 'minGrade', status: 'met', courseId: 'UTM:TST101H5', minimum: 60 },
          { kind: 'unknown', status: 'unknown', text: 'Grade 12 Calculus' },
        ] },
        { kind: 'credits', status: 'met', minimum: 1, earned: 1 },
      ],
    })
  })
})

describe('course and grade leaves', () => {
  it('treats unmarked courses as not taken', () => {
    expect(status(course('TST100H5'), [])).toBe('unmet')
  })

  it('counts a completed course without a grade as passed and below 50 as failed', () => {
    expect(status(course('TST100H5'), [['TST100H5', 'completed']])).toBe('met')
    expect(status(course('TST100H5'), [['TST100H5', 'completed', 50]])).toBe('met')
    expect(status(course('TST100H5'), [['TST100H5', 'completed', 49]])).toBe('unmet')
  })

  it('counts in-progress courses for prerequisites but not for completed-only progress', () => {
    expect(status(course('TST100H5'), [['TST100H5', 'inProgress']], 'current')).toBe('met')
    expect(status(course('TST100H5'), [['TST100H5', 'inProgress']], 'completed')).toBe('unmet')
  })

  it('counts planned courses only when taken together (corequisites, plans)', () => {
    expect(status(course('TST100H5'), [['TST100H5', 'planned']], 'current')).toBe('unmet')
    expect(status(course('TST100H5'), [['TST100H5', 'planned']], 'planned')).toBe('met')
  })

  it('needs the final grade for a minimum grade', () => {
    const rule = minGrade('TST100H5', 73)
    expect(status(rule, [['TST100H5', 'completed', 73]])).toBe('met')
    expect(status(rule, [['TST100H5', 'completed', 72]])).toBe('unmet')
    expect(status(rule, [['TST100H5', 'completed']])).toBe('unknown')
    expect(status(rule, [['TST100H5', 'completed', 45]])).toBe('unmet')
    expect(status(rule, [['TST100H5', 'inProgress', 95]])).toBe('unknown')
    expect(status(rule, [['TST100H5', 'planned']], 'current')).toBe('unmet')
    expect(status(rule, [['TST100H5', 'planned']], 'planned')).toBe('unknown')
    expect(status(rule, [])).toBe('unmet')
  })

  it('keeps campus identities distinct', () => {
    expect(status(course('UTSG:TST100H1'), [['TST100H5', 'completed']])).toBe('unmet')
    expect(status(course('UTSG:TST100H1'), [['UTSG:TST100H1', 'completed']])).toBe('met')
  })

  it('treats a cohort clause as met when its rule is met, otherwise as unknown', () => {
    const rule: Rule = { kind: 'applicability', cohort: 'For students entering in 2027-28', rule: course('TST100H5') }
    const met = evaluateRule(rule, createEvalContext(index(), record(['TST100H5', 'completed'])), 'current')
    expect(met).toEqual({ kind: 'applicability', status: 'met', text: 'For students entering in 2027-28', children: [{ kind: 'course', status: 'met', courseId: 'UTM:TST100H5' }] })
    expect(status(rule, [])).toBe('unknown')
  })
})

describe('credits', () => {
  const credits = (minimum: number, scope: Partial<Extract<Rule, { kind: 'credits' }>> = {}): Rule => ({ kind: 'credits', minimum, ...scope })
  const earned = (rule: Rule, rows: Row[], counting: Counting = 'current', pairs: [string, string][] = []) =>
    evaluateRule(rule, createEvalContext(index(pairs), record(...rows)), counting).earned

  it('counts each passed course once and reports the credits earned', () => {
    const rows: Row[] = [['TST100H5', 'completed'], ['TST102Y5', 'completed']]
    expect(status(credits(1.5), rows)).toBe('met')
    expect(status(credits(2), rows)).toBe('unmet')
    expect(earned(credits(2), rows)).toBe(1.5)
    const listed = { courseIds: [id('TST100H5'), id('TST100H5'), id('TST101H5')] }
    expect(status(credits(1, listed), [['TST100H5', 'completed'], ['TST101H5', 'completed']])).toBe('met')
    expect(status(credits(1, listed), [['TST100H5', 'completed'], ['TST102Y5', 'completed']])).toBe('unmet')
  })

  it('honours subject and minimum-level scopes', () => {
    const rows: Row[] = [['TST100H5', 'completed'], ['TST200H5', 'completed'], ['OTH300Y5', 'completed']]
    expect(earned(credits(1, { subject: 'TST' }), rows)).toBe(1)
    expect(earned(credits(1, { level: 200 }), rows)).toBe(1.5)
    expect(earned(credits(1, { subject: 'TST', level: 200 }), rows)).toBe(0.5)
    expect(status(credits(1, { subject: 'TST', level: 200 }), rows)).toBe('unmet')
  })

  it('counts in-progress credits for prerequisites, planned only for plans, failed never', () => {
    const rows: Row[] = [['TST100H5', 'completed'], ['TST101H5', 'inProgress'], ['TST200H5', 'planned'], ['TST201H5', 'completed', 30]]
    expect(earned(credits(1), rows, 'completed')).toBe(0.5)
    expect(earned(credits(1), rows, 'current')).toBe(1)
    expect(earned(credits(1), rows, 'planned')).toBe(1.5)
    expect(status(credits(1), rows, 'current')).toBe('met')
    expect(status(credits(1), rows, 'completed')).toBe('unmet')
  })

  it('never adds up two courses that exclude each other', () => {
    const rows: Row[] = [['TST100H5', 'completed'], ['TST101H5', 'completed'], ['TST200H5', 'completed']]
    const pairs: [string, string][] = [['TST100H5', 'TST101H5']]
    expect(earned(credits(1.5), rows, 'current', pairs)).toBe(1)
    expect(status(credits(1), rows, 'current', pairs)).toBe('met')
    expect(status(credits(1.5), rows, 'current', pairs)).toBe('unknown')
    expect(status(credits(0.5, { courseIds: [id('TST100H5'), id('TST101H5')] }), rows, 'current', pairs)).toBe('met')
  })

  it('reads credit values of courses outside the dataset from their code', () => {
    expect(status(credits(1, { courseIds: [id('UTSG:ABC100Y1')] }), [['UTSG:ABC100Y1', 'completed']])).toBe('met')
    expect(status(credits(1), [['UTSG:ABC100H1', 'completed'], ['TST100H5', 'completed']])).toBe('met')
    // A subject or level scope cannot be checked for another campus's course.
    expect(status(credits(1, { subject: 'TST' }), [['UTSG:TST100H1', 'completed'], ['TST100H5', 'completed']])).toBe('unknown')
    expect(status(credits(1, { subject: 'TST' }), [['UTSG:ABC100H1', 'completed']])).toBe('unmet')
    expect(status(credits(1), [['UTSG:BAD', 'completed']])).toBe('unknown')
  })
})

describe('courses that satisfy a met requirement', () => {
  it('uses the first met option of an OR, every child of an AND and the counted credits', () => {
    const ctx = createEvalContext(index(), record(['TST100H5', 'completed'], ['TST101H5', 'completed'], ['TST200H5', 'completed']))
    expect(usedCourses(evaluateRule(any(course('TST300H5'), course('TST101H5'), course('TST100H5')), ctx, 'completed'), ctx)).toEqual([id('TST101H5')])
    expect(usedCourses(evaluateRule(all(course('TST100H5'), course('TST200H5')), ctx, 'completed'), ctx)).toEqual([id('TST100H5'), id('TST200H5')])
    expect(usedCourses(evaluateRule({ kind: 'credits', minimum: 0.5, subject: 'TST', level: 200 }, ctx, 'completed'), ctx)).toEqual([id('TST200H5')])
    expect(usedCourses(evaluateRule(course('TST300H5'), ctx, 'completed'), ctx)).toEqual([])
  })
})

describe('rule helpers', () => {
  it('lists structured references once, in first-occurrence order', () => {
    const rule = all(course('TST200H5'), any(course('TST100H5'), minGrade('TST200H5', 60)),
      { kind: 'credits', minimum: 1, courseIds: [id('TST101H5')] },
      { kind: 'applicability', cohort: 'x', rule: course('UTSG:TST100H1') }, unknown('TST300H5 or equivalent'))
    expect(ruleCourseIds(rule)).toEqual([id('TST200H5'), id('TST100H5'), id('TST101H5'), 'UTSG:TST100H1'])
  })

  it('flags rules with leaves a record cannot decide', () => {
    expect(containsOpaque(all(course('TST100H5'), unknown()))).toBe(true)
    expect(containsOpaque(any(course('TST100H5'), { kind: 'permission', text: 'p' }))).toBe(true)
    expect(containsOpaque({ kind: 'applicability', cohort: 'x', rule: course('TST100H5') })).toBe(false)
    expect(containsOpaque({ kind: 'credits', minimum: 1 })).toBe(false)
  })
})

describe('records built from repeated rows', () => {
  it('keeps the strongest row whatever the order (duplicate records)', () => {
    const rows = [
      { courseId: id('TST100H5'), status: 'completed' as const, grade: 30 },
      { courseId: id('TST100H5'), status: 'completed' as const, grade: 80 },
      { courseId: id('TST101H5'), status: 'planned' as const },
      { courseId: id('TST101H5'), status: 'inProgress' as const },
      { courseId: id('TST200H5'), status: 'completed' as const, grade: 20 },
      { courseId: id('TST200H5'), status: 'inProgress' as const },
      { courseId: id('TST201H5'), status: 'completed' as const },
      { courseId: id('TST201H5'), status: 'completed' as const, grade: 65 },
    ]
    for (const ordered of [rows, [...rows].reverse()]) {
      const merged = recordFromRows(ordered)
      expect(merged.size).toBe(4)
      expect(merged.get(id('TST100H5'))).toEqual({ status: 'completed', grade: 80 })
      expect(merged.get(id('TST101H5'))).toEqual({ status: 'inProgress' })
      expect(merged.get(id('TST200H5'))).toEqual({ status: 'inProgress' })
      expect(merged.get(id('TST201H5'))).toEqual({ status: 'completed', grade: 65 })
      const ctx = createEvalContext(index(), merged)
      expect(evaluateRule(minGrade('TST100H5', 70), ctx, 'current').status).toBe('met')
    }
  })
})

// CJK punctuation, ideographs and full-width forms.
const CJK = new RegExp(`[${[[0x3000, 0x303f], [0x3400, 0x9fff], [0xff00, 0xffef]].map(([a, b]) => `${String.fromCodePoint(a)}-${String.fromCodePoint(b)}`).join('')}]`, 'u')

describe('domain module hygiene', () => {
  it('contains no hard-coded Chinese text (the UI owns every string)', () => {
    const dir = join('src', 'domain')
    for (const file of readdirSync(dir)) {
      expect(readFileSync(join(dir, file), 'utf8').match(CJK), file).toBeNull()
    }
  })
})
