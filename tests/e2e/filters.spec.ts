// Toolbar filters (design-spec 6.4, 19.4): Hide unrelated collapses lanes without chain courses,
// a level chip solos its band.
import type { Page } from '@playwright/test'
import { bandLabels, courseStrip, expect, laneRows, mapRegion, openApp, snap, test, toggleView, waitForCanvasIdle } from './fixtures'

const toolbar = (page: Page) => page.getByRole('group', { name: 'Map filters and view' })

test('Hide unrelated is disabled until something is selected', async ({ page }) => {
  await openApp(page)
  const inline = toolbar(page).getByRole('button', { name: 'Hide unrelated', exact: true })
  if (await inline.isVisible()) {
    await expect(inline).toHaveAttribute('aria-disabled', 'true')
  } else {
    await toolbar(page).getByRole('button', { name: /^View/ }).click()
    await expect(page.getByRole('menuitemcheckbox', { name: 'Hide unrelated' })).toHaveAttribute('aria-disabled', 'true')
    await page.keyboard.press('Escape')
  }
})

test('Hide unrelated collapses lanes with nothing on the chain', async ({ page }, testInfo) => {
  await openApp(page, '#/utm?course=CSC148H5')
  await expect(courseStrip(page)).toBeVisible()
  await expect(laneRows(page)).toHaveCount(70)
  const corner = mapRegion(page).locator('.gc-corner')
  await expect(corner).toContainText(/\d+ with chain courses/)
  const chainLanes = Number(/(\d+) with chain courses/.exec((await corner.textContent()) ?? '')?.[1])
  expect(chainLanes).toBeGreaterThan(1)
  expect(chainLanes).toBeLessThan(70)

  expect(await toggleView(page, 'Hide unrelated')).toBe(true)
  // Only lanes holding chain courses keep a row; the others collapse to 0 px.
  await expect(laneRows(page)).toHaveCount(chainLanes)
  await expect(mapRegion(page).locator('.gc-lane-name', { hasText: /^Computer Science$/ })).toHaveCount(1)
  await expect(page.getByText(new RegExp(`${chainLanes} of 70 subjects`))).toBeVisible()
  await waitForCanvasIdle(page)
  await snap(page, testInfo, 'hide-unrelated')

  expect(await toggleView(page, 'Hide unrelated')).toBe(false)
  await expect(laneRows(page)).toHaveCount(70)
})

test('the 300 level chip hides the other level bands', async ({ page }) => {
  // A returning visitor: the first-visit start strip would take the card meta's place (6.3).
  await openApp(page, '', { prefs: { onboarded: true } })
  await expect(bandLabels(page)).toHaveCount(4)
  const chip = toolbar(page).getByRole('button', { name: /^300, [\d,]+ courses$/ })
  const count = /^300, ([\d,]+) courses$/.exec((await chip.getAttribute('aria-label')) ?? '')?.[1]
  await chip.click()

  await expect(chip).toHaveAttribute('aria-pressed', 'true')
  await expect(toolbar(page).getByRole('button', { name: 'All', exact: true })).toHaveAttribute('aria-pressed', 'false')
  await expect(bandLabels(page)).toHaveCount(1)
  await expect(bandLabels(page).first()).toContainText('300 level')
  await expect(page.getByText(`${count} of 2,491 courses shown`)).toBeVisible()

  // Clicking the soloed level again (or All) restores every band.
  await toolbar(page).getByRole('button', { name: 'All', exact: true }).click()
  await expect(bandLabels(page)).toHaveCount(4)
  await expect(chip).toHaveAttribute('aria-pressed', 'false')
})
