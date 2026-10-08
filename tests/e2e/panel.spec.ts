// Right panel host (design-spec 6.7, 12): collapsing to the rail keeps the chain list in the DOM,
// and "Details" brings the panel back with keyboard focus on the Course tab.
import { courseStrip, detailsPanel, expect, openApp, test } from './fixtures'

test('the panel collapses to its rail and Details restores it with focus on the Course tab', async ({ page }) => {
  await openApp(page, '#/utm?course=CSC148H5')
  const panel = detailsPanel(page)
  await panel.getByRole('button', { name: 'Collapse panel' }).click()

  const rail = panel.getByRole('navigation', { name: 'Collapsed panel' })
  await expect(rail).toBeVisible()
  await expect(rail.getByRole('button', { name: 'Course details · CSC148H5' })).toBeFocused()
  await expect(page.getByRole('tablist')).toBeHidden()
  // The chain list stays in the DOM while collapsed (screen-reader fallback of the map).
  expect(await panel.locator('#rp-tabpanel-course button.rp-chip').count()).toBeGreaterThan(10)

  // The card head offers Details while the panel is collapsed.
  const details = courseStrip(page).getByRole('button', { name: 'Details' })
  await details.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('tab', { name: 'Course', exact: true })).toBeVisible()
  await expect(page.getByRole('tab', { name: 'Course', exact: true })).toBeFocused()
  await expect(rail).toHaveCount(0)
  await expect(courseStrip(page).getByRole('button', { name: 'Details' })).toHaveCount(0)
})

test('panel tabs follow the arrow keys', async ({ page }) => {
  await openApp(page, '#/utm?course=CSC148H5')
  const course = page.getByRole('tab', { name: 'Course', exact: true })
  await course.focus()
  await page.keyboard.press('ArrowRight')
  const program = page.getByRole('tab', { name: 'Program', exact: true })
  await expect(program).toBeFocused()
  await expect(program).toHaveAttribute('aria-selected', 'true')
  // No program selected: the Program tab offers the searchable picker.
  await expect(page.getByRole('tabpanel', { name: 'Program', exact: true }).getByRole('searchbox', { name: /^Search \d+ programs$/ })).toBeVisible()
  await page.keyboard.press('End')
  await expect(page.getByRole('tab', { name: 'My courses', exact: true })).toBeFocused()
  await expect(page.getByRole('tabpanel', { name: 'My courses', exact: true })).toContainText('Saved only in this browser. Nothing is uploaded.')
})
