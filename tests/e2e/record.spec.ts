// The local student record (design-spec 6.7.1, 6.7.3, 7.2, 14): saved only in this browser under
// uoft-course-map:profile:v1, it survives reloads and drives the "available now" glyph.
import type { Page } from '@playwright/test'
import { expect, openApp, PROFILE_KEY, snap, storedRecord, test, waitForCanvasIdle, waitForMap } from './fixtures'

const courseTab = (page: Page) => page.getByRole('tabpanel', { name: 'Course', exact: true })

test('marking CSC108H5 completed persists across reload and makes CSC148H5 available', async ({ page }, testInfo) => {
  await openApp(page, '#/utm?course=CSC108H5')
  const control = courseTab(page).getByRole('radiogroup', { name: 'Your record for CSC108H5' })
  await expect(control.getByRole('radio', { name: 'Not taken' })).toHaveAttribute('aria-checked', 'true')
  expect(await storedRecord(page)).toBeNull()

  await control.getByRole('radio', { name: 'Completed' }).click()
  await expect(control.getByRole('radio', { name: 'Completed' })).toHaveAttribute('aria-checked', 'true')
  expect(await storedRecord(page)).toEqual({ schemaVersion: 1, courses: [{ id: 'UTM:CSC108H5', status: 'completed' }] })
  await expect(page.getByRole('tab', { name: 'My courses (1)', exact: true })).toBeVisible()

  // CSC148H5 needs only CSC108H5, so its chip turns "available now" (green ring, 7.2).
  const unlocks = courseTab(page).getByRole('group', { name: 'Courses that CSC108H5 unlocks' }).getByRole('group', { name: /^Unlocks directly/ })
  const chip = unlocks.getByRole('button', { name: /^CSC148H5/ })
  await expect(chip).toHaveAccessibleName(/Available now/)
  await expect(chip.locator('.rp-glyph-ring')).toHaveCount(1)

  await page.reload()
  await waitForMap(page)
  expect(await page.evaluate(key => localStorage.getItem(key), PROFILE_KEY)).not.toBeNull()
  expect(await storedRecord(page)).toEqual({ schemaVersion: 1, courses: [{ id: 'UTM:CSC108H5', status: 'completed' }] })
  const reloaded = courseTab(page).getByRole('radiogroup', { name: 'Your record for CSC108H5' })
  await expect(reloaded.getByRole('radio', { name: 'Completed' })).toHaveAttribute('aria-checked', 'true')
  const reloadedChip = courseTab(page).getByRole('group', { name: 'Courses that CSC108H5 unlocks' })
    .getByRole('group', { name: /^Unlocks directly/ }).getByRole('button', { name: /^CSC148H5/ })
  await expect(reloadedChip).toHaveAccessibleName(/Available now/)
  await expect(reloadedChip.locator('.rp-glyph-ring')).toHaveCount(1)

  // On CSC148H5's own tab the needed course shows the completed glyph state.
  await reloadedChip.click()
  await expect(page).toHaveURL(/#\/utm\?course=CSC148H5$/)
  await expect(courseTab(page).getByRole('heading', { level: 2 })).toHaveText('Introduction to Computer Science')
  const needed = courseTab(page).getByRole('group', { name: 'Prerequisites of CSC148H5' }).getByRole('button', { name: /^CSC108H5/ })
  await expect(needed).toHaveAccessibleName(/Completed/)
  // The Course tab keeps the new title focused after a chip pick (keyboard users keep their place).
  await expect(courseTab(page).getByRole('heading', { level: 2 })).toBeFocused()

  // My courses lists the record.
  await page.getByRole('tab', { name: 'My courses (1)', exact: true }).click()
  const record = page.getByRole('tabpanel', { name: 'My courses (1)', exact: true })
  await expect(record.getByRole('combobox', { name: /CSC108H5/ })).toHaveValue('completed')
  await waitForCanvasIdle(page)
  await snap(page, testInfo, 'record')
})

test('a stored record from an earlier build is migrated to profile:v1', async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('e2e-seeded')) return
    sessionStorage.setItem('e2e-seeded', '1')
    localStorage.setItem('uoft-course-map:record:v1', JSON.stringify({ schemaVersion: 1, courses: [{ id: 'UTM:MAT102H5', status: 'planned' }] }))
  })
  await openApp(page)
  expect(await storedRecord(page)).toEqual({ schemaVersion: 1, courses: [{ id: 'UTM:MAT102H5', status: 'planned' }] })
  expect(await page.evaluate(() => localStorage.getItem('uoft-course-map:record:v1'))).toBeNull()
  await expect(page.getByRole('tab', { name: 'My courses (1)', exact: true })).toBeVisible()
})
