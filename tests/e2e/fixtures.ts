// Shared Playwright fixtures and helpers for the end-to-end suite (design-spec 16.2). Every test
// runs in a fresh browser context, so localStorage starts empty: a plain open is a first visit.
// Every project except `motion` emulates prefers-reduced-motion: reduce (playwright.config.ts), so
// the canvas jumps straight to each end state. Selectors prefer roles and accessible names; CSS
// hooks are used only for the canvas overlays, which carry no roles (lane column, band bar, edge
// pills, live region).
import { test as base, expect, type Locator, type Page, type TestInfo } from '@playwright/test'

export { expect }

export const PREFS_KEY = 'uoft-course-map:prefs:v1'
export const PROFILE_KEY = 'uoft-course-map:profile:v1'

export interface StoredRecord {
  schemaVersion: 1
  courses: { id: string; status: 'completed' | 'inProgress' | 'planned'; grade?: number }[]
}

interface Fixtures {
  /** Console errors and uncaught page errors; the test fails at teardown if any were logged. */
  consoleErrors: string[]
}

export const test = base.extend<Fixtures>({
  consoleErrors: [async ({ page }, provide) => {
    const errors: string[] = []
    page.on('console', message => {
      if (message.type() === 'error') errors.push(`console.error: ${message.text()}`)
    })
    page.on('pageerror', error => errors.push(`pageerror: ${error.message}`))
    await provide(errors)
    expect(errors, 'no console errors or uncaught exceptions').toEqual([])
  }, { auto: true }],
})

// ---------------------------------------------------------------------------
// Opening the app

export interface OpenOptions {
  /** Preferences written to localStorage before the first load (not again on reload). */
  prefs?: Record<string, unknown>
  /** Student record written to localStorage before the first load (not again on reload). */
  record?: StoredRecord
}

/**
 * Seeds storage once per tab (a sessionStorage flag keeps reloads from re-seeding, so persistence
 * tests see what the app itself wrote), opens the app at `hash` and waits until the map is drawn.
 */
export async function openApp(page: Page, hash = '', options: OpenOptions = {}): Promise<void> {
  const seed: Record<string, string> = {}
  if (options.prefs) seed[PREFS_KEY] = JSON.stringify(options.prefs)
  if (options.record) seed[PROFILE_KEY] = JSON.stringify(options.record)
  if (Object.keys(seed).length) {
    await page.addInitScript(entries => {
      if (sessionStorage.getItem('e2e-seeded')) return
      sessionStorage.setItem('e2e-seeded', '1')
      for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, value)
    }, seed)
  }
  // Relative to baseURL (…/UofT-Courses-Programs/), so the app is served under its Pages subpath.
  await page.goto(`./${hash}`)
  await waitForMap(page)
}

/**
 * App-ready signal: the map region exists, its overlays have been laid out by the first canvas
 * frame (the lane column only gets transforms from the frame loop) and web fonts have settled.
 */
export async function waitForMap(page: Page): Promise<void> {
  await expect(mapRegion(page)).toBeVisible()
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLElement>('.gc-lane')].some(lane => lane.style.transform !== ''))
  await page.evaluate(() => document.fonts.ready.then(() => undefined))
  await waitForCanvasIdle(page)
}

/**
 * Waits until the canvas stops changing: a downsampled checksum of the canvas must stay the same
 * for several consecutive animation frames. The canvas only redraws on input or state changes,
 * so this covers framing tweens, fades and late font reflows without fixed sleeps.
 */
export async function waitForCanvasIdle(page: Page, stableFrames = 4): Promise<void> {
  await page.evaluate(async frames => {
    const canvas = document.querySelector<HTMLCanvasElement>('.gc-canvas')
    if (!canvas) return
    const probe = document.createElement('canvas')
    probe.width = 96
    probe.height = 54
    const ctx = probe.getContext('2d', { willReadFrequently: true })
    if (!ctx) return
    const checksum = () => {
      ctx.clearRect(0, 0, probe.width, probe.height)
      ctx.drawImage(canvas, 0, 0, probe.width, probe.height)
      const data = ctx.getImageData(0, 0, probe.width, probe.height).data
      let sum = 0
      for (let i = 0; i < data.length; i += 1) sum = (sum * 31 + data[i]) >>> 0
      // Overlay positions move with the view too (lane column, band labels).
      const lanes = [...document.querySelectorAll<HTMLElement>('.gc-lane')].slice(0, 12).map(lane => lane.style.transform).join('|')
      return `${sum}:${canvas.width}x${canvas.height}:${lanes}`
    }
    const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
    let last = ''
    let same = 0
    const deadline = performance.now() + 8000
    while (same < frames && performance.now() < deadline) {
      await frame()
      const next = checksum()
      same = next === last ? same + 1 : 0
      last = next
    }
  }, stableFrames)
}

// ---------------------------------------------------------------------------
// Locators

export const mapRegion = (page: Page): Locator => page.getByRole('group', { name: /Prerequisite map, 2,491 courses|先修关系图，共 2,491 门课程/ })
export const searchBox = (page: Page): Locator => page.getByRole('combobox', { name: /Search courses or programs|搜索课程或专业/ })
export const searchResults = (page: Page): Locator => page.getByRole('listbox', { name: /Search results|搜索结果/ })
export const courseStrip = (page: Page): Locator => page.getByRole('group', { name: /^(Selected course|已选课程)$/ })
export const programStrip = (page: Page): Locator => page.getByRole('group', { name: /^(Program|专业)$/ })
export const detailsPanel = (page: Page): Locator => page.getByRole('complementary', { name: /Details panel|详情面板/ })
/** The visually hidden aria-live region of the map (announces cursor moves and selections). */
export const liveRegion = (page: Page): Locator => mapRegion(page).locator('[aria-live="polite"]')
export const zoomValue = (page: Page): Locator => page.getByRole('button', { name: /^\d+%, (Reset to 100%|重置为 100%)/ })

/** Lane rows of the sticky lane column that the current geometry keeps (collapsed lanes are left out). */
export const laneRows = (page: Page): Locator => mapRegion(page).locator('.gc-lane')
/** Level band labels of the sticky band bar (one per visible band). */
export const bandLabels = (page: Page): Locator => mapRegion(page).locator('.gc-band-label')
/** Edge-of-view pill for one side; hidden (display: none) when nothing lies beyond that edge. */
export const edgePill = (page: Page, side: 'left' | 'right' | 'top' | 'bottom'): Locator => mapRegion(page).locator(`.gc-pill[data-side="${side}"]`)

/** Texts of the edge-of-view pills currently shown, e.g. "19 later unlocks →". */
export async function visiblePillTexts(page: Page): Promise<string[]> {
  return mapRegion(page).locator('.gc-pill').evaluateAll(pills => pills
    .filter(pill => (pill as HTMLElement).style.display !== 'none')
    .map(pill => pill.textContent ?? ''))
}

/** Hue in degrees (0–360) of a computed colour property, e.g. a relation dot's background. */
export async function hueOf(locator: Locator, property: 'color' | 'background-color' = 'background-color'): Promise<number> {
  const value = await locator.evaluate((element, name) => getComputedStyle(element).getPropertyValue(name), property)
  const [r, g, b] = (value.match(/\d+(\.\d+)?/g) ?? ['0', '0', '0']).slice(0, 3).map(part => Number(part) / 255)
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  if (max === min) return 0
  const d = max - min
  const hue = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return (hue * 60 + 360) % 360
}

/** Current zoom in percent, from the toolbar's zoom readout. */
export async function zoomPercent(page: Page): Promise<number> {
  const text = (await zoomValue(page).textContent()) ?? ''
  return Number(text.replace(/[^\d]/g, ''))
}

// ---------------------------------------------------------------------------
// Actions

/** Types into the header search and picks the option whose accessible name matches. */
export async function pickFromSearch(page: Page, query: string, option: RegExp): Promise<void> {
  const input = searchBox(page)
  await input.click()
  await input.fill(query)
  const row = searchResults(page).getByRole('option', { name: option }).first()
  await expect(row).toBeVisible()
  await row.click()
}

/**
 * Presses a map toggle by name. Wide frames show the toggles inline (buttons with aria-pressed);
 * standard and compact frames, or a wide window without room, put them in the View menu.
 * Returns the control's new pressed state.
 */
export async function toggleView(page: Page, name: string): Promise<boolean> {
  const toolbar = page.getByRole('group', { name: /^(Map filters and view|筛选与视图)$/ })
  const inline = toolbar.getByRole('button', { name, exact: true })
  if (await inline.isVisible()) {
    await inline.click()
    return (await inline.getAttribute('aria-pressed')) === 'true'
  }
  await toolbar.getByRole('button', { name: /^(View|视图)/ }).click()
  const item = page.getByRole('menuitemcheckbox', { name, exact: true })
  await item.click()
  const checked = (await item.getAttribute('aria-checked')) === 'true'
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu', { name: /^(View|视图)$/ })).toBeHidden()
  return checked
}

/** Reads the stored student record (null when nothing is stored). */
export async function storedRecord(page: Page): Promise<StoredRecord | null> {
  return page.evaluate(key => {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) as StoredRecord : null
  }, PROFILE_KEY)
}

/** Reads the stored preferences (empty object when nothing is stored). */
export async function storedPrefs(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, unknown>, PREFS_KEY)
}

/** Saves a full-page screenshot next to the test's output and attaches it to the report. */
export async function snap(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const path = testInfo.outputPath(`${name}.png`)
  await page.screenshot({ path })
  await testInfo.attach(name, { path, contentType: 'image/png' })
}

/** The project's frame class, from the configured viewport (spec 6.1). */
export function frameOf(testInfo: TestInfo): 'wide' | 'standard' {
  return (testInfo.project.use.viewport?.width ?? 0) >= 1700 ? 'wide' : 'standard'
}
