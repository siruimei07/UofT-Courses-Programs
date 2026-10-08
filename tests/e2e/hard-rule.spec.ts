// Hard product rule (architecture rule 3, owner decision 19.10) on the production build: while a
// course is selected no column wraps into a second track, so every chain column is one vertical
// list. The visible signal is the band bar's scale (design-spec 9.2): one segment per visible column
// with a notch at every wrapped track (BandBar renders `ColumnBox.tracks - 1` notches per segment).
// The overview wraps tall cells, so it has notches; any selection must have none. The layout
// diagnostics check the same rule node by node (`hard-rule-layout.spec.ts`).
import type { Page } from '@playwright/test'
import { courseStrip, expect, mapRegion, openApp, snap, test, waitForCanvasIdle } from './fixtures'

/** Spec 16.2 acceptance selections: a wide CSC chain, a Y course fan (ECO) and SOC's tall 300-level fan. */
const SELECTIONS = ['ECO200Y5', 'CSC148H5', 'SOC221H5'] as const

const segments = (page: Page) => mapRegion(page).locator('.gc-scale .gc-seg')
const notches = (page: Page) => mapRegion(page).locator('.gc-scale .gc-notch')

for (const code of SELECTIONS) {
  test(`${code}: no column wraps into a second track while it is selected`, async ({ page }, testInfo) => {
    await openApp(page, '', { prefs: { onboarded: true } })
    // The overview wraps its tallest cells: the probe can see tracks.
    expect(await segments(page).count()).toBeGreaterThan(10)
    expect(await notches(page).count(), 'track notches in the overview').toBeGreaterThan(0)

    await page.evaluate(selected => { window.location.hash = `#/utm?course=${selected}` }, code)
    await expect(courseStrip(page)).toContainText(code)
    await waitForCanvasIdle(page)
    await expect(segments(page).first()).toBeAttached()
    await expect(notches(page), `track notches with ${code} selected`).toHaveCount(0)
    await snap(page, testInfo, code.toLowerCase())

    // Clearing the selection brings the overview's wrapped tracks back.
    await page.evaluate(() => { window.location.hash = '#/utm' })
    await expect(courseStrip(page)).toHaveCount(0)
    await waitForCanvasIdle(page)
    expect(await notches(page).count(), 'track notches after clearing').toBeGreaterThan(0)
  })
}

test('program mode does not wrap either (ERMAJ1688)', async ({ page }) => {
  await openApp(page, '#/utm?program=ERMAJ1688')
  await expect(page.getByRole('group', { name: 'Program', exact: true })).toBeVisible()
  await waitForCanvasIdle(page)
  await expect(segments(page).first()).toBeAttached()
  await expect(notches(page)).toHaveCount(0)
})
