// Fills a `{placeholder}` template with numbers set as tabular, emphasised spans (readouts and
// counts, design-spec 4.2 / 6.3).
import type { ReactNode } from 'react'
import type { Lang } from '../app/store'
import { formatNumber } from '../i18n'

export function richNumbers(template: string, values: Record<string, number>, lang: Lang, className = 'num'): ReactNode[] {
  return template.split(/(\{\w+\})/).map((part, index) => {
    const key = /^\{(\w+)\}$/.exec(part)?.[1]
    if (key === undefined || !(key in values)) return part
    return <b key={index} className={className}>{formatNumber(values[key], lang)}</b>
  })
}
