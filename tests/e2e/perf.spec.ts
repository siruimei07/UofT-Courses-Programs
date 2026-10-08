// Performance smoke test (design-spec 16.1): select → first full frame within 400 ms (the 4 ×
// throttled budget; unthrottled the budget is 100 ms). It relies on GraphCanvas's development-only
// diagnostics (`__courseMapFrames`, pushed on every drawn frame). The e2e server serves the
// production build, where those globals are compiled out: the test then records a proxy timing
// (selection → live-region announcement → next animation frame) as an annotation and skips.
import { courseStrip, expect, openApp, test, waitForCanvasIdle } from './fixtures'

const COURSES = ['CSC148H5', 'MAT232H5', 'ECO200Y5']

test('select → first frame within 400 ms', async ({ page }, testInfo) => {
  await openApp(page, '', { prefs: { onboarded: true } })
  const diagnostics = await page.evaluate(() => Array.isArray((globalThis as { __courseMapFrames?: unknown }).__courseMapFrames))

  const timings: number[] = []
  for (const code of COURSES) {
    await waitForCanvasIdle(page)
    const ms = await page.evaluate(async ({ code, useFrames }) => {
      const w = globalThis as typeof globalThis & { __courseMapFrames?: unknown[] }
      const live = document.querySelector('.gc-root [aria-live="polite"]')
      const before = w.__courseMapFrames?.length ?? 0
      const started = performance.now()
      window.location.hash = `#/utm?course=${code}`
      await new Promise<void>(resolve => {
        const tick = () => {
          const drawn = !useFrames || (w.__courseMapFrames?.length ?? 0) > before
          if (drawn && live?.textContent?.startsWith(`Selected ${code}.`)) resolve()
          else requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      })
      // One more frame so the drawn canvas has been presented.
      await new Promise(resolve => requestAnimationFrame(resolve))
      return performance.now() - started
    }, { code, useFrames: diagnostics })
    await expect(courseStrip(page)).toContainText(code)
    timings.push(ms)
  }

  const summary = COURSES.map((code, i) => `${code} ${Math.round(timings[i])} ms`).join(', ')
  testInfo.annotations.push({ type: 'perf', description: `select → first frame (${diagnostics ? 'dev diagnostics' : 'live-region proxy'}): ${summary}` })
  console.log(`[perf ${testInfo.project.name}] select → first frame (${diagnostics ? 'dev diagnostics' : 'proxy'}): ${summary}`)

  test.skip(!diagnostics, 'Dev diagnostics globals (__courseMapFrames) exist only in development builds and the e2e server serves the production build; proxy timings are in the "perf" annotation.')
  for (const ms of timings) expect(ms).toBeLessThan(400)
})
