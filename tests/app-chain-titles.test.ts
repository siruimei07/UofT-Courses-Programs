import { describe, expect, it } from 'vitest'
import { chainTitlesAuto, resolveChainTitles, type ChainTitlesBase } from '../src/app/chainTitles'
import { boxFitsPlot, chainBox } from '../src/app/framing'
import { buildTopology } from '../src/graph/topology'
import { createLabelMeasure } from '../src/graph/text'
import { loadGraphDataset, presentationInput } from './helpers/dataset'

/** Deterministic stand-in for canvas measureText (as in graph-text.test.ts): about 0.55 em per character. */
const fakeMeasure = (text: string, font: string) => {
  const size = Number(/([\d.]+)px/.exec(font)?.[1] ?? 13)
  const weight = Number(/^(\d+)/.exec(font)?.[1] ?? 400)
  return text.length * size * (weight >= 600 ? 0.6 : 0.55)
}

const { dataset } = loadGraphDataset()
const topology = buildTopology(dataset)
const measure = createLabelMeasure(topology, dataset, { measureText: fakeMeasure, creditLabel: '{n} cr' })

/** Plot areas of design-spec 6.1 with the panel open. */
const PLOT_1920 = { width: 1318, height: 766 }
const PLOT_1536 = { width: 994, height: 582 }

const baseFor = (code: string, overrides: Partial<ChainTitlesBase> = {}): ChainTitlesBase => {
  const { chainTitles: _ignored, ...rest } = presentationInput({ focusId: `UTM:${code}`, ...overrides })
  void _ignored
  return rest
}
const indexOf = (code: string) => topology.indexById.get(`UTM:${code}`) ?? -1

describe('chain titles: auto (design-spec 8.2, 16.2)', () => {
  it('CSC148H5 resolves to "direct" at 1536 with the panel open', () => {
    const result = resolveChainTitles(topology, baseFor('CSC148H5'), indexOf('CSC148H5'), measure, PLOT_1536)
    expect(result.chainTitles).toBe('direct')
    // The 'all' chain really does not fit at the 0.92 floor.
    const all = resolveChainTitles(topology, baseFor('CSC148H5', { titles: true }), indexOf('CSC148H5'), measure, PLOT_1536)
    expect(boxFitsPlot(chainBox(all.presentation, all.geometry), PLOT_1536)).toBe(false)
  })

  it('CSC148H5 also drops transitive titles at 1920', () => {
    expect(resolveChainTitles(topology, baseFor('CSC148H5'), indexOf('CSC148H5'), measure, PLOT_1920).chainTitles).toBe('direct')
  })

  it('Titles forces "all"', () => {
    const base = baseFor('CSC148H5', { titles: true })
    expect(chainTitlesAuto(base, indexOf('CSC148H5'))).toBe(false)
    expect(resolveChainTitles(topology, base, indexOf('CSC148H5'), measure, PLOT_1536).chainTitles).toBe('all')
  })

  it('Direct only, no focus and an unknown plot keep "all"', () => {
    expect(resolveChainTitles(topology, baseFor('CSC148H5', { depth: 'direct' }), indexOf('CSC148H5'), measure, PLOT_1536).chainTitles).toBe('all')
    const overview = baseFor('CSC148H5', { focusId: null })
    expect(resolveChainTitles(topology, overview, -1, measure, PLOT_1536).chainTitles).toBe('all')
    expect(resolveChainTitles(topology, baseFor('CSC148H5'), indexOf('CSC148H5'), measure, null).chainTitles).toBe('all')
  })

  it('a chain that fits keeps its transitive titles', () => {
    // A course with no relations: its chain is the focus alone.
    const lone = topology.nodes.find(node => !topology.preds[node.index].length && !topology.succs[node.index].length)!
    const result = resolveChainTitles(topology, baseFor(lone.code), lone.index, measure, PLOT_1536)
    expect(result.chainTitles).toBe('all')
  })

  it('the "direct" pass only demotes transitive chain nodes', () => {
    const focus = indexOf('CSC148H5')
    const direct = resolveChainTitles(topology, baseFor('CSC148H5'), focus, measure, PLOT_1536)
    const all = resolveChainTitles(topology, baseFor('CSC148H5'), focus, measure, null)
    direct.presentation.role.forEach((role, index) => {
      if (role === 'prereq' || role === 'unlock') expect(direct.presentation.cls[index]).not.toBe('full')
      else expect(direct.presentation.cls[index]).toBe(all.presentation.cls[index])
    })
  })
})
