// Pure formatting helpers shared by the panels (no React, no DOM).
import type { GraphCourse, GraphDataset } from '../../data/schema'
import type { Lang } from '../../app/store'
import { format, formatNumber } from '../../i18n'
import type { PanelStrings } from './strings'

/** `UTM:CSC148H5` → `CSC148H5` (ids without a campus are returned as-is). */
export function codeOf(id: string): string {
  const colon = id.indexOf(':')
  return colon < 0 ? id : id.slice(colon + 1)
}

/** `UTSG:CSC148H1` → `UTSG`; '' when the id carries no campus. */
export function campusOf(id: string): string {
  const colon = id.indexOf(':')
  return colon < 0 ? '' : id.slice(0, colon)
}

export function coursePageUrl(template: string, code: string): string {
  return template.replace('{slug}', encodeURIComponent(code.toLowerCase()))
}

/** Credit weight from the code when the course is not in the dataset: H = 0.5, Y = 1.0. */
export function creditsFromCode(code: string): number {
  const match = /([HY])\d$/.exec(code)
  if (!match) return 0
  return match[1] === 'Y' ? 1 : 0.5
}

/** Credits always show one decimal, as the calendar prints them ("0.5", "1.0", "12.5"). */
export function formatCredits(value: number, lang: Lang): string {
  return new Intl.NumberFormat(lang === 'zh' ? 'zh-CN' : 'en-CA', { minimumFractionDigits: 1, maximumFractionDigits: 2 }).format(value)
}

/** "0 credits", "0.5 credit", "1.0 credit", "2.5 credits" (UofT wording: a fraction up to one credit is singular). */
export function creditsText(value: number, lang: Lang, s: PanelStrings): string {
  if (value === 0) return format(s.creditMany, { n: formatNumber(0, lang) })
  return format(value <= 1 ? s.creditOne : s.creditMany, { n: formatCredits(value, lang) })
}

/** Singular template for exactly one, plural otherwise (0 courses, 1 course, 2 courses). */
export function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many
}

/** "1 course", "0 courses", "12 courses". */
export function coursesText(n: number, lang: Lang, s: PanelStrings): string {
  return format(plural(n, s.courseCountOne, s.courseCountMany), { n: formatNumber(n, lang) })
}

/** 0 → "000", 100 → "100". */
export function levelText(level: number): string {
  return String(level).padStart(3, '0')
}

/** "2026-2027" → "2026–2027". */
export function academicYearText(year: string): string {
  return year.replace(/^(\d{4})-(\d{4})$/, '$1–$2')
}

/** The program's POSt code, or null when the calendar gives none and `code` is only the page slug. */
export function programCode(program: { code: string; codeSource?: 'url-slug' }): string | null {
  return program.codeSource === 'url-slug' ? null : program.code
}

/** Program titles end in " - ERMAJ1688"; the panels show the code separately. */
export function programDisplayTitle(title: string, code: string): string {
  const suffix = ` - ${code}`
  return title.endsWith(suffix) ? title.slice(0, -suffix.length) : title
}

/** Grade input: '' → null (no grade), 0-100 → number, anything else → 'invalid'. */
export function parseGrade(text: string): number | null | 'invalid' {
  const trimmed = text.trim()
  if (!trimmed) return null
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(trimmed)) return 'invalid'
  const value = Number(trimmed)
  return value >= 0 && value <= 100 ? value : 'invalid'
}

const courseIndexes = new WeakMap<GraphDataset, ReadonlyMap<string, GraphCourse>>()

/** Course lookup by id, built once per dataset. */
export function courseIndex(dataset: GraphDataset): ReadonlyMap<string, GraphCourse> {
  let index = courseIndexes.get(dataset)
  if (!index) {
    index = new Map(dataset.courses.map(course => [course.id, course]))
    courseIndexes.set(dataset, index)
  }
  return index
}

export type TemplatePart = { text: string } | { key: string; value: string }

/** Splits "Needs {d} directly" into text and value parts so numbers can be styled. */
export function splitTemplate(template: string, values: Record<string, string | number>): TemplatePart[] {
  const parts: TemplatePart[] = []
  let last = 0
  for (const match of template.matchAll(/\{(\w+)\}/g)) {
    const key = match[1]
    if (!(key in values)) continue
    if (match.index > last) parts.push({ text: template.slice(last, match.index) })
    parts.push({ key, value: String(values[key]) })
    last = match.index + match[0].length
  }
  if (last < template.length) parts.push({ text: template.slice(last) })
  return parts
}

/** Most recent first, without duplicates, at most `max` entries. */
export function pushRecent(list: readonly string[], id: string, max = 6): string[] {
  return [id, ...list.filter(item => item !== id)].slice(0, max)
}

/** First `limit` items unless expanded; `rest` is how many are hidden. */
export function capList<T>(items: readonly T[], limit: number, expanded: boolean): { shown: readonly T[]; rest: number } {
  if (expanded || items.length <= limit) return { shown: items, rest: 0 }
  return { shown: items.slice(0, limit), rest: items.length - limit }
}

/** "A, B +3 more" style list of codes for one-line reasons ("A、B 及另外 3 门" in Chinese). */
export function codeList(ids: readonly string[], max: number, s: PanelStrings): string {
  const codes = ids.slice(0, max).map(codeOf).join(s.listSep)
  return ids.length > max ? format(s.codesMore, { codes, n: ids.length - max }) : codes
}
