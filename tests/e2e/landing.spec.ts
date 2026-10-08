// First-visit landing (design-spec 10.1), deep links under the GitHub Pages subpath (14) and the
// keyboard model (11.3).
import {
  courseStrip, expect, laneRows, liveRegion, mapRegion, openApp, programStrip, searchBox, searchResults, snap, test,
  waitForCanvasIdle, waitForMap, zoomPercent,
} from './fixtures'

test.describe('first visit', () => {
  test('lands on the CSC lane with the start strip and a focused search', async ({ page }, testInfo) => {
    await openApp(page)

    await expect(page).toHaveTitle('UofT Course Map')
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
    await expect(page).toHaveURL(/\/UofT-Courses-Programs\/#\/utm$/)

    // Search is focused with the caret visible; the dropdown stays closed until the user types.
    await expect(searchBox(page)).toBeFocused()
    await expect(searchBox(page)).toHaveValue('')
    await expect(searchResults(page)).toHaveCount(0)

    // Start strip: the hint, the campus start subjects (UTM: CSC, MAT, STA, ECO, PSY, BIO), "All subjects…".
    await expect(page.getByText('Start here: search a course (/), pick a program, or jump to a subject:')).toBeVisible()
    for (const subject of ['CSC', 'MAT', 'STA', 'ECO', 'PSY', 'BIO']) {
      await expect(page.getByRole('button', { name: subject, exact: true })).toBeVisible()
    }
    await expect(page.getByRole('button', { name: 'All subjects…' })).toBeVisible()
    await expect(courseStrip(page)).toHaveCount(0)
    await expect(programStrip(page)).toHaveCount(0)

    // Zoom 1.0 at the left edge; the CSC lane sits at the top of the plot (plot top + 8).
    expect(await zoomPercent(page)).toBe(100)
    await expect(laneRows(page)).toHaveCount(70)
    const top = await page.evaluate(() => {
      const host = document.querySelector('.gc-lanes')!.getBoundingClientRect()
      const lanes = [...document.querySelectorAll<HTMLElement>('.gc-lane')]
        .filter(lane => lane.style.display !== 'none')
        .map(lane => ({ top: lane.getBoundingClientRect().top - host.top, subject: lane.querySelector('.gc-bullet')?.textContent ?? '' }))
        .filter(lane => lane.top >= -1)
        .sort((a, b) => a.top - b.top)
      return lanes[0]
    })
    expect(top.subject).toBe('CSC')
    expect(top.top).toBeGreaterThanOrEqual(0)
    expect(top.top).toBeLessThanOrEqual(24)

    await expect(mapRegion(page).locator('.gc-lane-name', { hasText: /^Computer Science$/ })).toBeVisible()
    await snap(page, testInfo, 'landing')
  })

  test('every lane row on screen has its height (lane bar) on load and after a long scroll', async ({ page }) => {
    // Regression (visual QA H2): lanes that were off screen at the last zoom frame kept 0 px.
    await openApp(page)
    const shortRows = () => page.evaluate(() => {
      const host = document.querySelector('.gc-lanes')!.getBoundingClientRect()
      return [...document.querySelectorAll<HTMLElement>('.gc-lane')]
        .filter(lane => lane.style.display !== 'none')
        .filter(lane => {
          const box = lane.getBoundingClientRect()
          return box.bottom > host.top && box.top < host.bottom
        })
        .filter(lane => lane.getBoundingClientRect().height < 20)
        .map(lane => lane.querySelector('.gc-bullet')?.textContent ?? '?')
    })
    expect(await shortRows()).toEqual([])
    const map = mapRegion(page)
    const box = (await map.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    for (let i = 0; i < 5; i++) await page.mouse.wheel(0, 500)
    await waitForCanvasIdle(page)
    expect(await shortRows()).toEqual([])
    // The lane bar inside each row is drawn too.
    const bars = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.gc-lane')]
      .filter(lane => lane.style.display !== 'none' && lane.getBoundingClientRect().top >= 0)
      .slice(0, 5)
      .map(lane => lane.getBoundingClientRect().height))
    for (const height of bars) expect(height).toBeGreaterThan(20)
  })

  test('the start strip jumps to a subject lane and is dismissed for later visits', async ({ page }) => {
    await openApp(page)
    await page.getByRole('button', { name: 'MAT', exact: true }).click()
    await waitForCanvasIdle(page)
    const topSubject = await page.evaluate(() => {
      const host = document.querySelector('.gc-lanes')!.getBoundingClientRect()
      return [...document.querySelectorAll<HTMLElement>('.gc-lane')]
        .filter(lane => lane.style.display !== 'none')
        .map(lane => ({ top: lane.getBoundingClientRect().top - host.top, subject: lane.querySelector('.gc-bullet')?.textContent ?? '' }))
        .filter(lane => lane.top >= -1)
        .sort((a, b) => a.top - b.top)[0]?.subject
    })
    expect(topSubject).toBe('MAT')
    await expect(page.getByText(/^Start here:/)).toHaveCount(0)

    // The jump made MAT the home lane: the next visit starts there, without the start strip.
    await page.reload()
    await waitForMap(page)
    await expect(page.getByText(/^Start here:/)).toHaveCount(0)
    await expect(searchBox(page)).not.toBeFocused()
  })
})

test.describe('deep links under the Pages subpath', () => {
  test('a course deep link survives a refresh', async ({ page }) => {
    const failed: string[] = []
    page.on('response', response => {
      if (response.status() >= 400) failed.push(`${response.status()} ${response.url()}`)
    })
    page.on('requestfailed', request => failed.push(`failed ${request.url()}`))

    await openApp(page, '#/utm?course=MAT232H5')
    await expect(courseStrip(page)).toContainText('MAT232H5')
    await expect(page.getByText(/^Start here:/)).toHaveCount(0)

    await page.reload()
    await waitForMap(page)
    await expect(page).toHaveURL(/\/UofT-Courses-Programs\/#\/utm\?course=MAT232H5$/)
    await expect(courseStrip(page)).toContainText('MAT232H5')
    await expect(page.getByRole('tabpanel', { name: 'Course', exact: true }).getByRole('heading', { level: 2 })).toHaveText('Calculus of Several Variables I')
    expect(failed).toEqual([])
  })

  test('a program deep link survives a refresh', async ({ page }) => {
    await openApp(page, '#/utm?program=ERMAJ1688')
    await expect(programStrip(page)).toContainText('Computer Science - Major (Science)')
    await page.reload()
    await waitForMap(page)
    await expect(page).toHaveURL(/#\/utm\?program=ERMAJ1688$/)
    await expect(programStrip(page)).toContainText('Computer Science - Major (Science)')
  })

  test('an unknown course code is dropped from the URL', async ({ page }) => {
    await openApp(page, '#/utm?course=ZZZ999H5')
    await expect(page).toHaveURL(/#\/utm$/)
    await expect(courseStrip(page)).toHaveCount(0)
  })

  test('hash changes after load select the course', async ({ page }) => {
    await openApp(page)
    await page.evaluate(() => { window.location.hash = '#/utm?course=CSC148H5' })
    await expect(courseStrip(page)).toContainText('CSC148H5')
  })
})

test.describe('keyboard', () => {
  test('"/" and Ctrl+K focus the search from anywhere', async ({ page }) => {
    await openApp(page, '#/utm?course=CSC148H5')
    await expect(searchBox(page)).not.toBeFocused()
    await page.keyboard.press('/')
    await expect(searchBox(page)).toBeFocused()
    // "/" is consumed by the shortcut, not typed into the field.
    await expect(searchBox(page)).toHaveValue('')

    // Esc in an empty search leaves the field.
    await page.keyboard.press('Escape')
    await expect(searchBox(page)).not.toBeFocused()
    await page.keyboard.press('Control+k')
    await expect(searchBox(page)).toBeFocused()
  })

  test('arrow keys move the keyboard cursor in the map and Enter selects', async ({ page }) => {
    await openApp(page)
    // The first visit focuses the search; Esc leaves it, the skip link moves focus to the map.
    await page.keyboard.press('Escape')
    await page.getByRole('link', { name: 'Skip to map' }).focus()
    await page.keyboard.press('Enter')
    await expect(mapRegion(page)).toBeFocused()

    const cursor = /^([A-Z]{3}\d{3}[HY]5), .+\. .+, \d00 level\.$/
    await page.keyboard.press('ArrowDown')
    await expect(liveRegion(page)).toHaveText(cursor)
    const first = (await liveRegion(page).textContent()) ?? ''

    await page.keyboard.press('ArrowDown')
    await expect(liveRegion(page)).not.toHaveText(first)
    await page.keyboard.press('ArrowRight')
    await expect(liveRegion(page)).toHaveText(cursor)
    const here = cursor.exec((await liveRegion(page).textContent()) ?? '')?.[1]
    expect(here).toBeTruthy()

    await page.keyboard.press('Enter')
    await expect(courseStrip(page)).toContainText(here!)
    await expect(liveRegion(page)).toHaveText(new RegExp(`^Selected ${here}\\. Needs \\d+ directly`))
    await expect(page).toHaveURL(new RegExp(`#/utm\\?course=${here}$`))
    await expect(mapRegion(page)).toBeFocused()
  })
})
