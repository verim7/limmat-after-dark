import { Hono } from 'hono'
import { clerkMiddleware, getAuth } from '@clerk/hono'
import { createMiddleware } from 'hono/factory'
import { gapcheck } from './routes/gapcheck'
import { sources } from './routes/sources'

type Bindings = {
  DB: D1Database
  CLERK_SECRET_KEY: string
  CLERK_PUBLISHABLE_KEY: string
}

const app = new Hono<{ Bindings: Bindings }>().basePath('/api')

const requireUser = createMiddleware(async (c, next) => {
  if (!getAuth(c)?.userId) return c.json({ error: 'unauthorized' }, 401)
  await next()
})

app.use('*', clerkMiddleware())

// Public
app.get('/health', (c) => c.json({ ok: true, at: new Date().toISOString() }))

// Everything below requires a signed-in Clerk user.
app.use('/me', requireUser)
app.use('/runs', requireUser)
app.use('/runs/*', requireUser)
app.use('/saved', requireUser)
app.use('/sources/*', requireUser)

app.get('/me', async (c) => {
  const { userId } = getAuth(c)!
  const user = await c.get('clerk').users.getUser(userId!)
  return c.json({
    userId,
    name: user.fullName ?? user.username,
    email: user.primaryEmailAddress?.emailAddress ?? null,
  })
})

// Regulation gap check (Exercise 5, Option A)
app.route('/', gapcheck)
app.route('/', sources)

app.notFound((c) => c.json({ error: 'not found' }, 404))

export default app

