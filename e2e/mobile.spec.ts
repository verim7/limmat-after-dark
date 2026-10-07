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
    const name = (el: Element | null) => (el ? `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 30)}` : '?')
    // 1. Elements whose box passes the right edge.
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect()
      if (r.width > 0 && r.right > vw + 1) off.push(`box ${name(el)} right=${Math.round(r.right)}`)
    }
    // 2. Text that overflows its box (fonts differ between engines, so boxes alone are not enough).
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    const range = document.createRange()
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.textContent?.trim()) continue
      range.selectNodeContents(n)
      for (const r of range.getClientRects()) {
        if (r.width > 0 && r.right > vw + 1) {
          off.push(`text in ${name(n.parentElement)} right=${Math.round(r.right)} "${n.textContent.trim().slice(0, 30)}"`)
          break
        }
      }
    }
    return { vw, scrollWidth: document.documentElement.scrollWidth, off: off.slice(0, 12), count: off.length }
  })
  // If the page is too wide, find the smallest element whose removal restores the width (works for shadow DOM and
  // pseudo-elements too, which box and text checks cannot see).
  const culprit = overflow.scrollWidth > overflow.vw ? await page.evaluate(() => {
    const vw = document.documentElement.clientWidth
    const tooWide = () => document.documentElement.scrollWidth > vw
    const name = (el: Element) => `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 40)}`
    const path: string[] = []
    let node: Element = document.body
    for (let depth = 0; depth < 25; depth++) {
      const next = [...node.children].find((child) => {
        const el = child as HTMLElement
        const prev = el.style.display
        el.style.display = 'none'
        const fixed = !tooWide()
        el.style.display = prev
        return fixed
      })
      if (!next) break
      path.push(name(next))
      node = next
    }
    const r = node.getBoundingClientRect()
    return `${path.join(' > ')} (box ${Math.round(r.left)}–${Math.round(r.right)}px, scrollWidth ${(node as HTMLElement).scrollWidth})`
  }) : ''

  expect(overflow.count, `elements past the ${overflow.vw}px screen edge: ${overflow.off.join(', ')}`).toBe(0)
  expect(overflow.scrollWidth, `page is ${overflow.scrollWidth}px wide on a ${overflow.vw}px screen; culprit: ${culprit}`).toBeLessThanOrEqual(overflow.vw)
})
