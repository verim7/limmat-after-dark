import { defineConfig, devices } from '@playwright/test'

// End-to-end tests against the deployed app (or BASE_URL). Chromium + WebKit, because WebKit is Safari's engine
// and catches Safari-only bugs (e.g. the pdf.js `for await` issue).
// Needs CLERK_PUBLISHABLE_KEY and CLERK_SECRET_KEY (development instance) for test sign-in.
export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  expect: { timeout: 20_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: process.env.BASE_URL ?? 'https://limmat-after-dark.verimajdini.workers.dev',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'setup', testMatch: /global\.setup\.ts/ },
    { name: 'chromium', use: { ...devices['Desktop Chrome'] }, dependencies: ['setup'], testIgnore: /mobile\.spec/ },
    { name: 'webkit', use: { ...devices['Desktop Safari'] }, dependencies: ['setup'], testIgnore: /mobile\.spec/ },
    // Phone layouts: the report must never be wider than the screen.
    { name: 'mobile-webkit', use: { ...devices['iPhone 13'] }, dependencies: ['setup'], testMatch: /mobile\.spec/ },
    { name: 'mobile-chromium', use: { ...devices['Pixel 7'] }, dependencies: ['setup'], testMatch: /mobile\.spec/ },
  ],
})
