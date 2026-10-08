// Course selection: search, hash deep links, readouts, the Course tab, clearing by clicking empty
// plot, the Esc ladder (design-spec 6.3, 6.7.1, 10.2, 10.4, 11.3) and the 10.2 framing targets.
import type { Page } from '@playwright/test'
import {
  courseStrip, edgePill, expect, frameOf, hueOf, laneRows, liveRegion, mapRegion, openApp, pickFromSearch, programStrip, searchBox,
  searchResults, snap, storedRecord, test, visiblePillTexts, waitForCanvasIdle, zoomPercent,
} from './fixtures'

const courseTab = (page: Page) => page.getByRole('tabpanel', { name: 'Course', exact: true })

test('searching "csc148" selects CSC148H5 with its readout and Course tab', async ({ page }, testInfo) => {
  await openApp(page)
  await pickFromSearch(page, 'csc148', /^CSC148H5\s*Introduction to Computer Science/)

  await expect(page).toHaveURL(/#\/utm\?course=CSC148H5$/)
  // A pick moves focus to the map so keyboard users keep their place.
  await expect(mapRegion(page)).toBeFocused()

  // Card head readout.
  const strip = courseStrip(page)
  await expect(strip).toContainText('CSC148H5')
  await expect(strip).toContainText('Introduction to Computer Science')
  await expect(strip).toContainText('Needs 1 directly · 1 in total')
  await expect(strip).toContainText(/Unlocks \d+ directly · \d+ in total/)
  await expect(page.getByText(/^Start here:/)).toHaveCount(0)

  // Course tab.
  await expect(page.getByRole('tab', { name: 'Course', exact: true })).toHaveAttribute('aria-selected', 'true')
  const tab = courseTab(page)
  await expect(tab.getByRole('heading', { level: 2 })).toHaveText('Introduction to Computer Science')
  const needs = tab.getByRole('group', { name: 'Prerequisites of CSC148H5' })
  await expect(needs.getByRole('group', { name: /^Needed directly/ }).getByRole('button', { name: /^CSC108H5/ })).toBeVisible()
  const unlocksDirectly = tab.getByRole('group', { name: 'Courses that CSC148H5 unlocks' }).getByRole('group', { name: /^Unlocks directly/ })
  await expect(unlocksDirectly.getByRole('button', { name: /^CSC236H5/ })).toBeVisible()

  // Relation colours: prerequisites in the blue family, unlocks in violet (card head, lane column, chips).
  const expectHue = (hue: number, family: 'blue' | 'violet', where: string) => {
    const [min, max] = family === 'blue' ? [200, 240] : [250, 295]
    expect(hue, `${where}: ${family} hue`).toBeGreaterThanOrEqual(min)
    expect(hue, `${where}: ${family} hue`).toBeLessThanOrEqual(max)
  }
  expectHue(await hueOf(strip.locator('.readout-needs .readout-dot')), 'blue', 'card head needs dot')
  expectHue(await hueOf(strip.locator('.readout-unlocks .readout-dot')), 'violet', 'card head unlocks dot')
  expectHue(await hueOf(mapRegion(page).locator('.gc-lane .gc-dot-pre').first()), 'blue', 'lane needed count')
  expectHue(await hueOf(mapRegion(page).locator('.gc-lane .gc-dot-unl').first()), 'violet', 'lane unlocked count')
  expectHue(await hueOf(needs.getByRole('button', { name: /^CSC108H5/ }).locator('svg'), 'color'), 'blue', 'CSC108H5 chip glyph')
  expectHue(await hueOf(unlocksDirectly.getByRole('button', { name: /^CSC236H5/ }).locator('svg'), 'color'), 'violet', 'CSC236H5 chip glyph')

  // Lanes with nothing on the chain shrink to slim rows of grey minimal dots (8.2 / 8.5).
  const lane = (name: string) => laneRows(page).filter({ has: page.locator('.gc-lane-name', { hasText: new RegExp(`^${name}$`) }) })
  await expect(lane('Earth Science')).toHaveClass(/\bis-slim\b/)
  await expect(lane('Computer Science')).not.toHaveClass(/\bis-slim\b/)

  // Screen-reader announcement of the selection (spec 12).
  await expect(liveRegion(page)).toHaveText(/^Selected CSC148H5\. Needs 1 directly, 1 in total\. Unlocks \d+ directly, \d+ in total\.$/)
  await waitForCanvasIdle(page)
  await snap(page, testInfo, 'csc148')
})

test('a hash deep link selects MAT232H5 with a "1 of 4" readout', async ({ page }) => {
  await openApp(page, '#/utm?course=MAT232H5')

  const strip = courseStrip(page)
  await expect(strip).toContainText('MAT232H5')
  await expect(strip).toContainText(/Needs 1 of 4 directly · \d+ related in total/)
  await expect(searchBox(page)).not.toBeFocused()

  const tab = courseTab(page)
  await expect(tab.getByRole('heading', { level: 2 })).toHaveText('Calculus of Several Variables I')
  const direct = tab.getByRole('group', { name: 'Prerequisites of MAT232H5' }).getByRole('group', { name: /^Needed directly/ })
  for (const code of ['MAT134H5', 'MAT136H5', 'MAT139H5', 'MAT159H5']) {
    await expect(direct.getByRole('button', { name: new RegExp(`^${code}`) })).toBeVisible()
  }
  // References the calendar does not offer are listed, never drawn (spec 15, D4).
  const missing = tab.getByRole('list', { name: 'Not in this calendar' })
  await expect(missing).toContainText('MAT137Y5')
  await expect(missing).toContainText('MAT157Y5')
})

test('clicking an empty part of the plot clears the selection', async ({ page }) => {
  await openApp(page, '#/utm?course=CSC148H5')
  await expect(courseStrip(page)).toBeVisible()
  await waitForCanvasIdle(page)

  const canvas = mapRegion(page).locator('canvas')
  const box = (await canvas.boundingBox())!
  // Plot = canvas minus the 176 px lane column and the 60 px band bar. Probe a grid for points
  // where the canvas shows no pointer cursor (no course under the mouse), then click one.
  const candidates: { x: number; y: number }[] = []
  for (let y = box.y + 60 + 30; y < box.y + box.height - 30; y += 47) {
    for (let x = box.x + 176 + 30; x < box.x + box.width - 40; x += 83) candidates.push({ x, y })
  }
  let cleared = false
  for (const point of candidates) {
    await page.mouse.move(point.x, point.y)
    const cursor = await canvas.evaluate(element => (element as HTMLCanvasElement).style.cursor)
    if (cursor === 'pointer') continue
    await page.mouse.click(point.x, point.y)
    // A click on an "any of" junction glyph is not empty plot; such a click keeps the selection.
    const gone = await expect(courseStrip(page)).toHaveCount(0, { timeout: 1500 }).then(() => true, () => false)
    if (gone) {
      cleared = true
      break
    }
  }
  expect(cleared, 'an empty plot click cleared the selection').toBe(true)
  await expect(page).toHaveURL(/#\/utm$/)
  await expect(liveRegion(page)).toHaveText('Selection cleared.')
})

test('Esc ladder: popover, then search, then course, then program; never the record', async ({ page }) => {
  await openApp(page, '#/utm?course=CSC148H5&program=ERMAJ1688', {
    record: { schemaVersion: 1, courses: [{ id: 'UTM:CSC108H5', status: 'completed' }] },
  })
  await expect(courseStrip(page)).toContainText('CSC148H5')
  const programButton = page.getByRole('banner').getByRole('button', { name: 'Computer Science - Major (Science)' })
  await expect(programButton).toBeVisible()

  // Rung 1: an open popover (shortcuts help) closes first.
  await page.keyboard.press('?')
  const help = page.getByRole('dialog', { name: 'Keyboard shortcuts' })
  await expect(help).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(help).toHaveCount(0)
  await expect(courseStrip(page)).toBeVisible()

  // Rung 2: in search, the result list closes, then the text clears and the field is left.
  await page.keyboard.press('/')
  await searchBox(page).fill('mat')
  await expect(searchResults(page)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(searchResults(page)).toHaveCount(0)
  await expect(searchBox(page)).toHaveValue('mat')
  await expect(searchBox(page)).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(searchBox(page)).toHaveValue('')
  await expect(searchBox(page)).not.toBeFocused()
  await expect(courseStrip(page)).toBeVisible()

  // Rung 3: the course selection.
  await page.keyboard.press('Escape')
  await expect(courseStrip(page)).toHaveCount(0)
  await expect(page).toHaveURL(/#\/utm\?program=ERMAJ1688$/)
  await expect(programStrip(page)).toContainText('Computer Science - Major (Science)')

  // Rung 4: the program, only once no course is selected.
  await page.keyboard.press('Escape')
  await expect(programStrip(page)).toHaveCount(0)
  await expect(page).toHaveURL(/#\/utm$/)
  await expect(programButton).toHaveCount(0)

  // Further Esc presses change nothing; the record is never cleared.
  await page.keyboard.press('Escape')
  expect(await storedRecord(page)).toEqual({ schemaVersion: 1, courses: [{ id: 'UTM:CSC108H5', status: 'completed' }] })
  await expect(page.getByRole('tab', { name: 'My courses (1)', exact: true })).toBeVisible()
})

test('an unparsed prerequisite rule calls its courses "listed", not "needed" (CSC207H5, 7.4)', async ({ page }) => {
  // Regression (student QA 4): "CSC111H5 or CSC148H5" could not be parsed, yet the panel and the
  // legend said both were "Needed directly".
  await openApp(page, '#/utm?course=CSC207H5')
  await expect(courseTab(page).getByText('Listed in the requirement (see official text)')).toBeVisible()
  await expect(courseTab(page).getByText('Needed directly', { exact: true })).toHaveCount(0)
  const legend = page.getByRole('group', { name: 'Legend' })
  await expect(legend.locator('.legend-items')).toContainText('Listed in the requirement text')
  await expect(legend.locator('.legend-items')).not.toContainText('Needed directly')
  await expect(legend).not.toContainText('Any one of these')
})

test.describe('framing targets (10.2)', () => {
  test('CSC148H5 frames its chain at 92 % or more', async ({ page }, testInfo) => {
    await openApp(page, '#/utm?course=CSC148H5')
    await waitForCanvasIdle(page)
    expect(await zoomPercent(page)).toBeGreaterThanOrEqual(92)
    // CSC108H5 is never cut off: no pill counts a prerequisite.
    await expect(edgePill(page, 'left')).toBeHidden()
    for (const text of await visiblePillTexts(page)) expect(text).not.toMatch(/prerequisite/)
    if (frameOf(testInfo) === 'wide') {
      // 1920 × 1080: the full chain from 100 through 400 level fits horizontally. Vertically,
      // the LIN340H5 / LIN341H5 unlocks sit in the Linguistics lane far below the CSC lane, so a
      // "↓ n unlocks below" pill is expected with the current calendar data.
      await expect(edgePill(page, 'right')).toBeHidden()
    }
    await snap(page, testInfo, 'csc148-framing')
  })

  test('CSC148H5 meets the 10.2 table rows for its frame', async ({ page }, testInfo) => {
    // Spec 10.2 (rows revised 2026-10-08 with the vertical known limit: distant unlocks such as
    // LIN340H5 / LIN341H5 and, at 1536, STA246H5 lie below the plot in Grey-dots mode and are
    // counted by the bottom pill).
    await openApp(page, '#/utm?course=CSC148H5')
    await waitForCanvasIdle(page)
    expect(await zoomPercent(page)).toBeGreaterThanOrEqual(92)
    const pills = await visiblePillTexts(page)
    // Nothing needed is ever off screen: no pill counts a prerequisite, and no left pill.
    for (const text of pills) expect(text).not.toMatch(/prerequisite/)
    await expect(edgePill(page, 'left')).toBeHidden()
    // Whatever lies below is unlocks only, counted by the bottom pill ...
    const bottom = edgePill(page, 'bottom')
    await expect(bottom).toBeVisible()
    await expect(bottom).toContainText(/unlocks? below/)
    if (frameOf(testInfo) === 'wide') {
      // ... and at 1920 the chain spans the width: no right pill.
      await expect(edgePill(page, 'right')).toBeHidden()
      expect(pills.filter(text => !/below/.test(text))).toEqual([])
    } else {
      // At 1536 the later unlocks are counted at the right edge.
      await expect(edgePill(page, 'right')).toContainText(/later unlocks? →/)
    }
    // One click on the bottom pill pans the nearest hidden unlocks into view.
    const before = await bottom.textContent()
    await bottom.click()
    await waitForCanvasIdle(page)
    expect(await edgePill(page, 'bottom').textContent()).not.toBe(before)
  })

  test('MAT232H5 shows every prerequisite', async ({ page }, testInfo) => {
    await openApp(page, '#/utm?course=MAT232H5')
    await waitForCanvasIdle(page)
    expect(await zoomPercent(page)).toBeGreaterThanOrEqual(92)
    await expect(edgePill(page, 'left')).toBeHidden()
    for (const text of await visiblePillTexts(page)) expect(text).not.toMatch(/prerequisite/)
    await snap(page, testInfo, 'mat232-framing')
  })
})
