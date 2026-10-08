import { defineConfig, devices } from '@playwright/test'

// Exercise the production build beneath a repository subpath, including refresh.
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  timeout: 45_000,
  expect: { timeout: 12_000 },
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173/utm-atlas-test/',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...devices['Desktop Chrome'],
    viewport: { width: 1512, height: 982 },
  },
  webServer: {
    command: 'node scripts/serve-e2e.mjs',
    url: 'http://127.0.0.1:4173/utm-atlas-test/',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})
