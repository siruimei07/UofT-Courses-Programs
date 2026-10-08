import { describe, expect, it } from 'vitest'
import { hasPassedCourse, isFailedEntry, presentationRecord, recordEligibility } from '../src/app/record'
import type { RecordEntry } from '../src/app/store'
import { createEngine } from '../src/domain/engine'
import type { CourseEngine } from '../src/domain/engine-types'
import { computePresentation } from '../src/graph/presentation'
import { buildTopology } from '../src/graph/topology'
import { cachedEligibility } from '../src/ui/panels/record'
import { presentationInput, syntheticDataset } from './helpers/dataset'

// CSC108 → CSC148 → CSC207; MAT102 stands alone.
const dataset = syntheticDataset([
  { code: 'CSC108H5' },
  { code: 'CSC148H5', prereq: ['CSC108H5'] },
  { code: 'CSC207H5', prereq: ['CSC148H5'] },
  { code: 'MAT102H5' },
])
const topology = buildTopology(dataset)
const record = (entries: [string, RecordEntry][]) => new Map(entries.map(([code, entry]) => [`UTM:${code}`, entry]))

describe('failed courses (grade < 50) count as not taken on the map', () => {
  it('a fail is a completed course with a grade below 50 only', () => {
    expect(isFailedEntry({ status: 'completed', grade: 49.5 })).toBe(true)
    expect(isFailedEntry({ status: 'completed', grade: 0 })).toBe(true)
    expect(isFailedEntry({ status: 'completed', grade: 50 })).toBe(false)
    expect(isFailedEntry({ status: 'completed' })).toBe(false)
    expect(isFailedEntry({ status: 'inProgress', grade: 20 })).toBe(false)
  })

  it('presentationRecord drops failed courses and keeps every other status', () => {
    const statuses = presentationRecord(record([
      ['CSC108H5', { status: 'completed', grade: 42 }],
      ['CSC148H5', { status: 'completed', grade: 50 }],
      ['CSC207H5', { status: 'inProgress' }],
      ['MAT102H5', { status: 'planned' }],
    ]))
    expect([...statuses]).toEqual([['UTM:CSC148H5', 'completed'], ['UTM:CSC207H5', 'inProgress'], ['UTM:MAT102H5', 'planned']])
  })

  it('hasPassedCourse ignores fails (Hide completed cannot hide them)', () => {
    expect(hasPassedCourse(record([['CSC108H5', { status: 'completed', grade: 30 }], ['MAT102H5', { status: 'planned' }]]))).toBe(false)
    expect(hasPassedCourse(record([['CSC108H5', { status: 'completed' }]]))).toBe(true)
    expect(hasPassedCourse(new Map())).toBe(false)
  })

  it('a failed course is drawn as available for a retake, and what it unlocks is not', () => {
    const engine = createEngine(dataset)
    const failed = record([['CSC108H5', { status: 'completed', grade: 40 }]])
    const presentation = computePresentation(topology, presentationInput({
      record: presentationRecord(failed),
      eligibility: recordEligibility(engine, failed),
    }))
    const at = (code: string) => topology.indexById.get(`UTM:${code}`) ?? -1
    expect(presentation.record[at('CSC108H5')]).toBeNull()
    expect(presentation.eligibility[at('CSC108H5')]).toBe('met')
    expect(presentation.eligibility[at('CSC148H5')]).toBe('unmet')

    // Passed, the same course is drawn as completed and unlocks CSC148H5.
    const passed = record([['CSC108H5', { status: 'completed', grade: 80 }]])
    const after = computePresentation(topology, presentationInput({
      record: presentationRecord(passed),
      eligibility: recordEligibility(engine, passed),
    }))
    expect(after.record[at('CSC108H5')]).toBe('completed')
    expect(after.eligibility[at('CSC108H5')]).toBeNull()
    expect(after.eligibility[at('CSC148H5')]).toBe('met')
  })
})

describe('recordEligibility (one engine pass per record change)', () => {
  const counting = () => {
    const engine = createEngine(dataset)
    let calls = 0
    const counted: CourseEngine = { ...engine, eligibility: rec => { calls++; return engine.eligibility(rec) } }
    return { engine: counted, calls: () => calls }
  }

  it('is null for an empty record without running the engine', () => {
    const { engine, calls } = counting()
    expect(recordEligibility(engine, new Map())).toBeNull()
    expect(calls()).toBe(0)
  })

  it('shares the panels memo: same record object, same map, one engine call', () => {
    const { engine, calls } = counting()
    const current = record([['CSC108H5', { status: 'completed' }]])
    const fromApp = recordEligibility(engine, current)
    const fromPanels = cachedEligibility(engine, current)
    expect(fromApp).toBe(fromPanels)
    expect(recordEligibility(engine, current)).toBe(fromApp)
    expect(calls()).toBe(1)
    // The store replaces the record on every change: a new object is a new pass.
    const next = new Map(current).set('UTM:MAT102H5', { status: 'planned' })
    expect(recordEligibility(engine, next)).not.toBe(fromApp)
    expect(calls()).toBe(2)
  })

  it('falls back to null when the engine fails, as the panels do', () => {
    const broken: CourseEngine = { ...createEngine(dataset), eligibility: () => { throw new Error('boom') } }
    expect(recordEligibility(broken, record([['CSC108H5', { status: 'completed' }]]))).toBeNull()
  })
})
