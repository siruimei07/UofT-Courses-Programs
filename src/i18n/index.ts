// Feature-local string tables: each UI module keeps its own `{ en, zh }` object with identical
// keys, so features can be built independently. English is the default language; official
// course codes, titles and requirement text are never translated.
import { useApp, type Lang } from '../app/store'

export type Strings<T> = Record<Lang, T>

/** Declares a string table; the zh table must provide every key of the en table. */
export function defineStrings<T extends Record<string, string>>(strings: { en: T; zh: { [K in keyof T]: string } }): Strings<T> {
  return strings as Strings<T>
}

export function useStrings<T>(strings: Strings<T>): T {
  const lang = useApp(state => state.lang)
  return strings[lang]
}

export function useLang(): Lang {
  return useApp(state => state.lang)
}

/** `format('{n} courses', { n: 3 })` → `3 courses`. Unknown placeholders are left as-is. */
export function format(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (key in values ? String(values[key]) : match))
}

export function formatNumber(value: number, lang: Lang): string {
  return new Intl.NumberFormat(lang === 'zh' ? 'zh-CN' : 'en-CA').format(value)
}
