import { describe, expect, it } from 'vitest'
import { buildTopology } from '../src/graph'
import {
  ELLIPSIS, TEXT, WORLD_PLATE, createLabelMeasure, fontString, formatCredits, invalidateTextMetrics, isLabelMeasurer,
  subscribeTextMetrics, textMetricsVersion, truncateTitle, wrapTitle,
} from '../src/graph/text'
import { loadGraphDataset } from './helpers/dataset'

/** Deterministic stand-in for canvas measureText: 0.55 em per character, bold codes a bit wider. */
const fakeMeasure = (text: string, font: string) => {
  const size = Number(/([\d.]+)px/.exec(font)?.[1] ?? 13)
  const weight = Number(/^(\d+)/.exec(font)?.[1] ?? 400)
  return text.length * size * (weight >= 600 ? 0.6 : 0.55)
}
const width = (text: string) => fakeMeasure(text, '400 12.5px x')

const { dataset } = loadGraphDataset()
const topology = buildTopology(dataset)
const measure = createLabelMeasure(topology, dataset, { measureText: fakeMeasure, fullLabelMax: 184, creditLabel: '{n} cr' })
const idx = (code: string) => topology.indexById.get(`UTM:${code}`)!

describe('fonts', () => {
  it('builds canvas font strings from the computed family', () => {
    expect(fontString(TEXT.code, '"Segoe UI", sans-serif')).toBe('600 13px "Segoe UI", sans-serif')
    expect(fontString(TEXT.title, 'X', 0.92)).toBe(`400 ${12.5 * 0.92}px X`)
    expect(measure.font(TEXT.plateCode)).toContain('700 14px')
  })

  it('formats credits with one decimal', () => {
    expect(formatCredits(0.5)).toBe('0.5')
    expect(formatCredits(1)).toBe('1.0')
    expect(formatCredits(0.25)).toBe('0.25')
  })
})

describe('truncateTitle (design-spec 8.6)', () => {
  it('keeps titles that fit', () => {
    expect(truncateTitle('Software Design', 184, width)).toBe('Software Design')
  })

  it('cuts to the longest prefix that fits with an ellipsis', () => {
    const title = 'Traces of the Past: Uncovering Historical and Archeological Clues through Non-Destructive Chemical Techniques'
    const out = truncateTitle(title, 184, width)
    expect(out.endsWith(ELLIPSIS)).toBe(true)
    expect(width(out)).toBeLessThanOrEqual(184)
    expect(title.startsWith(out.slice(0, -1))).toBe(true)
    // One more character would not fit.
    const next = title.slice(0, out.length).trimEnd() + ELLIPSIS
    expect(width(next) > 184 || out.length - 1 >= title.length).toBe(true)
  })

  it('strips trailing whitespace and , : ; - – — ( / & before the ellipsis', () => {
    for (const sep of [',', ':', ';', '-', '–', '—', '(', '/', '&']) {
      const title = `Alpha Beta${sep} Gamma Delta Epsilon Zeta`
      // The budget stops right after the separator and its space.
      const max = width(`Alpha Beta${sep} ${ELLIPSIS}`) + 0.1
      const out = truncateTitle(title, max, width)
      expect(out).toBe(`Alpha Beta${ELLIPSIS}`)
    }
  })

  it('never truncates below an ellipsis', () => {
    expect(truncateTitle('Abcdefgh', 1, width)).toBe(ELLIPSIS)
  })
})

describe('wrapTitle (focus plate, 7.5)', () => {
  it('wraps at the width into at most three lines', () => {
    const title = 'Introduction to Computer Science'
    expect(wrapTitle(title, 260, 3, width)).toEqual([title])
    const lines = wrapTitle('Traces of the Past: Uncovering Historical and Archeological Clues through Non-Destructive Chemical Techniques', 260, 3, width)
    expect(lines.length).toBe(3)
    for (const line of lines) expect(width(line)).toBeLessThanOrEqual(260)
    expect(lines[2].endsWith(ELLIPSIS)).toBe(true)
  })

  it('keeps every word when it fits in three lines', () => {
    const title = 'Calculus of Several Variables I'
    const lines = wrapTitle(title, 120, 3, width)
    expect(lines.join(' ')).toBe(title)
  })

  it('breaks a single overlong word by characters', () => {
    const lines = wrapTitle('Supercalifragilisticexpialidocious', 60, 3, width)
    expect(lines.length).toBeGreaterThan(1)
    for (const line of lines) expect(width(line)).toBeLessThanOrEqual(60)
  })
})

describe('createLabelMeasure (contract LabelMeasure)', () => {
  it('is a LabelMeasurer whose labelText matches the measured widths', () => {
    expect(isLabelMeasurer(measure)).toBe(true)
    for (const code of ['CSC148H5', 'FSC310H5', 'MAT232H5']) {
      const i = idx(code)
      for (const cls of ['compact', 'full'] as const) {
        expect(measure.labelText(i, cls, false).width).toBe(measure(i, cls, false))
      }
      expect(measure.labelText(i, 'full', true).width).toBe(measure(i, 'full', true))
    }
  })

  it('compact = code width; full = max(code, truncated title) capped at fullLabelMax', () => {
    const i = idx('FSC310H5')
    expect(measure(i, 'compact', false)).toBe(fakeMeasure('FSC310H5', '600 13px x'))
    const full = measure.labelText(i, 'full', false)
    expect(full.title?.endsWith(ELLIPSIS)).toBe(true)
    expect(full.width).toBeLessThanOrEqual(184)
    expect(full.width).toBe(Math.max(full.codeWidth, full.titleWidth))
    const short = measure.labelText(idx('CSC207H5'), 'full', false)
    expect(short.title).toBe('Software Design')
    expect(short.width).toBe(Math.max(short.codeWidth, width('Software Design')))
  })

  it('focus = max(code + credit, wrapped title) + 6 with a never-truncated plate', () => {
    const i = idx('CSC148H5')
    const label = measure.labelText(i, 'full', true)
    expect(label.credit).toBe('0.5 cr')
    const codeLine = label.codeWidth + WORLD_PLATE.creditGap + label.creditWidth
    expect(label.width).toBeCloseTo(Math.max(codeLine, ...label.lineWidths) + 6, 9)
    const plate = measure.plate(i, 'world')
    expect(plate.lines.join(' ')).toBe('Introduction to Computer Science')
    expect(plate.height).toBe(2 * WORLD_PLATE.padY + WORLD_PLATE.codeLine + plate.lines.length * WORLD_PLATE.lineHeight)
    expect(plate.width).toBeCloseTo(plate.textWidth + 2 * WORLD_PLATE.padX, 9)
    // The longest UTM title wraps to the 3-line maximum (focus row 76 px).
    const long = measure.plate(idx('FSC310H5'), 'world')
    expect(long.lines.length).toBe(3)
    expect(long.height).toBe(2 * 6 + 16 + 3 * 16)
    expect(measure.plate(i, 'screen').metrics.title.size).toBe(11.5)
  })

  it('every course measures to a finite, positive width in each class', () => {
    for (const node of topology.nodes) {
      for (const cls of ['compact', 'full'] as const) {
        const w = measure(node.index, cls, false)
        expect(Number.isFinite(w) && w > 0).toBe(true)
      }
    }
  })
})

describe('metrics invalidation', () => {
  it('bumps the version and notifies subscribers', () => {
    const before = textMetricsVersion()
    let calls = 0
    const off = subscribeTextMetrics(() => calls++)
    invalidateTextMetrics()
    expect(textMetricsVersion()).toBe(before + 1)
    expect(calls).toBe(1)
    off()
    invalidateTextMetrics()
    expect(calls).toBe(1)
  })
})
