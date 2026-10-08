import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { appStore, initialAppState } from '../src/app/store'
import { breakpointOf } from '../src/app/useBreakpoint'
import { pickCampus } from '../src/app/useCampusData'
import { programsStatus } from '../src/app/usePrograms'
import type { CampusEntry, CampusRegistry, GraphCourse } from '../src/data/schema'
import { laneTone, buildTopology } from '../src/graph/topology'
import { CardHead, cardMeta, metaVisibility, type CardMeta } from '../src/ui/CardHead'
import { Header, type HeaderSearchProps } from '../src/ui/Header'
import { LegendStrip } from '../src/ui/LegendStrip'
import { StartStrip } from '../src/ui/StartStrip'
import { subjectTones } from '../src/ui/SubjectBullet'
import { groupSubjects, SubjectPicker } from '../src/ui/SubjectPicker'
import { nextLevels } from '../src/ui/Toolbar'
import { loadGraphDataset, syntheticDataset } from './helpers/dataset'

const { dataset } = loadGraphDataset()
const topology = buildTopology(dataset)
const render = (element: ReactElement) => renderToStaticMarkup(element)

afterEach(() => appStore.set(initialAppState()))

describe('nextLevels (design-spec 6.4)', () => {
  it('a click solos a level, and a second click on the solo level shows all again', () => {
    expect(nextLevels(null, 200, false)).toEqual(new Set([200]))
    expect(nextLevels(new Set([100, 300]), 200, false)).toEqual(new Set([200]))
    expect(nextLevels(new Set([200]), 200, false)).toBeNull()
  })

  it('Ctrl / Shift + click adds or removes a level; removing the last one means All', () => {
    expect(nextLevels(null, 300, true)).toEqual(new Set([300]))
    expect(nextLevels(new Set([300]), 100, true)).toEqual(new Set([100, 300]))
    expect(nextLevels(new Set([100, 300]), 300, true)).toEqual(new Set([100]))
    expect(nextLevels(new Set([100]), 100, true)).toBeNull()
  })
})

describe('card meta (6.3, 19.4)', () => {
  const input = { subjects: 70, courses: 2491, shownCourses: 2491, shownSubjects: 70, filtered: false, collapsing: false }

  it('reports all courses, filtered courses or the subjects left in Hide mode', () => {
    expect(cardMeta(input)).toEqual({ kind: 'all', subjects: 70, courses: 2491 })
    expect(cardMeta({ ...input, filtered: true, shownCourses: 1203 })).toEqual({ kind: 'filtered', shown: 1203, courses: 2491 })
    expect(cardMeta({ ...input, filtered: true, collapsing: true, shownSubjects: 18 })).toEqual({ kind: 'subjects', shown: 18, total: 70 })
  })

  it('standard and compact keep the collapsed-lane count (short) during a selection in Hide mode', () => {
    const all: CardMeta = { kind: 'all', subjects: 70, courses: 2491 }
    const hide: CardMeta = { kind: 'subjects', shown: 18, total: 70 }
    expect(metaVisibility('wide', all, true, false)).toBe('full')
    expect(metaVisibility('standard', all, true, false)).toBe('hidden')
    expect(metaVisibility('standard', hide, true, false)).toBe('short')
    expect(metaVisibility('compact', hide, true, false)).toBe('short')
    expect(metaVisibility('standard', hide, false, false)).toBe('full')
    expect(metaVisibility('compact', all, false, true)).toBe('hidden')
    expect(metaVisibility('wide', all, false, true)).toBe('full')
  })
})

describe('breakpointOf (6.1)', () => {
  it('maps window widths to the frames', () => {
    expect(breakpointOf(1920)).toBe('wide')
    expect(breakpointOf(1700)).toBe('wide')
    expect(breakpointOf(1699)).toBe('standard')
    expect(breakpointOf(1536)).toBe('standard')
    expect(breakpointOf(1440)).toBe('standard')
    expect(breakpointOf(1439)).toBe('compact')
    expect(breakpointOf(1280)).toBe('compact')
    expect(breakpointOf(1279)).toBe('narrow')
  })
})

describe('pickCampus', () => {
  const entry = (id: CampusEntry['id'], status: CampusEntry['status'], dataPath?: string): CampusEntry => ({
    id, name: id, shortName: id, status, calendarUrl: '', ...(dataPath ? { dataPath } : {}),
  })
  const registry: CampusRegistry = { schemaVersion: 1, generatedAt: '', campuses: [entry('UTM', 'available', 'utm/'), entry('UTSG', 'planned'), entry('UTSC', 'available')] }

  it('keeps an available requested campus and falls back to the first available one', () => {
    expect(pickCampus(registry, 'UTM')?.id).toBe('UTM')
    expect(pickCampus(registry, 'UTSG')?.id).toBe('UTM')
    // Available without a data path is not loadable.
    expect(pickCampus(registry, 'UTSC')?.id).toBe('UTM')
    expect(pickCampus({ ...registry, campuses: [entry('UTSG', 'planned')] }, 'UTSG')).toBeNull()
  })
})

describe('programs.json status (review bug 2)', () => {
  const data = { ok: true as const, data: { schemaVersion: 1 as const, campus: 'UTM' as const, programs: [] } }

  it('is idle until wanted, then loading, ready or error for the current attempt', () => {
    expect(programsStatus(false, 'UTM', 0, null)).toBe('idle')
    expect(programsStatus(true, 'UTM', 0, null)).toBe('loading')
    expect(programsStatus(true, 'UTM', 0, { campus: 'UTM', attempt: 0, ...data })).toBe('ready')
    expect(programsStatus(true, 'UTM', 0, { campus: 'UTM', attempt: 0, ok: false })).toBe('error')
  })

  it('a retry (next attempt) loads again instead of staying in error', () => {
    expect(programsStatus(true, 'UTM', 1, { campus: 'UTM', attempt: 0, ok: false })).toBe('loading')
    expect(programsStatus(true, 'UTM', 1, { campus: 'UTM', attempt: 1, ok: false })).toBe('error')
  })

  it('never reports another campus result', () => {
    expect(programsStatus(true, 'UTSG', 0, { campus: 'UTM', attempt: 0, ...data })).toBe('loading')
    expect(programsStatus(true, 'UTSG', 0, { campus: 'UTM', attempt: 0, ok: false })).toBe('loading')
  })
})

describe('subject tones (7.7, owner decision 19.8)', () => {
  it('come from laneTone in static lane order, so filters never recolour a subject', () => {
    const tones = subjectTones(topology)
    expect(tones.size).toBe(topology.lanes.length)
    for (const lane of topology.lanes) expect(tones.get(lane.subject)?.tone).toBe(laneTone(topology, lane.index))
    // Adjacent lanes of one division always differ.
    topology.lanes.slice(1).forEach((lane, k) => {
      const previous = topology.lanes[k]
      if (previous.division === lane.division) expect(tones.get(lane.subject)?.tone).not.toBe(tones.get(previous.subject)?.tone)
    })
  })

  it('unknown divisions use the interdisciplinary family', () => {
    const synthetic = buildTopology(syntheticDataset([{ code: 'AAA101H5' }, { code: 'BBB101H5' }], [{ code: 'AAA', division: 'mystery' }, { code: 'BBB', division: 'sciences' }]))
    const tones = subjectTones(synthetic)
    expect(tones.get('AAA')?.division).toBe('interdisciplinary')
    expect(tones.get('BBB')?.division).toBe('sciences')
  })
})

describe('groupSubjects (6.9.2, review bug 4)', () => {
  const zh = { sciences: '理学', 'social-sciences': '社会科学', professional: '管理与专业', humanities: '人文', interdisciplinary: '跨学科' }

  it('groups lanes by division in lane order with the localised division labels', () => {
    const groups = groupSubjects(topology, dataset.subjects, dataset.divisions, zh, '其他')
    expect(groups.map(group => group.label)).toEqual(['理学', '社会科学', '管理与专业', '人文', '跨学科'].filter(label => groups.some(group => group.label === label)))
    expect(groups.flatMap(group => group.rows.map(row => row.code))).toEqual(topology.lanes.map(lane => lane.subject))
  })

  it('falls back to the dataset label, then to "Other"', () => {
    const synthetic = syntheticDataset([{ code: 'AAA101H5' }, { code: 'BBB101H5' }], [{ code: 'AAA', division: 'mystery' }, { code: 'BBB', division: 'nowhere' }], [{ id: 'mystery', label: 'Mystery studies' }])
    const groups = groupSubjects(buildTopology(synthetic), synthetic.subjects, synthetic.divisions, zh, 'Other')
    expect(groups.map(group => [group.id, group.label])).toEqual([['mystery', 'Mystery studies'], ['other', 'Other']])
  })
})

describe('markup (review bug 7 and the start strip)', () => {
  const tones = subjectTones(topology)
  const search: HeaderSearchProps = {
    courseIndex: null, programIndex: null, tones, inputRef: { current: null }, programsStatus: 'idle',
    onWantPrograms() {}, onRetryPrograms() {}, onPickCourse() {}, onPickProgram() {},
  }

  it('the My courses count uses visually hidden text, not aria-label on a span', () => {
    appStore.set({ record: new Map([['UTM:CSC108H5', { status: 'completed' }], ['UTM:CSC148H5', { status: 'planned' }]]) })
    const html = render(createElement(Header, { breakpoint: 'wide', registry: null, campus: null, dataset: null, search, programTitle: null }))
    expect(html).toContain('<span class="count-badge" aria-hidden="true">2</span>')
    expect(html).toContain('<span class="sr-only"> (2 in your record)</span>')
    expect(html).not.toMatch(/<span[^>]*aria-label=/)
  })

  it('the subject picker shows Chinese division headers and hidden-text counts in zh', () => {
    appStore.set({ lang: 'zh' })
    const html = render(createElement(SubjectPicker, { topology, subjects: dataset.subjects, divisions: dataset.divisions, tones, onJump() {} }))
    expect(html).toContain('理学')
    expect(html).not.toContain('>Sciences<')
    expect(html).toMatch(/<span class="picker-count"><span aria-hidden="true">\d+<\/span><span class="sr-only">\d+ 门课程<\/span><\/span>/)
    expect(html).not.toMatch(/<span[^>]*aria-label=/)
  })

  it('the program count keeps a real space before "program courses"', () => {
    const meta: CardMeta = { kind: 'all', subjects: 70, courses: 2491 }
    const props = { breakpoint: 'wide' as const, meta, focus: null, start: null, onDetails() {}, onClear() {}, onClearProgram() {} }
    const html = render(createElement(CardHead, { ...props, program: { kind: 'ready', title: 'Computer Science Major', courses: 42 } }))
    // The number and its words sit in one inline span inside the flex readout (no 6 px flex gap).
    expect(html).toContain('<span class="readout"><span><b class="num">42</b> program courses on the map</span></span>')
  })

  it('Hide unrelated in program mode counts subjects without a program course, not a "path"', () => {
    const meta: CardMeta = { kind: 'subjects', shown: 7, total: 70 }
    const props = { breakpoint: 'wide' as const, meta, focus: null, start: null, onDetails() {}, onClear() {}, onClearProgram() {} }
    const html = render(createElement(CardHead, { ...props, program: { kind: 'ready', title: 'Computer Science Major', courses: 42 } })).replace(/<[^>]+>/g, '')
    expect(html).toContain('Showing 7 of 70 subjects (63 have no program course)')
    expect(html).not.toContain('path')
    const chain = render(createElement(CardHead, { ...props, program: null })).replace(/<[^>]+>/g, '')
    expect(chain).toContain('(63 have nothing on this path)')
  })

  it('a program still waiting for a failed programs.json says so with a retry button', () => {
    const meta: CardMeta = { kind: 'all', subjects: 70, courses: 2491 }
    const props = { breakpoint: 'wide' as const, meta, focus: null, start: null, onDetails() {}, onClear() {}, onClearProgram() {} }
    const failed = render(createElement(CardHead, { ...props, program: { kind: 'waiting', status: 'error', onRetry() {} } }))
    expect(failed).toContain('Programs unavailable —')
    expect(failed).toMatch(/<button type="button" class="link-button link-inline"[^>]*>retry<\/button>/)
    const loading = render(createElement(CardHead, { ...props, program: { kind: 'waiting', status: 'loading', onRetry() {} } }))
    expect(loading).toContain('Loading programs…')
  })

  it('the card head adds the corequisite summary to "Needs"', () => {
    const course: GraphCourse = { id: 'UTM:ECO200Y5', code: 'ECO200Y5', title: 'Microeconomic Theory', subject: 'ECO', level: 200, credits: 1 }
    const readout = {
      needs: { kind: 'plain' as const, direct: 2, total: 2 },
      coreqs: { kind: 'oneOf' as const, of: 5 },
      unlocks: { kind: 'none' as const },
      hiddenByFilters: 0,
    }
    const meta: CardMeta = { kind: 'all', subjects: 70, courses: 2491 }
    const html = render(createElement(CardHead, {
      breakpoint: 'wide', meta, focus: { course, readout }, program: null, start: null, onDetails() {}, onClear() {}, onClearProgram() {},
    }))
    expect(html.replace(/<[^>]+>/g, '')).toContain('Needs 2 directly · 2 in total + 1 of 5 corequisites')
  })

  it('the legend calls the prerequisites of an unparsed rule "listed", not "needed", and drops the fork (7.4)', () => {
    // CSC207H5's rule ("CSC111H5 or CSC148H5") is unparsed: both blue dots are listed alternatives.
    const items = (html: string) => html.replace(/<[^>]+>/g, '|')
    const parsed = items(render(createElement(LegendStrip, { mode: 'chain', recordActive: false })))
    expect(parsed).toContain('Needed directly')
    expect(parsed).toContain('Any one of these')
    const listed = items(render(createElement(LegendStrip, { mode: 'chain', recordActive: false, listedOnly: true })))
    expect(listed).toContain('Listed in the requirement text')
    expect(listed).not.toContain('Needed directly')
    expect(listed).not.toContain('Any one of these')
    // Hide unrelated draws no grey dots, so "Not in this chain" has nothing to explain.
    expect(parsed).toContain('Not in this chain')
    expect(items(render(createElement(LegendStrip, { mode: 'chain', recordActive: false, unrelatedHidden: true })))).not.toContain('Not in this chain')
    appStore.set({ lang: 'zh' })
    expect(items(render(createElement(LegendStrip, { mode: 'chain', recordActive: false, listedOnly: true })))).toContain('要求原文中列出')
  })

  it('the start strip shows up to 6 chips, each with the subject bullet', () => {
    const subjects = ['CSC', 'MAT', 'STA', 'ECO', 'PSY', 'BIO', 'ANT'].map(code => dataset.subjects.find(subject => subject.code === code)!).filter(Boolean)
    const html = render(createElement(StartStrip, { subjects, tones, onJump() {}, onAllSubjects() {} }))
    expect(html.match(/class="chip chip-subject"/g)).toHaveLength(6)
    expect(html.match(/class="bullet"/g)).toHaveLength(6)
    expect(html).not.toContain('chip-swatch')
  })
})
