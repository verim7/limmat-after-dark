import { expect, test } from '@playwright/test'
import { clerk } from '@clerk/testing/playwright'
import { testEmail } from './users.ts'

test('landing page and API health', async ({ page, request }) => {
  const health = await request.get('/api/health')
  expect(health.ok()).toBeTruthy()
  expect((await health.json()).ok).toBe(true)

  await page.goto('/')
  await expect(page.getByRole('heading', { name: /FIDLEG vs\. your Weisung/ })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Sign in' }).first()).toBeVisible()
})

test('signed-in user loads the saved documents and both are split into sections', async ({ page, browserName }) => {
  await page.goto('/')
  await clerk.signIn({ page, emailAddress: testEmail(browserName) })
  await page.goto('/')

  // Existing users land on their latest run; start a new one.
  const newRun = page.getByRole('button', { name: 'New run' })
  const saved = page.getByRole('button', { name: 'Use saved documents' })
  await expect(newRun.or(saved).first()).toBeVisible()
  if (await newRun.isVisible()) await newRun.click()

  // Browser-side PDF extraction (pdf.js) + server-side split — the path that broke on Safari.
  await saved.click()
  await expect(page.getByRole('heading', { name: 'Run the AI step' })).toBeVisible({ timeout: 90_000 })
  await expect(page.getByText(/41 regulation sections · 23 policy sections/)).toBeVisible()
  await expect(page.getByText(/Stand_2026-10-01/)).toBeVisible()
})
