// Axe scans (design-spec 12): zero serious or critical violations on the landing, a selection, the
// program panel and the record panel, in the light and the dark theme.
import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'
import { expect, openApp, programStrip, test, waitForCanvasIdle, type OpenOptions, type StoredRecord } from './fixtures'

const RECORD: StoredRecord = {
  schemaVersion: 1,
  courses: [
    { id: 'UTM:CSC108H5', status: 'completed', grade: 82 },
    { id: 'UTM:CSC148H5', status: 'inProgress' },
    { id: 'UTM:MAT102H5', status: 'planned' },
  ],
}

interface Scene {
  name: string
  hash: string
  options?: OpenOptions
  /** Brings the page into the scanned state once the map is ready. */
  prepare?(page: Page): Promise<void>
}

const SCENES: Scene[] = [
  {
    name: 'landing',
    hash: '',
  },
  {
    name: 'selection',
    hash: '#/utm?course=CSC148H5',
    async prepare(page) {
      const tab = page.getByRole('tabpanel', { name: 'Course', exact: true })
      await expect(tab.getByRole('heading', { level: 2 })).toHaveText('Introduction to Computer Science')
      // Wait for the lazily loaded description (details.json) so the scan sees the finished tab.
      await expect(tab.locator('[aria-busy="true"]')).toHaveCount(0)
    },
  },
  {
    name: 'program',
    hash: '#/utm?program=ERMAJ1688',
    options: { record: RECORD },
    async prepare(page) {
      await expect(programStrip(page)).toBeVisible()
      await expect(page.getByRole('tabpanel', { name: 'Program', exact: true }).getByRole('region', { name: /^Completion/ })).toBeVisible()
    },
  },
  {
    name: 'record',
    hash: '',
    options: { record: RECORD, prefs: { onboarded: true } },
    async prepare(page) {
      await page.getByRole('banner').getByRole('button', { name: /^My courses/ }).click()
      const tab = page.getByRole('tabpanel', { name: 'My courses (3)', exact: true })
      await expect(tab.getByRole('combobox', { name: /CSC108H5/ })).toBeVisible()
    },
  },
]

for (const theme of ['light', 'dark'] as const) {
  for (const scene of SCENES) {
    test(`axe: ${scene.name} (${theme})`, async ({ page }, testInfo) => {
      const prefs = { ...scene.options?.prefs, theme }
      await openApp(page, scene.hash, { ...scene.options, prefs })
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
      await scene.prepare?.(page)
      await waitForCanvasIdle(page)

      const results = await new AxeBuilder({ page }).analyze()
      expect(results.passes.length, 'axe evaluated the page').toBeGreaterThan(20)
      const minor = results.violations.filter(violation => violation.impact !== 'serious' && violation.impact !== 'critical')
      if (minor.length) {
        const description = minor.map(violation => `${violation.impact} ${violation.id} (${violation.nodes.length})`).join(', ')
        testInfo.annotations.push({ type: 'axe (non-blocking)', description })
        console.log(`[axe ${testInfo.project.name}] ${scene.name} (${theme}): ${description}`)
      }
      const blocking = results.violations.filter(violation => violation.impact === 'serious' || violation.impact === 'critical')
      const report = blocking.map(violation => `${violation.impact} ${violation.id}: ${violation.help}\n${violation.nodes
        .slice(0, 6).map(node => `    ${node.target.join(' ')} — ${node.failureSummary?.split('\n').slice(1).join(' ')}`).join('\n')}`)
      expect(report, 'serious or critical axe violations').toEqual([])
    })
  }
}
