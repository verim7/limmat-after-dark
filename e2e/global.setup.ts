import { test as setup } from '@playwright/test'
import { clerkSetup } from '@clerk/testing/playwright'
import { createClerkClient } from '@clerk/backend'
import { BROWSERS, testEmail } from './users.ts'

setup.describe.configure({ mode: 'serial' })

// Fetches a Clerk testing token (bypasses bot protection) and makes sure the test users exist.
setup('clerk setup and test users', async () => {
  await clerkSetup()
  const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! })
  for (const browser of BROWSERS) {
    const email = testEmail(browser)
    const { data } = await clerk.users.getUserList({ emailAddress: [email] })
    if (data.length === 0) await clerk.users.createUser({ emailAddress: [email], skipPasswordRequirement: true })
  }
})
