// Display formatting for calendar metadata. Pure; dates are shown in Toronto time so the fetch
// date never shifts with the viewer's time zone.
import type { Lang } from './store'

/** "2026-2027" → "2026–2027"; short form "2026–27" (compact header). */
export function academicYearLabel(year: string, short = false): string {
  const match = /^(\d{4})\D+(\d{4})$/.exec(year.trim())
  if (!match) return year
  return short ? `${match[1]}–${match[2].slice(2)}` : `${match[1]}–${match[2]}`
}

/** "2026-10-08T04:33:00+00:00" → "Oct 8, 2026" (en) or "2026年10月8日" (zh). */
export function formatFetchDate(iso: string, lang: Lang): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return new Intl.DateTimeFormat(lang === 'zh' ? 'zh-CN' : 'en-US', {
    year: 'numeric', month: 'short', day: 'numeric', timeZone: 'America/Toronto',
  }).format(date)
}
