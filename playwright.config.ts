import { defineConfig, devices, type Project } from '@playwright/test'

const BASE_PATH = '/UofT-Courses-Programs/'
/**
 * Production build under the Pages subpath (`scripts/serve-e2e.mjs`). Its read-only
 * `__courseMapLayout` getter (GraphCanvas) gives the hard-rule checks the drawn layout.
 */
const PREVIEW_URL = `http://127.0.0.1:4173${BASE_PATH}`

// The desktop frames of design-spec 6.1 / 16.2: a 1080p panel at 100 % and at 125 % scaling.
const WIDE: Project['use'] = { ...devices['Desktop Chrome'], viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 }
const STANDARD: Project['use'] = { ...devices['Desktop Chrome'], viewport: { width: 1536, height: 864 }, deviceScaleFactor: 1.25 }

/** Specs with their own project: motion (motion on). */
const MOTION_SPECS = '**/motion.spec.ts'

// Exercise the production build beneath a repository subpath, including refresh. Every project
// except `motion` emulates prefers-reduced-motion: reduce, so the canvas jumps to each end state
// (design-spec 17, owner decision 19.13) and assertions never race a tween.
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  timeout: 45_000,
  expect: { timeout: 12_000 },
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: PREVIEW_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    locale: 'en-CA',
    timezoneId: 'America/Toronto',
    colorScheme: 'light',
    reducedMotion: 'reduce',
  },
  projects: [
    { name: 'wide-1920', testIgnore: [MOTION_SPECS], use: WIDE },
    { name: 'standard-1536', testIgnore: [MOTION_SPECS], use: STANDARD },
    // Motion on (no reduced-motion preference): selections animate, input jumps tweens to their end.
    { name: 'motion', testMatch: MOTION_SPECS, use: { ...WIDE, reducedMotion: 'no-preference' } },
  ],
  webServer: {
    command: 'node scripts/serve-e2e.mjs',
    url: PREVIEW_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})
