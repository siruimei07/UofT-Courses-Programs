// Program mode (design-spec 6.7.2, 7.3): picked from the header search, it highlights the program's
// courses on the map and the Program tab lists its admission and completion groups.
import { expect, mapRegion, openApp, pickFromSearch, programStrip, searchBox, searchResults, snap, test, waitForCanvasIdle } from './fixtures'

test('picking "Computer Science Major" from search enters program mode', async ({ page }, testInfo) => {
  await openApp(page)
  await pickFromSearch(page, 'Computer Science Major', /^Computer Science - Major \(Science\)\s*Major · ERMAJ1688$/)

  await expect(page).toHaveURL(/#\/utm\?program=ERMAJ1688$/)

  // Card head: the program context strip with the number of program courses on the map.
  const strip = programStrip(page)
  await expect(strip).toContainText('Computer Science - Major (Science)')
  await expect(strip).toContainText(/\d+ program courses on the map/)
  const onMap = Number(/(\d+) program courses on the map/.exec((await strip.textContent()) ?? '')?.[1] ?? '0')
  expect(onMap).toBeGreaterThan(10)

  // The header names the active program.
  await expect(page.getByRole('banner').getByRole('button', { name: 'Computer Science - Major (Science)' })).toBeVisible()

  // The map highlights the program: the corner and lane column count program courses.
  const map = mapRegion(page)
  await expect(map.locator('.gc-corner')).toContainText(/\d+ with program courses/)
  const cscLane = map.locator('.gc-lane').filter({ has: page.locator('.gc-lane-name', { hasText: /^Computer Science$/ }) })
  await expect(cscLane).toContainText(/[1-9]\d* in program/)
  const programLanes = await map.locator('.gc-lane .gc-counts', { hasText: /[1-9]\d* in program/ }).count()
  expect(programLanes).toBeGreaterThanOrEqual(2)

  // Program tab: title, progress, Take next, and the admission / completion groups.
  await expect(page.getByRole('tab', { name: 'Program', exact: true })).toHaveAttribute('aria-selected', 'true')
  const tab = page.getByRole('tabpanel', { name: 'Program', exact: true })
  await expect(tab.getByRole('heading', { level: 2 })).toHaveText('Computer Science - Major (Science)')
  await expect(tab.getByRole('progressbar', { name: /^Completed 0 of \d+ listed courses$/ })).toBeVisible()
  await expect(tab.getByRole('heading', { name: 'Take next' })).toBeVisible()
  const admission = tab.getByRole('region', { name: /^Admission/ })
  const completion = tab.getByRole('region', { name: /^Completion/ })
  await expect(admission).toBeVisible()
  await expect(completion).toBeVisible()
  expect(await admission.getByRole('listitem').count()).toBeGreaterThan(0)
  expect(await completion.getByRole('listitem').count()).toBeGreaterThan(0)
  // Group cards carry the program's course chips.
  await expect(tab.getByRole('button', { name: /^CSC148H5/ }).first()).toBeVisible()

  await waitForCanvasIdle(page)
  await snap(page, testInfo, 'program')
})

for (const lang of ['en', 'zh'] as const) {
  test(`the header keeps every control in the window in program mode (${lang})`, async ({ page }) => {
    // Regression (visual QA): the program name pill pushed the theme control out of the window.
    await openApp(page, '#/utm?program=ERMAJ1688', { prefs: { lang } })
    await expect(page.locator('.hbtn-program')).toBeVisible()
    const fit = await page.evaluate(() => {
      const header = document.querySelector<HTMLElement>('.header')!
      const controls = [...header.querySelectorAll<HTMLElement>('.seg')]
      return {
        overflow: header.scrollWidth - header.clientWidth,
        right: Math.max(...controls.map(el => el.getBoundingClientRect().right)),
        width: window.innerWidth,
      }
    })
    expect(fit.overflow).toBeLessThanOrEqual(0)
    expect(fit.right).toBeLessThanOrEqual(fit.width - 12)
    // The full name stays available in the tooltip while the pill shows an ellipsis.
    await expect(page.locator('.hbtn-group')).toHaveAttribute('title', /Computer Science - Major \(Science\)/)
  })
}

test('program groups read as pathways: each heading once, never repeated as a card', async ({ page }) => {
  // Regression (student QA 5): heading-only groups repeated their heading as the body with a
  // "check" badge, and the three admission pathways were one flat list.
  await openApp(page, '#/utm?program=ERMAJ1688')
  const tab = page.getByRole('tabpanel', { name: 'Program', exact: true })
  const admission = tab.getByRole('region', { name: /^Admission/ })
  const heading = 'For students admitted through the CMP1 admission category in Fall 2026 and beyond:'
  await expect(admission.getByRole('heading', { level: 4, name: heading })).toHaveCount(1)
  await expect(admission.getByRole('listitem').filter({ hasText: heading })).toHaveCount(0)
  // The intro that names the pathways is a card under the category heading.
  await expect(admission.getByRole('listitem').filter({ hasText: 'There are three pathways to entry' })).toHaveCount(1)
  // The progress count says what it counts.
  await expect(tab.getByText(/alternatives and other pathways included/)).toBeVisible()
})

test('typing straight into the auto-focused search finds programs', async ({ page }) => {
  // Regression (app-shell review 1): the first-visit autofocus must not stop programs.json loading.
  await openApp(page)
  await expect(searchBox(page)).toBeFocused()
  await page.keyboard.type('computer science')
  await expect(searchResults(page).getByRole('option', { name: /^Computer Science - Major \(Science\)/ })).toBeVisible()
  await expect(page.getByText('Loading programs…')).toHaveCount(0)
})

test('a failed programs.json load says so and the retry recovers', async ({ page, consoleErrors }) => {
  // Regression (app-shell review 2): a failed load is reported and retried, never "Loading…" forever.
  let fail = true
  await page.route('**/data/utm/programs.json', route => (fail ? route.fulfill({ status: 500, body: 'unavailable' }) : route.fallback()))
  await openApp(page)
  await page.keyboard.type('computer science')
  const unavailable = page.getByText('Programs unavailable —')
  await expect(unavailable).toBeVisible()
  await expect(page.getByText('Loading programs…')).toHaveCount(0)

  fail = false
  await page.getByRole('button', { name: 'retry' }).click()
  await expect(searchResults(page).getByRole('option', { name: /^Computer Science - Major \(Science\)/ })).toBeVisible()
  await expect(unavailable).toHaveCount(0)
  // The browser logs the deliberate 500; nothing else may appear.
  const unexpected = consoleErrors.filter(error => !/status of 500/.test(error))
  consoleErrors.splice(0, consoleErrors.length, ...unexpected)
})

test('selecting a course inside program mode keeps the program and its tab', async ({ page }) => {
  await openApp(page, '#/utm?program=ERMAJ1688')
  await expect(programStrip(page)).toBeVisible()
  const tab = page.getByRole('tabpanel', { name: 'Program', exact: true })
  await tab.getByRole('button', { name: /^CSC148H5/ }).first().click()
  await expect(page).toHaveURL(/#\/utm\?course=CSC148H5&program=ERMAJ1688$/)
  await expect(page.getByRole('tab', { name: 'Course', exact: true })).toHaveAttribute('aria-selected', 'true')
  // Clearing the course returns to program mode.
  await page.getByRole('group', { name: 'Selected course' }).getByRole('button', { name: 'Clear' }).click()
  await expect(programStrip(page)).toContainText('Computer Science - Major (Science)')
})
