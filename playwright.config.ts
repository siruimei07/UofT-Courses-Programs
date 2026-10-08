import { defineConfig, devices } from '@playwright/test'

// Exercise the production build beneath a repository subpath, including refresh. The two projects
// are the desktop frames of design-spec 6.1 / 16.2: a 1080p panel at 100 % and at 125 % scaling.
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
    baseURL: 'http://127.0.0.1:4173/UofT-Courses-Programs/',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    locale: 'en-CA',
    timezoneId: 'America/Toronto',
    colorScheme: 'light',
  },
  projects: [
    {
      name: 'wide-1920',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 },
    },
    {
      name: 'standard-1536',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1536, height: 864 }, deviceScaleFactor: 1.25 },
    },
  ],
  webServer: {
    command: 'node scripts/serve-e2e.mjs',
    url: 'http://127.0.0.1:4173/UofT-Courses-Programs/',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})
