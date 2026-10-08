// Canvas text: font strings from the computed --font-ui, label measurement and truncation
// (design-spec 4, 8.6) and the focus plate's wrapped title (7.5). createLabelMeasure returns the
// contract LabelMeasure that geometry uses, plus labelText() so drawing uses exactly the strings
// that were measured. Widths are cached per font string and cleared when fonts finish loading or
// the UI language changes; subscribers (the app) then recompute geometry.
import { useSyncExternalStore } from 'react'
import { appStore } from '../app/store'
import type { GraphDataset } from '../data/schema'
import { format } from '../i18n'
import { DEFAULT_GEOMETRY_OPTIONS } from './geometry'
import { GRAPH_STRINGS } from './strings'
import type { DisplayClass, LabelMeasure, Topology } from './types'

export const FALLBACK_FONT_FAMILY = '"Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif'
export const ELLIPSIS = '…'

export interface FontSpec {
  size: number
  weight: number
}

/** Canvas type roles (4.2), world px. */
export const TEXT = {
  code: { size: 13, weight: 600 },
  title: { size: 12.5, weight: 400 },
  plateCode: { size: 14, weight: 700 },
  plateCredit: { size: 11.5, weight: 500 },
  plateTitle: { size: 12.5, weight: 500 },
  overflow: { size: 11, weight: 400 },
} as const satisfies Record<string, FontSpec>

export interface PlateMetrics {
  code: FontSpec
  credit: FontSpec
  title: FontSpec
  /** Wrap width of the title. */
  wrap: number
  maxLines: number
  /** Height of the code line and of each title line. */
  codeLine: number
  lineHeight: number
  padX: number
  padY: number
  creditGap: number
}

/** Focus plate in world px (7.5): code 14 / 700, title 12.5 / 500 on 16 px lines, wrapped at 260. */
export const WORLD_PLATE: PlateMetrics = {
  code: TEXT.plateCode,
  credit: TEXT.plateCredit,
  title: TEXT.plateTitle,
  wrap: 260,
  maxLines: 3,
  codeLine: 16,
  lineHeight: 16,
  padX: 8,
  padY: 6,
  creditGap: 8,
}

/** Below zoom 0.86 the plate is drawn in screen px at code 12 / title 11.5 (8.12); no text under 11.5. */
export const SCREEN_PLATE: PlateMetrics = {
  code: { size: 12, weight: 700 },
  credit: { size: 11.5, weight: 500 },
  title: { size: 11.5, weight: 500 },
  wrap: 240,
  maxLines: 3,
  codeLine: 15,
  lineHeight: 15,
  padX: 7,
  padY: 5,
  creditGap: 7,
}

/** Extra width of a focus label over its text (labelX 20 vs plate text at 18 + 8). */
const FOCUS_EXTRA = 6

export type MeasureText = (text: string, font: string) => number

export function fontString(spec: FontSpec, family: string, scale = 1): string {
  return `${spec.weight} ${spec.size * scale}px ${family}`
}

const TRAILING = /[\s,:;\-–—(/&]+$/u

/**
 * 8.6 truncation: keep the title when it fits; otherwise the longest prefix p with
 * width(p.trimEnd() + '…') ≤ max, minus trailing whitespace and , : ; - – — ( / &, plus '…'.
 */
export function truncateTitle(title: string, max: number, width: (text: string) => number): string {
  if (width(title) <= max) return title
  let lo = 0
  let hi = title.length
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (width(title.slice(0, mid).trimEnd() + ELLIPSIS) <= max) lo = mid
    else hi = mid - 1
  }
  return title.slice(0, lo).replace(TRAILING, '') + ELLIPSIS
}

function longestPrefix(text: string, max: number, width: (text: string) => number): number {
  let lo = 1
  let hi = text.length
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (width(text.slice(0, mid)) <= max) lo = mid
    else hi = mid - 1
  }
  return lo
}

/**
 * Greedy word wrap into at most `maxLines` lines of `max` px. The last line takes the rest and is
 * truncated with "…" when it is still too long; a single overlong word is broken by characters.
 */
export function wrapTitle(title: string, max: number, maxLines: number, width: (text: string) => number): string[] {
  const words = title.trim().split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let i = 0
  while (i < words.length && lines.length < maxLines) {
    if (lines.length === maxLines - 1) {
      lines.push(truncateTitle(words.slice(i).join(' '), max, width))
      break
    }
    let line = words[i]
    if (width(line) > max) {
      const cut = longestPrefix(line, max, width)
      lines.push(line.slice(0, cut))
      words[i] = line.slice(cut)
      continue
    }
    i++
    while (i < words.length && width(`${line} ${words[i]}`) <= max) line += ` ${words[i++]}`
    lines.push(line)
  }
  return lines
}

export function formatCredits(credits: number): string {
  return Number.isInteger(credits * 10) ? credits.toFixed(1) : String(credits)
}

// ---------------------------------------------------------------------------
// Shared metrics state: one width cache per text-measuring function (the canvas one is shared by
// every measurer; an injected measureText never sees another's widths), all invalidated by font
// loads and language changes.

let version = 0
let family: string | null = null
let widthCaches = new WeakMap<MeasureText, Map<string, number>>()
const listeners = new Set<() => void>()
let watching = false
let probe = ''
let context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null

const hasDom = () => typeof document !== 'undefined' && typeof window !== 'undefined'

/** The computed --font-ui of <html>, which also carries the zh stack under :root[lang="zh-CN"]. */
export function uiFontFamily(): string {
  if (family !== null) return family
  family = hasDom() ? getComputedStyle(document.documentElement).getPropertyValue('--font-ui').trim() || FALLBACK_FONT_FAMILY : FALLBACK_FONT_FAMILY
  return family
}

function domMeasure(text: string, font: string): number {
  if (!context) {
    if (typeof OffscreenCanvas !== 'undefined') context = new OffscreenCanvas(1, 1).getContext('2d')
    if (!context && hasDom()) context = document.createElement('canvas').getContext('2d')
  }
  if (!context) return approxMeasure(text, font)
  if (context.font !== font) context.font = font
  return context.measureText(text).width
}

/** Width estimate for environments without a canvas (tests, SSR). */
function approxMeasure(text: string, font: string): number {
  const size = Number(/([\d.]+)px/.exec(font)?.[1] ?? 13)
  return text.length * size * 0.55
}

function cachedWidth(text: string, font: string, measure: MeasureText): number {
  let widths = widthCaches.get(measure)
  if (!widths) widthCaches.set(measure, (widths = new Map()))
  const key = `${font}\u0000${text}`
  let w = widths.get(key)
  if (w === undefined) {
    w = measure(text, font)
    widths.set(key, w)
  }
  return w
}

export function textMetricsVersion(): number {
  return version
}

/** Clears every cached width and tells subscribers to re-measure (and re-run geometry). */
export function invalidateTextMetrics(): void {
  version++
  family = null
  widthCaches = new WeakMap()
  listeners.forEach(listener => listener())
}

function probeSignature(): string {
  const fam = hasDom() ? getComputedStyle(document.documentElement).getPropertyValue('--font-ui').trim() || FALLBACK_FONT_FAMILY : FALLBACK_FONT_FAMILY
  const font = fontString(TEXT.code, fam)
  return `${fam}|${domMeasure('CSC148H5 Introduction to Computer Science', font).toFixed(3)}`
}

/** Invalidates only when the font stack or the rendered metrics really changed. */
function recheck(): void {
  const next = probeSignature()
  if (next === probe) return
  probe = next
  invalidateTextMetrics()
}

function startWatching(): void {
  if (watching || !hasDom()) return
  watching = true
  probe = probeSignature()
  const fonts = document.fonts as FontFaceSet | undefined
  fonts?.ready.then(recheck).catch(() => undefined)
  fonts?.addEventListener('loadingdone', recheck)
  let lang = appStore.get().lang
  appStore.subscribe(() => {
    const next = appStore.get().lang
    if (next === lang) return
    lang = next
    // The credit label is localised, so a language change always re-measures.
    probe = probeSignature()
    invalidateTextMetrics()
  })
  // <html lang> may flip after the store (zh fonts join --font-ui through :root[lang="zh-CN"]).
  new MutationObserver(recheck).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] })
}

export function subscribeTextMetrics(listener: () => void): () => void {
  startWatching()
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Re-render when label metrics change: `useMemo(() => createLabelMeasure(...), [..., version])`. */
export function useTextMetricsVersion(): number {
  return useSyncExternalStore(subscribeTextMetrics, textMetricsVersion, textMetricsVersion)
}

// ---------------------------------------------------------------------------
// Label measurer

export interface LabelText {
  code: string
  codeWidth: number
  /** Truncated title of a full label; null for compact labels and the focus. */
  title: string | null
  titleWidth: number
  /** Focus plate: credit label and wrapped title lines (world metrics). */
  credit: string | null
  creditWidth: number
  lines: string[]
  lineWidths: number[]
  /** Exactly what the LabelMeasure returned for the same arguments. */
  width: number
}

export interface PlateLayout {
  metrics: PlateMetrics
  code: string
  codeWidth: number
  credit: string
  creditWidth: number
  lines: string[]
  /** Text block width and the plate's outer size (padding included). */
  textWidth: number
  width: number
  height: number
}

export interface LabelMeasurer extends LabelMeasure {
  labelText(index: number, cls: Exclude<DisplayClass, 'hidden' | 'mini'>, isFocus: boolean): LabelText
  /** Focus plate layout in world (`'world'`) or fixed screen (`'screen'`) metrics. */
  plate(index: number, mode: 'world' | 'screen'): PlateLayout
  /** Font string of a role at a scale (drawing). */
  font(spec: FontSpec, scale?: number): string
  /** Shared metrics version this measurer was created at. */
  readonly version: number
}

export interface LabelMeasureOptions {
  /** Injected text measurement (tests); defaults to a canvas 2D context. */
  measureText?: MeasureText
  /** Font family; defaults to the computed --font-ui. */
  family?: string
  fullLabelMax?: number
  /** Credit label template ('{n} cr'); defaults to the current UI language. */
  creditLabel?: string
}

export function isLabelMeasurer(measure: LabelMeasure): measure is LabelMeasurer {
  return typeof (measure as Partial<LabelMeasurer>).labelText === 'function'
}

/** Pre-graph-core fallback; DEFAULT_GEOMETRY_OPTIONS.fullLabelMax is the source of truth. */
const DEFAULT_FULL_LABEL_MAX = 184

export function createLabelMeasure(topology: Topology, dataset: GraphDataset, options: LabelMeasureOptions = {}): LabelMeasurer {
  if (!options.measureText) startWatching()
  const measureText = options.measureText ?? domMeasure
  const fam = options.family ?? uiFontFamily()
  const fullMax = options.fullLabelMax ?? (DEFAULT_GEOMETRY_OPTIONS.fullLabelMax || DEFAULT_FULL_LABEL_MAX)
  const creditLabel = options.creditLabel ?? GRAPH_STRINGS[appStore.get().lang].plateCredit
  const courseById = new Map(dataset.courses.map(course => [course.id, course]))
  const fonts = new Map<string, string>()
  const font = (spec: FontSpec, scale = 1) => {
    const key = `${spec.weight}/${spec.size}/${scale}`
    let value = fonts.get(key)
    if (!value) {
      value = fontString(spec, fam, scale)
      fonts.set(key, value)
    }
    return value
  }
  const width = (text: string, spec: FontSpec) => cachedWidth(text, font(spec), measureText)

  const titles = new Map<number, string>()
  const truncated = (index: number) => {
    let title = titles.get(index)
    if (title === undefined) {
      title = truncateTitle(topology.nodes[index].title, fullMax, text => width(text, TEXT.title))
      titles.set(index, title)
    }
    return title
  }

  const plates = new Map<string, PlateLayout>()
  const plate = (index: number, mode: 'world' | 'screen'): PlateLayout => {
    const key = `${mode}:${index}`
    const cached = plates.get(key)
    if (cached) return cached
    const metrics = mode === 'world' ? WORLD_PLATE : SCREEN_PLATE
    const node = topology.nodes[index]
    const credits = courseById.get(node.id)?.credits
    const credit = credits === undefined ? '' : format(creditLabel, { n: formatCredits(credits) })
    const codeWidth = width(node.code, metrics.code)
    const creditWidth = credit ? width(credit, metrics.credit) : 0
    const lines = wrapTitle(node.title, metrics.wrap, metrics.maxLines, text => width(text, metrics.title))
    const textWidth = Math.max(codeWidth + (credit ? metrics.creditGap + creditWidth : 0), ...lines.map(line => width(line, metrics.title)))
    const layout: PlateLayout = {
      metrics,
      code: node.code,
      codeWidth,
      credit,
      creditWidth,
      lines,
      textWidth,
      width: textWidth + 2 * metrics.padX,
      height: 2 * metrics.padY + metrics.codeLine + lines.length * metrics.lineHeight,
    }
    plates.set(key, layout)
    return layout
  }

  const labelText = (index: number, cls: Exclude<DisplayClass, 'hidden' | 'mini'>, isFocus: boolean): LabelText => {
    const node = topology.nodes[index]
    if (isFocus) {
      const p = plate(index, 'world')
      return {
        code: p.code,
        codeWidth: p.codeWidth,
        title: null,
        titleWidth: 0,
        credit: p.credit || null,
        creditWidth: p.creditWidth,
        lines: p.lines,
        lineWidths: p.lines.map(line => width(line, WORLD_PLATE.title)),
        width: p.textWidth + FOCUS_EXTRA,
      }
    }
    const codeWidth = width(node.code, TEXT.code)
    const title = cls === 'full' ? truncated(index) : null
    const titleWidth = title === null ? 0 : width(title, TEXT.title)
    return { code: node.code, codeWidth, title, titleWidth, credit: null, creditWidth: 0, lines: [], lineWidths: [], width: Math.max(codeWidth, titleWidth) }
  }

  const measure = (index: number, cls: Exclude<DisplayClass, 'hidden' | 'mini'>, isFocus: boolean) => labelText(index, cls, isFocus).width
  return Object.assign(measure, { labelText, plate, font, version })
}
