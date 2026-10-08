// Motion (design-spec 17, owner decision 19.13). Runs only in the `motion` project, which emulates
// prefers-reduced-motion: no-preference; every other project emulates `reduce`. An in-page recorder
// takes one canvas checksum per animation frame, so the tests see the tween itself: a click
// selection changes the canvas over many frames and then settles, a second click during the tween
// jumps it to the same end state an uninterrupted tween reaches, and under `reduce` the same click
// lands in one step, and a pointer resting on the clicked course keeps its hover through the tween.
import type { Page } from '@playwright/test'
import { courseStrip, expect, mapRegion, openApp, test, waitForCanvasIdle, waitForMap } from './fixtures'

/** Lane column and band bar sizes (design-spec 9.1, 9.2): the plot starts below and right of them. */
const LANE_COLUMN = 176
const BAND_BAR = 60

interface Frame {
  /** performance.now() of the animation frame. */
  t: number
  sum: number
}

interface FrameLog {
  frames: Frame[]
  /** performance.now() of every pointerdown since the recorder started. */
  downs: number[]
}

type RecorderWindow = Window & { __e2eRecorder?: FrameLog & { stop: boolean } }

/** Checksum of the canvas downsampled to 192 × 108 (the same probe the recorder uses). */
async function canvasSum(page: Page): Promise<number> {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('.gc-canvas')!
    const probe = document.createElement('canvas')
    probe.width = 192
    probe.height = 108
    const ctx = probe.getContext('2d', { willReadFrequently: true })!
    ctx.drawImage(canvas, 0, 0, probe.width, probe.height)
    const data = ctx.getImageData(0, 0, probe.width, probe.height).data
    let sum = 0
    for (let i = 0; i < data.length; i += 1) sum = (sum * 31 + data[i]) >>> 0
    return sum
  })
}

/**
 * Starts recording one canvas checksum per animation frame (and the time of every pointerdown).
 * The recorder's frame callback runs before the app's redraw of the same frame, so a frame's
 * checksum shows what the previous frame drew: one frame of lag, allowed for below.
 */
async function startRecorder(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as RecorderWindow
    const canvas = document.querySelector<HTMLCanvasElement>('.gc-canvas')!
    const probe = document.createElement('canvas')
    probe.width = 192
    probe.height = 108
    const ctx = probe.getContext('2d', { willReadFrequently: true })!
    const log = { frames: [] as Frame[], downs: [] as number[], stop: false }
    w.__e2eRecorder = log
    window.addEventListener('pointerdown', () => log.downs.push(performance.now()), true)
    const tick = (t: number) => {
      if (log.stop) return
      ctx.clearRect(0, 0, probe.width, probe.height)
      ctx.drawImage(canvas, 0, 0, probe.width, probe.height)
      const data = ctx.getImageData(0, 0, probe.width, probe.height).data
      let sum = 0
      for (let i = 0; i < data.length; i += 1) sum = (sum * 31 + data[i]) >>> 0
      log.frames.push({ t, sum })
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
}

/** Records until `quietMs` pass without a canvas change (failing after `maxMs`), then stops and returns the log. */
async function stopWhenSettled(page: Page, quietMs = 600, maxMs = 6000): Promise<FrameLog> {
  await page.waitForFunction(({ quietMs }) => {
    const log = (window as RecorderWindow).__e2eRecorder!
    const frames = log.frames
    const last = frames.at(-1)
    if (!last || !log.downs.length) return false
    let i = frames.length - 1
    while (i > 0 && frames[i - 1].sum === last.sum) i -= 1
    return last.t - Math.max(frames[i].t, log.downs.at(-1)!) >= quietMs
  }, { quietMs }, { timeout: maxMs, polling: 50 })
  return page.evaluate(() => {
    const log = (window as RecorderWindow).__e2eRecorder!
    log.stop = true
    return { frames: log.frames, downs: log.downs }
  })
}

/** Frames recorded after time `t` whose checksum differs from the frame before. */
function changesAfter(log: FrameLog, t: number): Frame[] {
  return log.frames.filter((frame, i) => frame.t > t && i > 0 && frame.sum !== log.frames[i - 1].sum)
}

/**
 * Finds a course dot (or label) near the top-left of the plot: the landing shows the CSC lane at
 * the top at 100 % zoom. Probes a grid for the canvas's pointer cursor (a course under the mouse).
 */
async function findCourse(page: Page): Promise<{ x: number; y: number }> {
  const canvas = mapRegion(page).locator('canvas')
  const box = (await canvas.boundingBox())!
  const hits = async (x: number, y: number) => {
    await page.mouse.move(x, y)
    return await canvas.evaluate(element => (element as HTMLCanvasElement).style.cursor) === 'pointer'
  }
  for (let y = box.y + BAND_BAR + 12; y < box.y + BAND_BAR + 160; y += 6) {
    for (let x = box.x + LANE_COLUMN + 8; x < box.x + LANE_COLUMN + 200; x += 6) {
      if (!(await hits(x, y))) continue
      // Aim at the vertical middle of the hit area, a little right of its left edge (the dot).
      let bottom = y
      while (bottom < y + 40 && await hits(x + 4, bottom + 2)) bottom += 2
      return { x: x + 4, y: Math.round((y + bottom) / 2) }
    }
  }
  throw new Error('no course under the pointer near the top-left of the plot')
}

/** Rests the mouse on `point` (hover ring settled) so runs start from identical canvases. */
async function restOn(page: Page, point: { x: number; y: number }): Promise<void> {
  await page.mouse.move(point.x + 40, point.y + 40)
  await page.mouse.move(point.x, point.y)
  await waitForCanvasIdle(page, 8)
}

const selectedCode = (page: Page) => /course=([A-Z]{3}\d{3}[HY]\d)/.exec(page.url())?.[1] ?? null

/** Waits until the recorder has seen `count` canvas changes after the first pointerdown (mid-tween). */
async function waitForTweenFrames(page: Page, count = 2): Promise<void> {
  await page.waitForFunction(count => {
    const log = (window as RecorderWindow).__e2eRecorder!
    const down = log.downs[0]
    return down !== undefined && log.frames.filter((frame, i) => frame.t > down && i > 0 && frame.sum !== log.frames[i - 1].sum).length >= count
  }, count, { polling: 'raf' })
}

interface Reference {
  point: { x: number; y: number }
  code: string
  /** Canvas checksums of the overview with the mouse resting on `point`, and of the settled selection. */
  start: number
  end: number
}

/**
 * Reference run: a click selection left to finish on its own. Then back to the same overview
 * through a reload (no animated clear), checked to start from the very same canvas.
 */
async function referenceRun(page: Page): Promise<Reference> {
  await openApp(page, '', { prefs: { onboarded: true } })
  const point = await findCourse(page)
  await restOn(page, point)
  const start = await canvasSum(page)
  await startRecorder(page)
  await page.mouse.click(point.x, point.y)
  await stopWhenSettled(page)
  const code = selectedCode(page)
  expect(code, 'the click selected a course').not.toBeNull()
  const end = await canvasSum(page)
  // At the end state the same point still hits the selected course (the click anchor keeps its
  // dot under the pointer), so a click there changes nothing: clicking the selected course is a no-op.
  await page.mouse.click(point.x, point.y)
  await waitForCanvasIdle(page, 10)
  expect(selectedCode(page)).toBe(code)
  expect(await canvasSum(page), 'clicking the selected course again changes nothing').toBe(end)

  await page.evaluate(() => history.replaceState(null, '', '#/utm'))
  await page.reload()
  await waitForMap(page)
  await restOn(page, point)
  expect(await canvasSum(page), 'the reload restores the reference start').toBe(start)
  return { point, code: code!, start, end }
}

test('a click selection animates over several frames, then settles', async ({ page }, testInfo) => {
  await openApp(page, '', { prefs: { onboarded: true } })
  const point = await findCourse(page)
  await restOn(page, point)
  const before = await canvasSum(page)

  await startRecorder(page)
  await page.mouse.click(point.x, point.y)
  const log = await stopWhenSettled(page)
  const code = selectedCode(page)
  expect(code, 'the click selected a course').not.toBeNull()
  await expect(courseStrip(page)).toContainText(code!)

  const down = log.downs[0]
  const changes = changesAfter(log, down)
  const span = changes.length ? changes.at(-1)!.t - changes[0].t : 0
  testInfo.annotations.push({ type: 'motion', description: `${code}: ${changes.length} distinct frames over ${Math.round(span)} ms` })
  // The geometry tween (260 ms), focus ring (180 ms) and chain-edge fades (to +480 ms) draw many
  // distinct frames, not one jump.
  expect(changes.length, 'distinct canvas frames after the click').toBeGreaterThanOrEqual(6)
  expect(span, 'the canvas keeps changing for most of the tween (ms)').toBeGreaterThanOrEqual(200)
  // ... and then settles: no change for the rest of the recording, and nothing later either.
  expect(changes.at(-1)!.t - down, 'the motion ends within 1.5 s of the click (ms)').toBeLessThan(1500)
  const settled = log.frames.at(-1)!.sum
  expect(settled).not.toBe(before)
  await waitForCanvasIdle(page, 10)
  expect(await canvasSum(page)).toBe(settled)
})

test('a second click during the tween jumps it to its end state', async ({ page }) => {
  const { point, code, start, end } = await referenceRun(page)

  // Interrupted: the same click, then a second click in place while the tween is still running.
  // The pointer does not travel between the two (mouse down / up only); pointer moves during the
  // tween are covered by the next test.
  await startRecorder(page)
  await page.mouse.click(point.x, point.y)
  await waitForTweenFrames(page)
  await page.mouse.down()
  await page.mouse.up()
  const log = await stopWhenSettled(page)
  expect(log.downs).toHaveLength(2)
  const [first, second] = log.downs

  // The second click came mid-tween: the canvas before it was neither the start nor the end.
  const beforeSecond = log.frames.filter(frame => frame.t <= second).at(-1)!
  expect(beforeSecond.t).toBeGreaterThan(first)
  expect(beforeSecond.sum, 'mid-tween when the second click arrived').not.toBe(end)
  expect(beforeSecond.sum).not.toBe(start)

  // Within two frames (one of them recorder lag) the canvas shows the uninterrupted run's end
  // state, pixel for pixel, and stays there.
  const after = log.frames.filter(frame => frame.t > second)
  const reached = after.findIndex(frame => frame.sum === end)
  expect(reached, 'frames until the end state after the second click').toBeGreaterThanOrEqual(0)
  expect(reached).toBeLessThanOrEqual(2)
  expect(after.slice(reached).filter(frame => frame.sum !== end), 'no frame after the jump differs from the end state').toEqual([])
  expect(selectedCode(page)).toBe(code)
  await expect(courseStrip(page)).toContainText(code)
  // Console errors and page errors fail the test at teardown (fixtures).
})

test('a pointer move during the tween keeps the end state hover', async ({ page }) => {
  // Pointer moves during a geometry tween are not hit-tested against the end layout (which is not on
  // screen yet); once the layout and the view settle, the resting pointer is hit-tested again. So
  // the pointer resting on the course it just clicked keeps its hover ring and pointer cursor.
  const { point, code, end } = await referenceRun(page)
  await startRecorder(page)
  await page.mouse.click(point.x, point.y)
  await waitForTweenFrames(page)
  // One pixel of pointer travel mid-tween (still on the clicked course), then let the tween finish.
  await page.mouse.move(point.x + 1, point.y)
  await page.mouse.move(point.x, point.y)
  await waitForCanvasIdle(page, 30)
  expect(selectedCode(page)).toBe(code)
  expect(await mapRegion(page).locator('canvas').evaluate(element => (element as HTMLCanvasElement).style.cursor), 'pointer cursor over the selected course').toBe('pointer')
  expect(await canvasSum(page), 'the hover ring of the end state').toBe(end)
})

test.describe('prefers-reduced-motion: reduce', () => {
  test.use({ reducedMotion: 'reduce' })

  test('the same click selection lands in one step', async ({ page }) => {
    await openApp(page, '', { prefs: { onboarded: true } })
    const point = await findCourse(page)
    await restOn(page, point)
    await startRecorder(page)
    await page.mouse.click(point.x, point.y)
    const log = await stopWhenSettled(page)
    expect(selectedCode(page)).not.toBeNull()
    // One redraw to the end state; tweens and animated pans are instant (17).
    expect(changesAfter(log, log.downs[0]).length, 'distinct canvas frames after the click').toBeLessThanOrEqual(2)
  })
})
