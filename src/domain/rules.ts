// Pure helpers over the Rule AST (src/domain/types.ts). Shared by the engine, the data build and
// the catalog validator.
import type { Rule } from './types'

function collect(rule: Rule, ids: Set<string>): void {
  switch (rule.kind) {
    case 'course': case 'minGrade': ids.add(rule.courseId); break
    case 'credits': rule.courseIds?.forEach(id => ids.add(id)); break
    case 'all': case 'any': rule.items.forEach(item => collect(item, ids)); break
    case 'applicability': collect(rule.rule, ids); break
    default: break
  }
}

/** Course ids referenced by the structured parts of a rule, unique, in first-occurrence order. */
export function ruleCourseIds(rule: Rule): string[] {
  const ids = new Set<string>()
  collect(rule, ids)
  return [...ids]
}

/**
 * True when the rule contains a leaf a student record cannot decide: unparsed text, a permission
 * or a program admission. A cohort (`applicability`) wrapper alone does not make a rule opaque.
 */
export function containsOpaque(rule: Rule): boolean {
  switch (rule.kind) {
    case 'unknown': case 'permission': case 'program': return true
    case 'all': case 'any': return rule.items.some(containsOpaque)
    case 'applicability': return containsOpaque(rule.rule)
    default: return false
  }
}
