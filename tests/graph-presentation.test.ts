import { describe, expect, it } from 'vitest'
import { buildTopology, collectAncestors, collectDescendants, computePresentation, levelGroup } from '../src/graph'
import type { Presentation, Topology } from '../src/graph'
import { loadGraphDataset, presentationInput, syntheticDataset } from './helpers/dataset'

const topology = buildTopology(loadGraphDataset().dataset)
const at = (topo: Topology, code: string) => {
  const index = topo.indexById.get(`UTM:${code}`)
  if (index === undefined) throw new Error(`Missing course ${code}`)
  return index
}
const roleOf = (topo: Topology, p: Presentation, code: string) => p.role[at(topo, code)]
const clsOf = (topo: Topology, p: Presentation, code: string) => p.cls[at(topo, code)]
const edgeRoleOf = (topo: Topology, p: Presentation, from: string, to: string) => {
  const index = topo.edges.findIndex(edge => edge.from === at(topo, from) && edge.to === at(topo, to))
  if (index < 0) throw new Error(`Missing edge ${from} → ${to}`)
  return p.edgeRole[index]
}

describe('presentation on the real UTM dataset', () => {
  it('shows every node compact with faint edges when nothing is focused', () => {
    const p = computePresentation(topology, presentationInput())
    expect(p.dimming).toBe(false)
    expect(new Set(p.cls)).toEqual(new Set(['compact']))
    expect(new Set(p.role)).toEqual(new Set(['none']))
    expect(new Set(p.edgeRole)).toEqual(new Set(['faint']))
    expect(p.edgeRole).toHaveLength(topology.edges.length)
  })

  it('colours the CSC148H5 chain: CSC108H5 waits before it, CSC207H5 and 300-level CSC follow', () => {
    const p = computePresentation(topology, presentationInput({ focusId: 'UTM:CSC148H5' }))
    expect(p.dimming).toBe(true)
    expect(roleOf(topology, p, 'CSC148H5')).toBe('focus')
    expect(roleOf(topology, p, 'CSC108H5')).toBe('prereq-direct')
    expect(roleOf(topology, p, 'CSC207H5')).toBe('unlock-direct')
    const indirect = topology.nodes.filter(n => n.subject === 'CSC' && n.level === 300 && p.role[n.index] === 'unlock')
    expect(indirect.length).toBeGreaterThan(0)
    expect(edgeRoleOf(topology, p, 'CSC108H5', 'CSC148H5')).toBe('prereq-direct')
    expect(edgeRoleOf(topology, p, 'CSC148H5', 'CSC207H5')).toBe('unlock-direct')
    for (const n of topology.nodes) {
      expect(p.cls[n.index]).toBe(p.role[n.index] === 'none' ? 'mini' : 'full')
    }
    expect(p.edgeRole).toContain('hidden')
    expect(p.edgeRole).toContain('unlock')
  })

  it('matches collectAncestors / collectDescendants', () => {
    const focus = at(topology, 'CSC148H5')
    const p = computePresentation(topology, presentationInput({ focusId: 'UTM:CSC148H5' }))
    const ancestors = collectAncestors(topology, focus, 'all')
    const descendants = collectDescendants(topology, focus, 'all')
    expect(ancestors.has(focus)).toBe(false)
    expect([...ancestors].every(v => p.role[v] === 'prereq' || p.role[v] === 'prereq-direct')).toBe(true)
    expect([...descendants].every(v => p.role[v] === 'unlock' || p.role[v] === 'unlock-direct')).toBe(true)
    expect(p.role.filter(role => role !== 'none' && role !== 'focus')).toHaveLength(ancestors.size + descendants.size)
  })
})

// AAA101 → AAA201 → AAA301 → AAA401, AAA102 → AAA201 → AAA302, AAA102 → AAA301; BBB101 → BBB201; CCC010.
const synthetic = buildTopology(syntheticDataset([
  { code: 'AAA101H5' },
  { code: 'AAA102H5' },
  { code: 'AAA201H5', prereq: ['AAA101H5', 'AAA102H5'] },
  { code: 'AAA301H5', prereq: ['AAA201H5', 'AAA102H5'] },
  { code: 'AAA302H5', prereq: ['AAA201H5'] },
  { code: 'AAA401H5', prereq: ['AAA301H5'] },
  { code: 'BBB101H5' },
  { code: 'BBB201H5', prereq: ['BBB101H5'] },
  { code: 'CCC010H5', level: 0 },
]))
const run = (overrides: Parameters<typeof presentationInput>[0]) => computePresentation(synthetic, presentationInput(overrides))

describe('presentation rules on a synthetic graph', () => {
  it('assigns direct and transitive roles with depth "all"', () => {
    const p = run({ focusId: 'UTM:AAA201H5' })
    const roles = Object.fromEntries(synthetic.nodes.map(n => [n.code, p.role[n.index]]))
    expect(roles).toEqual({
      AAA101H5: 'prereq-direct', AAA102H5: 'prereq-direct', AAA201H5: 'focus', AAA301H5: 'unlock-direct',
      AAA302H5: 'unlock-direct', AAA401H5: 'unlock', BBB101H5: 'none', BBB201H5: 'none', CCC010H5: 'none',
    })
    expect(edgeRoleOf(synthetic, p, 'AAA301H5', 'AAA401H5')).toBe('unlock')
    // AAA102 → AAA301 jumps from an ancestor to a descendant: not part of either chain.
    expect(edgeRoleOf(synthetic, p, 'AAA102H5', 'AAA301H5')).toBe('hidden')
    expect(edgeRoleOf(synthetic, p, 'BBB101H5', 'BBB201H5')).toBe('hidden')
  })

  it('marks transitive prerequisites as "prereq" and colours their edges', () => {
    const p = run({ focusId: 'UTM:AAA401H5' })
    expect(roleOf(synthetic, p, 'AAA301H5')).toBe('prereq-direct')
    expect(roleOf(synthetic, p, 'AAA101H5')).toBe('prereq')
    expect(edgeRoleOf(synthetic, p, 'AAA301H5', 'AAA401H5')).toBe('prereq-direct')
    expect(edgeRoleOf(synthetic, p, 'AAA101H5', 'AAA201H5')).toBe('prereq')
    expect(edgeRoleOf(synthetic, p, 'AAA102H5', 'AAA301H5')).toBe('prereq')
    expect(edgeRoleOf(synthetic, p, 'AAA201H5', 'AAA302H5')).toBe('hidden')
  })

  it('limits chains and coloured edges to immediate neighbours with depth "direct"', () => {
    const p = run({ focusId: 'UTM:AAA301H5', depth: 'direct' })
    expect(roleOf(synthetic, p, 'AAA201H5')).toBe('prereq-direct')
    expect(roleOf(synthetic, p, 'AAA102H5')).toBe('prereq-direct')
    expect(roleOf(synthetic, p, 'AAA101H5')).toBe('none')
    expect(roleOf(synthetic, p, 'AAA401H5')).toBe('unlock-direct')
    expect(clsOf(synthetic, p, 'AAA101H5')).toBe('mini')
    expect(edgeRoleOf(synthetic, p, 'AAA201H5', 'AAA301H5')).toBe('prereq-direct')
    // Both ends are direct prerequisites, but only edges touching the focus are coloured.
    expect(edgeRoleOf(synthetic, p, 'AAA102H5', 'AAA201H5')).toBe('hidden')
    expect(run({ focusId: 'UTM:AAA301H5', depth: 'direct', showAllEdges: true }).edgeRole).not.toContain('hidden')
  })

  it('hides unrelated nodes and their edges when requested', () => {
    const p = run({ focusId: 'UTM:AAA201H5', hideUnrelated: true })
    expect(clsOf(synthetic, p, 'BBB101H5')).toBe('hidden')
    expect(clsOf(synthetic, p, 'AAA401H5')).toBe('full')
    expect(edgeRoleOf(synthetic, p, 'BBB101H5', 'BBB201H5')).toBe('hidden')
    expect(run({ focusId: 'UTM:AAA201H5', hideUnrelated: true, showAllEdges: true }).edgeRole).toContain('hidden')
  })

  it('applies level, subject and completed filters but never hides the focus', () => {
    const levels = run({ levels: new Set([100]) })
    expect(clsOf(synthetic, levels, 'CCC010H5')).toBe('compact')
    expect(clsOf(synthetic, levels, 'AAA201H5')).toBe('hidden')
    expect(edgeRoleOf(synthetic, levels, 'AAA101H5', 'AAA201H5')).toBe('hidden')
    expect(edgeRoleOf(synthetic, levels, 'BBB101H5', 'BBB201H5')).toBe('hidden')

    const subjects = run({ subjects: new Set(['BBB']), focusId: 'UTM:AAA201H5' })
    expect(clsOf(synthetic, subjects, 'AAA201H5')).toBe('full')
    expect(clsOf(synthetic, subjects, 'AAA101H5')).toBe('hidden')
    expect(clsOf(synthetic, subjects, 'BBB101H5')).toBe('mini')

    const record = new Map([['UTM:AAA101H5', 'completed' as const], ['UTM:AAA201H5', 'completed' as const]])
    const completed = run({ hideCompleted: true, record, focusId: 'UTM:AAA201H5' })
    expect(clsOf(synthetic, completed, 'AAA101H5')).toBe('hidden')
    expect(clsOf(synthetic, completed, 'AAA201H5')).toBe('full')
    expect(levelGroup(0)).toBe(100)
    expect(levelGroup(399)).toBe(300)
  })

  it('highlights program courses and their edges when no course is focused', () => {
    const programIds = new Set(['UTM:BBB101H5', 'UTM:BBB201H5', 'UTM:AAA401H5'])
    const p = run({ programIds })
    expect(p.dimming).toBe(true)
    expect(roleOf(synthetic, p, 'BBB101H5')).toBe('program')
    expect(clsOf(synthetic, p, 'BBB201H5')).toBe('full')
    expect(clsOf(synthetic, p, 'AAA101H5')).toBe('mini')
    expect(p.inProgram[at(synthetic, 'AAA401H5')]).toBe(true)
    expect(edgeRoleOf(synthetic, p, 'BBB101H5', 'BBB201H5')).toBe('program')
    expect(edgeRoleOf(synthetic, p, 'AAA301H5', 'AAA401H5')).toBe('hidden')

    const focused = run({ programIds, focusId: 'UTM:AAA301H5' })
    expect(roleOf(synthetic, focused, 'AAA401H5')).toBe('unlock-direct')
    expect(roleOf(synthetic, focused, 'BBB101H5')).toBe('program')
    expect(edgeRoleOf(synthetic, focused, 'BBB101H5', 'BBB201H5')).toBe('hidden')
    expect(edgeRoleOf(synthetic, run({ programIds, focusId: 'UTM:AAA301H5', showAllEdges: true }), 'BBB101H5', 'BBB201H5')).toBe('faint')
  })

  it('copies record and eligibility, skipping eligibility for completed or in-progress courses', () => {
    const record = new Map([
      ['UTM:AAA101H5', 'completed' as const], ['UTM:AAA102H5', 'inProgress' as const], ['UTM:AAA201H5', 'planned' as const],
    ])
    const eligibility = new Map([
      ['UTM:AAA101H5', 'met' as const], ['UTM:AAA102H5', 'met' as const], ['UTM:AAA201H5', 'unknown' as const], ['UTM:AAA301H5', 'unmet' as const],
    ])
    const p = run({ record, eligibility })
    const pick = (code: string) => [p.record[at(synthetic, code)], p.eligibility[at(synthetic, code)]]
    expect(pick('AAA101H5')).toEqual(['completed', null])
    expect(pick('AAA102H5')).toEqual(['inProgress', null])
    expect(pick('AAA201H5')).toEqual(['planned', 'unknown'])
    expect(pick('AAA301H5')).toEqual([null, 'unmet'])
    expect(pick('AAA401H5')).toEqual([null, null])
    expect(run({}).eligibility.every(value => value === null)).toBe(true)
  })

  it('treats an unknown focus id as no focus', () => {
    const p = run({ focusId: 'UTM:NOPE999H5' })
    expect(p.dimming).toBe(false)
    expect(new Set(p.cls)).toEqual(new Set(['compact']))
  })

  it('collects reachable nodes breadth-first without looping on cycles', () => {
    const cyclic = { preds: [[2], [0], [1]], succs: [[1], [2], [0]] } as unknown as Topology
    expect([...collectAncestors(cyclic, 0)].sort()).toEqual([1, 2])
    expect([...collectDescendants(cyclic, 0, 'direct')]).toEqual([1])
    expect([...collectAncestors(synthetic, at(synthetic, 'AAA401H5'), 'all')].map(v => synthetic.nodes[v].code).sort())
      .toEqual(['AAA101H5', 'AAA102H5', 'AAA201H5', 'AAA301H5'])
  })
})
