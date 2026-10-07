import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { clerk } from '@clerk/testing/playwright'
import { testEmail } from './users.ts'

// Real snapshot of an assessed Workers AI run (fictional W-07 / FIDLEG data), see _note in the file.
const fixture = readFileSync(new URL('./fixtures/run-assessed.json', import.meta.url), 'utf8')

test('report fits the phone screen: no element wider than the viewport', async ({ page, browserName }) => {
  await page.goto('/')
  await clerk.signIn({ page, emailAddress: testEmail(browserName) })
  // Serve the assessed run instead of the test user's own runs; no data is written.
  await page.route('**/api/runs/latest', (route) => route.fulfill({ contentType: 'application/json', body: fixture }))
  await page.goto('/')

  await expect(page.getByRole('heading', { name: /Gap table/ })).toBeVisible()
  await expect(page.getByText('Affected policy:').first()).toBeVisible()
  await expect(page.getByRole('heading', { name: /Task list/ })).toBeVisible()
  await page.locator('details.ai-timing').evaluate((d) => ((d as HTMLDetailsElement).open = true))

  const overflow = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth
    const off: string[] = []
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect()
      if (r.width > 0 && r.right > vw + 1) off.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 40)} right=${Math.round(r.right)}`)
    }
    return { vw, scrollWidth: document.documentElement.scrollWidth, off: off.slice(0, 10), count: off.length }
  })
  expect(overflow.count, `elements past the ${overflow.vw}px screen edge: ${overflow.off.join(', ')}`).toBe(0)
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.vw)
})
