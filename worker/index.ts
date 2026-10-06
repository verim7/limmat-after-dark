import { Hono } from 'hono'
import { clerkMiddleware, getAuth } from '@clerk/hono'
import { createMiddleware } from 'hono/factory'

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
app.use('/notes/*', requireUser)

app.get('/me', async (c) => {
  const { userId } = getAuth(c)!
  const user = await c.get('clerk').users.getUser(userId!)
  return c.json({
    userId,
    name: user.fullName ?? user.username,
    email: user.primaryEmailAddress?.emailAddress ?? null,
  })
})

app.get('/notes', async (c) => {
  const { userId } = getAuth(c)!
  const { results } = await c.env.DB.prepare(
    'SELECT id, body, created_at FROM notes WHERE user_id = ? ORDER BY created_at DESC LIMIT 50',
  )
    .bind(userId)
    .all()
  return c.json(results)
})

app.post('/notes', async (c) => {
  const { userId } = getAuth(c)!
  const { body } = await c.req.json<{ body?: string }>()
  if (!body?.trim()) return c.json({ error: 'body is required' }, 400)
  const note = await c.env.DB.prepare(
    'INSERT INTO notes (user_id, body) VALUES (?, ?) RETURNING id, body, created_at',
  )
    .bind(userId, body.trim())
    .first()
  return c.json(note, 201)
})

app.delete('/notes/:id', async (c) => {
  const { userId } = getAuth(c)!
  await c.env.DB.prepare('DELETE FROM notes WHERE id = ? AND user_id = ?')
    .bind(c.req.param('id'), userId)
    .run()
  return c.body(null, 204)
})

app.notFound((c) => c.json({ error: 'not found' }, 404))

export default app

