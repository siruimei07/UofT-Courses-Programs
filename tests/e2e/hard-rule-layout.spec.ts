// Hard product rule (architecture rule 3, owner decisions 19.10 / 19.12), node by node in the
// browser on the production build. GraphCanvas exposes a read-only `__courseMapLayout` getter in
// every build (the geometry and topology of the last drawn frame). For each selection, on the real
// data at both desktop frames:
//   - no column has a second track and no labelled (chain) node sits in one;
//   - the chain labels of a column are one vertical list: one dot x, rows that never overlap;
//   - every visible layout edge runs strictly left to right (col and dot x), never inside a column;
//   - every dot lies inside its own column box.
import type { Page } from '@playwright/test'
import type { Geometry, Topology } from '../../src/graph/types'
import { courseStrip, expect, openApp, programStrip, test, waitForCanvasIdle } from './fixtures'

type DiagnosticsWindow = Window & { __courseMapLayout?: { geometry: Geometry; topology: Topology } }

interface LayoutReport {
  /** Display class of the selected course (null without one). */
  focusCls: string | null
  labelled: number
  wrappedColumns: number[]
  secondTrack: string[]
  /** Columns whose labelled nodes do not share one dot x: "col: x1 / x2 (codes)". */
  splitColumns: string[]
  /** Labelled rows of one cell (track) whose boxes overlap vertically. */
  overlappingRows: string[]
  /** Visible layout edges that do not run strictly left to right. */
  backwardEdges: string[]
  /** Visible dots outside their column box. */
  outsideColumn: string[]
  visibleEdges: number
}

async function layoutReport(page: Page, focusCode: string | null): Promise<LayoutReport> {
  await page.waitForFunction(() => !!(window as DiagnosticsWindow).__courseMapLayout, undefined, { timeout: 5000 })
    .catch(() => { throw new Error('__courseMapLayout is missing: GraphCanvas exposes it once a frame is drawn') })
  return page.evaluate(focusCode => {
    const { geometry: g, topology: t } = (window as DiagnosticsWindow).__courseMapLayout!
    const EPS = 0.5
    const labelled = (i: number) => g.nodes[i].cls === 'full' || g.nodes[i].cls === 'compact'
    const visible = (i: number) => g.nodes[i].cls !== 'hidden' && !g.nodes[i].overflow
    const code = (i: number) => t.nodes[i].code
    const report = {
      focusCls: null as string | null,
      labelled: 0,
      wrappedColumns: [] as number[],
      secondTrack: [] as string[],
      splitColumns: [] as string[],
      overlappingRows: [] as string[],
      backwardEdges: [] as string[],
      outsideColumn: [] as string[],
      visibleEdges: 0,
    }
    if (focusCode) {
      const focus = t.indexById.get(`UTM:${focusCode}`)
      report.focusCls = focus === undefined ? 'missing' : g.nodes[focus].cls
    }
    g.columns.forEach((column, c) => {
      if (column.tracks > 1) report.wrappedColumns.push(c)
    })
    const byColumn = new Map<number, number[]>()
    const byCell = new Map<string, number[]>()
    t.nodes.forEach((node, i) => {
      if (visible(i)) {
        const column = g.columns[node.col]
        const box = g.nodes[i]
        if (box.cx < column.x - EPS || box.cx > column.x + column.w + EPS) report.outsideColumn.push(`${node.code} (col ${node.col})`)
      }
      if (!labelled(i)) return
      report.labelled += 1
      if (g.nodes[i].track > 0) report.secondTrack.push(`${node.code} (col ${node.col}, track ${g.nodes[i].track})`)
      byColumn.set(node.col, [...(byColumn.get(node.col) ?? []), i])
      const cell = `${node.lane}:${node.col}:${g.nodes[i].track}`
      byCell.set(cell, [...(byCell.get(cell) ?? []), i])
    })
    for (const [col, members] of byColumn) {
      const xs = [...new Set(members.map(i => Math.round(g.nodes[i].cx * 10) / 10))].sort((a, b) => a - b)
      if (xs.length > 1) {
        const sample = xs.map(x => code(members.find(i => Math.round(g.nodes[i].cx * 10) / 10 === x)!)).join(', ')
        report.splitColumns.push(`col ${col}: x ${xs.join(' / ')} (${sample})`)
      }
    }
    for (const members of byCell.values()) {
      const rows = [...members].sort((a, b) => g.nodes[a].y - g.nodes[b].y)
      for (let k = 1; k < rows.length; k += 1) {
        const above = g.nodes[rows[k - 1]]
        const below = g.nodes[rows[k]]
        if (above.y + above.h > below.y + EPS) report.overlappingRows.push(`${code(rows[k - 1])} / ${code(rows[k])}`)
      }
    }
    for (const edge of t.edges) {
      if (!visible(edge.from) || !visible(edge.to)) continue
      report.visibleEdges += 1
      const from = t.nodes[edge.from]
      const to = t.nodes[edge.to]
      if (from.col >= to.col || g.nodes[edge.from].cx >= g.nodes[edge.to].cx - EPS) {
        report.backwardEdges.push(`${from.code} (col ${from.col}, x ${g.nodes[edge.from].cx}) → ${to.code} (col ${to.col}, x ${g.nodes[edge.to].cx})`)
      }
    }
    return report
  }, focusCode)
}

const CLEAN = { wrappedColumns: [], secondTrack: [], splitColumns: [], overlappingRows: [], backwardEdges: [], outsideColumn: [] }

for (const code of ['ECO200Y5', 'CSC148H5', 'SOC221H5'] as const) {
  test(`${code}: chain labels form one vertical list per column, every edge runs left to right`, async ({ page }, testInfo) => {
    await openApp(page, `#/utm?course=${code}`)
    await expect(courseStrip(page)).toContainText(code)
    await waitForCanvasIdle(page)
    const report = await layoutReport(page, code)
    testInfo.annotations.push({ type: 'layout', description: `${code}: ${report.labelled} labelled nodes, ${report.visibleEdges} visible edges` })
    expect(report.focusCls).toBe('full')
    expect(report.labelled).toBeGreaterThan(10)
    expect(report).toMatchObject(CLEAN)
  })
}

test('program ERMAJ1688: program labels form one vertical list per column', async ({ page }) => {
  await openApp(page, '#/utm?program=ERMAJ1688')
  await expect(programStrip(page)).toBeVisible()
  await waitForCanvasIdle(page)
  const report = await layoutReport(page, null)
  expect(report.labelled).toBeGreaterThan(10)
  expect(report).toMatchObject(CLEAN)
})

test('the overview wraps tall cells (the probe sees tracks) and still runs every edge left to right', async ({ page }) => {
  await openApp(page, '', { prefs: { onboarded: true } })
  const report = await layoutReport(page, null)
  // Tracks exist in the overview only (8.4), so the selection checks above are not vacuous.
  expect(report.wrappedColumns.length).toBeGreaterThan(0)
  expect(report.secondTrack.length).toBeGreaterThan(0)
  expect(report.visibleEdges).toBeGreaterThan(4000)
  expect(report.backwardEdges).toEqual([])
  expect(report.outsideColumn).toEqual([])
  expect(report.overlappingRows).toEqual([])
})
