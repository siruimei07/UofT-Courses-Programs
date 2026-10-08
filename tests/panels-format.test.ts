import { describe, expect, it } from 'vitest'
import {
  academicYearText, campusOf, capList, codeList, codeOf, coursePageUrl, creditsFromCode, creditsText, formatCredits,
  levelText, parseGrade, programDisplayTitle, pushRecent, splitTemplate,
} from '../src/ui/panels/format'
import { panelStrings } from '../src/ui/panels/strings'

const en = panelStrings.en
const zh = panelStrings.zh

describe('panel strings', () => {
  it('has the same keys in English and Chinese, none empty', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
    for (const value of [...Object.values(en), ...Object.values(zh)]) expect(value.trim()).not.toBe('')
  })

  it('uses the same placeholders in both languages', () => {
    const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort()
    for (const key of Object.keys(en) as (keyof typeof en)[]) expect(placeholders(zh[key]), key).toEqual(placeholders(en[key]))
  })

  it('keeps the spec copy for the readouts and the unparsed note', () => {
    expect(en.readoutNeeds).toBe('Needs {d} directly · {t} in total')
    expect(en.readoutNeedsOneOf).toBe('Needs 1 of {n} directly · {t} related in total')
    expect(en.readoutUnlocks).toBe('Unlocks {d} directly · {t} in total')
    expect(en.unparsed).toBe('We could not read the structure of this requirement. Read the official text above.')
    expect(zh.unparsed).toBe('未能解析此要求的结构，请阅读上方官方原文。')
    expect([zh.notTaken, zh.planned, zh.inProgress, zh.completed, zh.availableNow]).toEqual(['未修', '计划', '在修', '已修', '现在可选'])
  })
})

describe('ids, links and labels', () => {
  it('splits campus ids', () => {
    expect(codeOf('UTM:CSC148H5')).toBe('CSC148H5')
    expect(codeOf('CSC148H5')).toBe('CSC148H5')
    expect(campusOf('UTSG:CSC148H1')).toBe('UTSG')
    expect(campusOf('CSC148H1')).toBe('')
  })

  it('fills the official course page template with the lower-case code', () => {
    expect(coursePageUrl('https://utm.calendar.utoronto.ca/course/{slug}', 'CSC148H5')).toBe('https://utm.calendar.utoronto.ca/course/csc148h5')
  })

  it('infers credits from H / Y codes for courses outside the calendar', () => {
    expect(creditsFromCode('CSC148H1')).toBe(0.5)
    expect(creditsFromCode('MAT137Y5')).toBe(1)
    expect(creditsFromCode('XYZ')).toBe(0)
  })

  it('formats credits with one decimal and UofT singular wording', () => {
    expect(formatCredits(0.5, 'en')).toBe('0.5')
    expect(formatCredits(1, 'en')).toBe('1.0')
    expect(formatCredits(12.25, 'en')).toBe('12.25')
    expect(creditsText(0.5, 'en', en)).toBe('0.5 credit')
    expect(creditsText(1, 'en', en)).toBe('1.0 credit')
    expect(creditsText(2.5, 'en', en)).toBe('2.5 credits')
    expect(creditsText(2.5, 'zh', zh)).toBe('2.5 学分')
  })

  it('pads levels and dashes academic years', () => {
    expect(levelText(0)).toBe('000')
    expect(levelText(300)).toBe('300')
    expect(academicYearText('2026-2027')).toBe('2026–2027')
    expect(academicYearText('synthetic')).toBe('synthetic')
  })

  it('drops the trailing code from program titles only when it is the suffix', () => {
    expect(programDisplayTitle('Computer Science - Major (Science) - ERMAJ1688', 'ERMAJ1688')).toBe('Computer Science - Major (Science)')
    expect(programDisplayTitle('Focus in Something', 'ERFOC1')).toBe('Focus in Something')
  })
})

describe('grade input', () => {
  it('accepts empty, whole and decimal grades from 0 to 100', () => {
    expect(parseGrade('')).toBeNull()
    expect(parseGrade('  ')).toBeNull()
    expect(parseGrade('0')).toBe(0)
    expect(parseGrade('77.5')).toBe(77.5)
    expect(parseGrade(' 100 ')).toBe(100)
  })

  it('rejects anything else', () => {
    for (const text of ['101', '-1', 'abc', '7e1', '50%', '1.234', '.5']) expect(parseGrade(text), text).toBe('invalid')
  })
})

describe('small list helpers', () => {
  it('splits templates into text and value parts', () => {
    expect(splitTemplate('Needs {d} directly · {t} in total', { d: 2, t: '5' })).toEqual([
      { text: 'Needs ' }, { key: 'd', value: '2' }, { text: ' directly · ' }, { key: 't', value: '5' }, { text: ' in total' },
    ])
    expect(splitTemplate('{x} only {missing}', { x: 1 })).toEqual([{ key: 'x', value: '1' }, { text: ' only {missing}' }])
  })

  it('keeps recent courses unique, newest first, capped', () => {
    let list: string[] = []
    for (const id of ['a', 'b', 'c', 'a', 'd', 'e', 'f', 'g']) list = pushRecent(list, id)
    expect(list).toEqual(['g', 'f', 'e', 'd', 'a', 'c'])
  })

  it('caps long lists unless expanded', () => {
    const items = Array.from({ length: 45 }, (_, i) => i)
    expect(capList(items, 24, false).shown).toHaveLength(24)
    expect(capList(items, 24, false).rest).toBe(21)
    expect(capList(items, 24, true)).toEqual({ shown: items, rest: 0 })
    expect(capList(items.slice(0, 3), 24, false).rest).toBe(0)
  })

  it('lists codes with a "+n more" tail', () => {
    expect(codeList(['UTM:MAT135H5'], 2, en)).toBe('MAT135H5')
    expect(codeList(['UTM:A1', 'UTM:B2', 'UTM:C3', 'UTM:D4'], 2, en)).toBe('A1, B2 +2 more')
  })
})
