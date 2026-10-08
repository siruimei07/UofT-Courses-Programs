import { describe, expect, it } from 'vitest'
import { buildTopology, computeGeometry, computePresentation } from '../src/graph'
import type { Geometry, NodeBox, Presentation } from '../src/graph'
import { HIT_CELL, MINI_HIT, buildHitGrid, cursorCandidates, hitTest, laneEdgeCursor, moveCursor, queryRect, startCursor } from '../src/graph/hittest'
import { createLabelMeasure } from '../src/graph/text'
import { loadGraphDataset, presentationInput } from './helpers/dataset'

const { dataset } = loadGraphDataset()
const topology = buildTopology(dataset)
const measure = createLabelMeasure(topology, dataset, { measureText: (text, font) => text.length * Number(/([\d.]+)px/.exec(font)?.[1] ?? 13) * 0.55, creditLabel: '{n} cr' })

function model(focusId: string | null, extra: Partial<Parameters<typeof presentationInput>[0]> = {}) {
  const presentation = computePresentation(topology, presentationInput({ focusId, chainTitles: 'direct', ...extra }))
  const geometry = computeGeometry(topology, presentation, measure)
  return { presentation, geometry }
}

const idx = (code: string) => topology.indexById.get(`UTM:${code}`)!

describe('hit grid (design-spec 11.2)', () => {
  it('uses 64 world-px buckets and excludes hidden nodes', () => {
    const { geometry, presentation } = model('UTM:CSC148H5', { hideUnrelated: true })
    const grid = buildHitGrid(geometry)
    expect(grid.cell).toBe(HIT_CELL)
    const hidden = presentation.cls.findIndex(c => c === 'hidden')
    expect(hidden).toBeGreaterThanOrEqual(0)
    expect(Number.isNaN(grid.boxes[hidden * 4])).toBe(true)
    for (const bucket of grid.buckets) for (const i of bucket) expect(presentation.cls[i]).not.toBe('hidden')
  })

  it('finds every visible, drawn node at its dot centre', () => {
    for (const focus of [null, 'UTM:CSC148H5', 'UTM:MAT232H5']) {
      const { geometry } = model(focus)
      const grid = buildHitGrid(geometry)
      const misses: string[] = []
      geometry.nodes.forEach((box, i) => {
        if (box.cls === 'hidden' || box.overflow) return
        if (hitTest(grid, geometry, box.cx, box.cy) !== i) misses.push(topology.nodes[i].code)
      })
      expect(misses).toEqual([])
    }
  })

  it('hits labelled nodes on their label and minis on an 8 × 8 box only', () => {
    const { geometry } = model('UTM:CSC148H5')
    const grid = buildHitGrid(geometry)
    const csc207 = geometry.nodes[idx('CSC207H5')]
    expect(hitTest(grid, geometry, csc207.x + csc207.w - 2, csc207.cy)).toBe(idx('CSC207H5'))
    const mini = geometry.nodes.findIndex(b => b.cls === 'mini' && !b.overflow)
    const box = geometry.nodes[mini]
    expect(hitTest(grid, geometry, box.cx + MINI_HIT / 2 - 0.5, box.cy)).toBe(mini)
    expect(hitTest(grid, geometry, -1000, -1000)).toBe(-1)
  })

  it('never returns overflow minis (slim lanes)', () => {
    const { geometry } = model('UTM:CSC148H5')
    const overflow = geometry.nodes.findIndex(b => b.overflow)
    expect(overflow).toBeGreaterThanOrEqual(0)
    const grid = buildHitGrid(geometry)
    const box = geometry.nodes[overflow]
    expect(hitTest(grid, geometry, box.cx, box.cy)).not.toBe(overflow)
    expect(queryRect(grid, box.cx - 1, box.cy - 1, 2, 2)).not.toContain(overflow)
  })

  it('breaks ties by the nearest dot (vertical distance + 0.1 × horizontal)', () => {
    const box = (cx: number, cy: number): NodeBox => ({ x: cx - 8, y: cy - 20, w: 120, h: 40, cx, cy, cls: 'full', track: 0, overflow: false })
    const geometry: Geometry = { nodes: [box(100, 100), box(140, 110)], columns: [], lanes: [], bands: [], width: 400, height: 300 }
    const grid = buildHitGrid(geometry)
    expect(hitTest(grid, geometry, 150, 101)).toBe(0)
    expect(hitTest(grid, geometry, 150, 109)).toBe(1)
  })

  it('returns the nodes intersecting a rectangle (viewport queries)', () => {
    const { geometry } = model(null)
    const grid = buildHitGrid(geometry)
    const csc = geometry.nodes[idx('CSC148H5')]
    const found = queryRect(grid, csc.cx - 50, csc.cy - 50, 100, 100)
    expect(found).toContain(idx('CSC148H5'))
    for (const i of found) {
      const b = geometry.nodes[i]
      expect(b.cls).not.toBe('hidden')
    }
  })
})

describe('keyboard cursor navigation (design-spec 11.3)', () => {
  const ctxOf = (presentation: Presentation, geometry: Geometry, focus: number, programActive = false) => ({
    topology, geometry, presentation, focus, candidates: cursorCandidates(presentation, geometry, focus, programActive),
  })

  it('moves inside a track, then across columns and lanes in the overview', () => {
    const { presentation, geometry } = model(null)
    const ctx = ctxOf(presentation, geometry, -1)
    const from = idx('CSC108H5')
    const down = moveCursor(ctx, from, 'down')
    expect(topology.nodes[down].lane).toBe(topology.nodes[from].lane)
    expect(topology.nodes[down].col).toBe(topology.nodes[from].col)
    expect(geometry.nodes[down].cy).toBeGreaterThan(geometry.nodes[from].cy)
    const right = moveCursor(ctx, from, 'right')
    expect(topology.nodes[right].col).toBeGreaterThan(topology.nodes[from].col)
    expect(topology.nodes[right].lane).toBe(topology.nodes[from].lane)
    const left = moveCursor(ctx, right, 'left')
    expect(topology.nodes[left].col).toBeLessThan(topology.nodes[right].col)
    // The top node of a lane moves up into the previous lane.
    const lane = topology.nodes[from].lane
    const top = ctx.candidates.filter(v => topology.nodes[v].lane === lane).sort((a, b) => geometry.nodes[a].cy - geometry.nodes[b].cy)[0]
    expect(topology.nodes[moveCursor(ctx, top, 'up')].lane).toBeLessThan(lane)
  })

  it('goes from the focus to the nearest direct prerequisite or unlock during a selection', () => {
    const { presentation, geometry } = model('UTM:CSC148H5')
    const focus = idx('CSC148H5')
    const ctx = ctxOf(presentation, geometry, focus)
    expect(ctx.candidates.every(v => presentation.role[v] !== 'none')).toBe(true)
    expect(presentation.role[moveCursor(ctx, focus, 'left')]).toBe('prereq-direct')
    expect(presentation.role[moveCursor(ctx, focus, 'right')]).toBe('unlock-direct')
    expect(startCursor(ctx)).toBe(focus)
  })

  it('jumps to the first and last lanes with Home / End', () => {
    const { presentation, geometry } = model(null)
    const ctx = ctxOf(presentation, geometry, -1)
    const lanes = ctx.candidates.map(v => topology.nodes[v].lane)
    expect(topology.nodes[laneEdgeCursor(ctx, idx('CSC148H5'), false)].lane).toBe(Math.min(...lanes))
    expect(topology.nodes[laneEdgeCursor(ctx, idx('CSC148H5'), true)].lane).toBe(Math.max(...lanes))
  })
})
