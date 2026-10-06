import { Hono } from 'hono'
import { getAuth } from '@clerk/hono'
import { quoteIsVerbatim, segmentPolicy, segmentRegulation, type Section } from '../../shared/segment'

type Env = { Bindings: { DB: D1Database; ASSETS: Fetcher } }

type DocInput = { filename?: string; text?: string; reuseLatest?: boolean }
type SectionRow = Section & { kind: 'regulation' | 'policy' }
type RequirementRow = { rid: string; section_sid: string; ref_label: string; quote: string; summary: string; ord: number }
type Rating = 'covered' | 'partial' | 'missing'
type AssessmentRow = {
  rid: string
  policy_sids: string
  policy_quote: string
  rating: Rating
  reason: string
  proposed_text: string
  review_status: 'pending' | 'confirmed' | 'overridden'
  final_rating: Rating | null
  review_comment: string
  reviewer_name: string | null
  reviewed_at: string | null
  impact_policy_id: string
  impact_confirmed: number
}
type TaskRow = { rid: string; policy_id: string; title: string; owner: string; due_date: string; status: 'open' | 'done' }
const RATINGS: Rating[] = ['covered', 'partial', 'missing']

export const gapcheck = new Hono<Env>()

// Stage 1 — Load: store both texts and split them into sections.
gapcheck.post('/runs', async (c) => {
  const userId = getAuth(c)!.userId!
  const body = await c.req.json<{ regulation?: DocInput; policy?: DocInput }>()
  const reg = body.regulation?.reuseLatest ? await latestRegulation(c.env.DB, userId) : body.regulation
  const pol = body.policy
  if (body.regulation?.reuseLatest && !reg) return c.json({ error: 'No saved regulation yet — upload the FIDLEG PDF once' }, 422)
  if (!reg?.text?.trim() || !pol?.text?.trim()) return c.json({ error: 'regulation.text and policy.text are required' }, 400)

  const regSections = segmentRegulation(reg.text, { fromArt: 4, toArt: 16, law: 'FIDLEG' })
  const polSections = segmentPolicy(pol.text)
  if (regSections.length === 0) return c.json({ error: 'No FIDLEG articles 4–16 found in the regulation text' }, 422)
  if (polSections.length < 2) return c.json({ error: 'No numbered sections found in the policy text' }, 422)

  const runId = crypto.randomUUID()
  const db = c.env.DB
  const insertSection = db.prepare(
    'INSERT INTO sections (run_id, sid, kind, ref, heading, text, ord) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
  await db.batch([
    db.prepare('INSERT INTO runs (id, user_id) VALUES (?, ?)').bind(runId, userId),
    db.prepare('INSERT INTO documents (run_id, kind, filename, full_text) VALUES (?, ?, ?, ?)')
      .bind(runId, 'regulation', reg.filename ?? 'regulation', reg.text),
    db.prepare('INSERT INTO documents (run_id, kind, filename, full_text) VALUES (?, ?, ?, ?)')
      .bind(runId, 'policy', pol.filename ?? 'policy', pol.text),
    ...regSections.map((s) => insertSection.bind(runId, s.sid, 'regulation', s.ref, s.heading, s.text, s.ord)),
    ...polSections.map((s) => insertSection.bind(runId, s.sid, 'policy', s.ref, s.heading, s.text, s.ord)),
  ])
  return c.json({ runId, regulationSections: regSections.length, policySections: polSections.length }, 201)
})

// What the "Use saved documents" button can reuse.
gapcheck.get('/saved', async (c) => {
  const userId = getAuth(c)!.userId!
  const reg = await latestRegulation(c.env.DB, userId)
  return c.json({ regulation: reg ? { filename: reg.filename } : null })
})

function latestRegulation(db: D1Database, userId: string) {
  return db
    .prepare(
      `SELECT d.filename, d.full_text AS text FROM documents d JOIN runs r ON r.id = d.run_id
       WHERE r.user_id = ? AND d.kind = 'regulation' ORDER BY r.created_at DESC, r.rowid DESC LIMIT 1`,
    )
    .bind(userId)
    .first<{ filename: string; text: string }>()
}

gapcheck.get('/runs/latest', async (c) => {
  const userId = getAuth(c)!.userId!
  const run = await c.env.DB.prepare('SELECT id FROM runs WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1')
    .bind(userId)
    .first<{ id: string }>()
  if (!run) return c.json({ run: null })
  return c.json(await loadRun(c.env.DB, run.id, userId))
})

gapcheck.get('/runs/:id', async (c) => {
  const userId = getAuth(c)!.userId!
  const data = await loadRun(c.env.DB, c.req.param('id'), userId)
  return data.run ? c.json(data) : c.json({ error: 'not found' }, 404)
})

// Stage 6 — the report view is computed here, including the traceability checks.
async function loadRun(db: D1Database, runId: string, userId: string) {
  const run = await db.prepare('SELECT id, status, created_at FROM runs WHERE id = ? AND user_id = ?')
    .bind(runId, userId)
    .first<{ id: string; status: string; created_at: string }>()
  if (!run) return { run: null }

  const [docs, sections, reqs, assessments, tasks] = await db.batch([
    db.prepare('SELECT kind, filename FROM documents WHERE run_id = ?').bind(runId),
    db.prepare('SELECT sid, kind, ref, heading, text, ord FROM sections WHERE run_id = ? ORDER BY kind, ord').bind(runId),
    db.prepare('SELECT rid, section_sid, ref_label, quote, summary, ord FROM requirements WHERE run_id = ? ORDER BY ord').bind(runId),
    db.prepare(
      `SELECT rid, policy_sids, policy_quote, rating, reason, proposed_text, review_status, final_rating, review_comment,
              reviewer_name, reviewed_at, impact_policy_id, impact_confirmed FROM assessments WHERE run_id = ?`,
    ).bind(runId),
    db.prepare('SELECT rid, policy_id, title, owner, due_date, status FROM tasks WHERE run_id = ?').bind(runId),
  ])
  const bySid = new Map((sections.results as SectionRow[]).map((s) => [s.sid, s]))
  const assessmentByRid = new Map((assessments.results as AssessmentRow[]).map((a) => [a.rid, a]))

  const requirements = (reqs.results as RequirementRow[]).map((r) => {
    const section = bySid.get(r.section_sid)
    const lit = r.ref_label.match(/lit\.\s*([a-z])\b/)?.[1]
    const refVerified =
      section?.kind === 'regulation' && (!lit || new RegExp(`(^|\\s)${lit}\\.\\s`).test(section.text))
    const quoteVerified = !!section && quoteIsVerbatim(section.text, r.quote)

    const a = assessmentByRid.get(r.rid)
    let assessment = null
    if (a) {
      const sids = safeJsonArray(a.policy_sids)
      const policySections = sids.map((sid) => bySid.get(sid)).filter((s): s is SectionRow => s?.kind === 'policy')
      const policyVerified =
        policySections.length === sids.length &&
        (a.rating === 'missing'
          ? true
          : policySections.length > 0 && policySections.some((s) => quoteIsVerbatim(s.text, a.policy_quote)))
      assessment = {
        ...a,
        policy_sids: sids,
        policySections,
        policyVerified,
        impact_confirmed: !!a.impact_confirmed,
        effectiveRating: a.final_rating ?? a.rating,
      }
    }
    return { ...r, section, refVerified, quoteVerified, assessment }
  })

  return {
    run,
    documents: docs.results,
    sections: { regulation: [...bySid.values()].filter((s) => s.kind === 'regulation'), policy: [...bySid.values()].filter((s) => s.kind === 'policy') },
    requirements,
    tasks: tasks.results as TaskRow[],
  }
}

function safeJsonArray(s: string): string[] {
  try {
    const v = JSON.parse(s)
    return Array.isArray(v) ? v.map(String) : []
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Stage 5 — Review: a signed-in user confirms or overrides each AI rating.

async function ownsRun(db: D1Database, runId: string, userId: string) {
  return !!(await db.prepare('SELECT 1 FROM runs WHERE id = ? AND user_id = ?').bind(runId, userId).first())
}

gapcheck.patch('/runs/:id/requirements/:rid/review', async (c) => {
  const userId = getAuth(c)!.userId!
  const { id, rid } = c.req.param()
  if (!(await ownsRun(c.env.DB, id, userId))) return c.json({ error: 'not found' }, 404)
  const body = await c.req.json<{ action?: 'confirm' | 'override' | 'reset'; rating?: Rating; comment?: string }>()

  const current = await c.env.DB.prepare('SELECT rating FROM assessments WHERE run_id = ? AND rid = ?')
    .bind(id, rid)
    .first<{ rating: Rating }>()
  if (!current) return c.json({ error: 'not found' }, 404)

  if (body.action === 'reset') {
    await c.env.DB.prepare(
      `UPDATE assessments SET review_status = 'pending', final_rating = NULL, review_comment = '', reviewed_by = NULL,
       reviewer_name = NULL, reviewed_at = NULL WHERE run_id = ? AND rid = ?`,
    ).bind(id, rid).run()
    return c.json({ ok: true })
  }

  let status: 'confirmed' | 'overridden'
  let finalRating: Rating
  if (body.action === 'confirm') {
    status = 'confirmed'
    finalRating = current.rating
  } else if (body.action === 'override' && body.rating && RATINGS.includes(body.rating)) {
    if (!body.comment?.trim()) return c.json({ error: 'An override needs a comment' }, 400)
    status = body.rating === current.rating ? 'confirmed' : 'overridden'
    finalRating = body.rating
  } else {
    return c.json({ error: 'action must be confirm, override (with rating and comment) or reset' }, 400)
  }

  const user = await c.get('clerk').users.getUser(userId)
  const name = user.fullName || user.username || user.primaryEmailAddress?.emailAddress || userId
  await c.env.DB.prepare(
    `UPDATE assessments SET review_status = ?, final_rating = ?, review_comment = ?, reviewed_by = ?, reviewer_name = ?,
     reviewed_at = datetime('now') WHERE run_id = ? AND rid = ?`,
  ).bind(status, finalRating, body.comment?.trim() ?? '', userId, name, id, rid).run()
  return c.json({ ok: true })
})

// Impact: which internal policy has to change for this gap (default W-07); the user confirms or corrects it.
gapcheck.patch('/runs/:id/requirements/:rid/impact', async (c) => {
  const userId = getAuth(c)!.userId!
  const { id, rid } = c.req.param()
  if (!(await ownsRun(c.env.DB, id, userId))) return c.json({ error: 'not found' }, 404)
  const { policyId, confirmed } = await c.req.json<{ policyId?: string; confirmed?: boolean }>()
  const register = await loadRegister(c.env.ASSETS)
  if (!policyId || !register.some((p) => p.id === policyId)) return c.json({ error: 'policyId must be an id from the policy register' }, 400)
  await c.env.DB.prepare('UPDATE assessments SET impact_policy_id = ?, impact_confirmed = ? WHERE run_id = ? AND rid = ?')
    .bind(policyId, confirmed ? 1 : 0, id, rid)
    .run()
  return c.json({ ok: true })
})

// Task list: one task per reviewed gap (final rating partial/missing) with a confirmed impact.
gapcheck.post('/runs/:id/tasks', async (c) => {
  const userId = getAuth(c)!.userId!
  const { id } = c.req.param()
  if (!(await ownsRun(c.env.DB, id, userId))) return c.json({ error: 'not found' }, 404)
  const register = new Map((await loadRegister(c.env.ASSETS)).map((p) => [p.id, p]))
  const { results } = await c.env.DB.prepare(
    `SELECT r.rid, r.ref_label, r.summary, a.final_rating, a.impact_policy_id, a.proposed_text
     FROM requirements r JOIN assessments a USING (run_id, rid)
     WHERE r.run_id = ? AND a.review_status != 'pending' AND a.final_rating IN ('partial', 'missing') AND a.impact_confirmed = 1
     ORDER BY r.ord`,
  ).bind(id).all<{ rid: string; ref_label: string; summary: string; final_rating: Rating; impact_policy_id: string; proposed_text: string }>()

  const due = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10)
  const upsert = c.env.DB.prepare(
    `INSERT INTO tasks (run_id, rid, policy_id, title, owner, due_date) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (run_id, rid) DO UPDATE SET policy_id = excluded.policy_id, title = excluded.title, owner = excluded.owner`,
  )
  const keep = results.map((r) => r.rid)
  await c.env.DB.batch([
    // Drop tasks whose gap was meanwhile overridden to "covered" or un-confirmed.
    c.env.DB.prepare(`DELETE FROM tasks WHERE run_id = ? AND rid NOT IN (SELECT value FROM json_each(?))`).bind(id, JSON.stringify(keep)),
    ...results.map((r) => {
      const policy = register.get(r.impact_policy_id)
      const verb = r.final_rating === 'missing' ? 'Add' : 'Complete'
      const title = `${verb} ${r.impact_policy_id} for ${r.ref_label}: ${r.summary}`
      return upsert.bind(id, r.rid, r.impact_policy_id, title, policy?.owner ?? 'Compliance', due)
    }),
  ])
  return c.json({ created: results.length })
})

gapcheck.patch('/runs/:id/tasks/:rid', async (c) => {
  const userId = getAuth(c)!.userId!
  const { id, rid } = c.req.param()
  if (!(await ownsRun(c.env.DB, id, userId))) return c.json({ error: 'not found' }, 404)
  const { owner, due_date, status } = await c.req.json<{ owner?: string; due_date?: string; status?: 'open' | 'done' }>()
  if (due_date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(due_date)) return c.json({ error: 'due_date must be YYYY-MM-DD' }, 400)
  if (status !== undefined && status !== 'open' && status !== 'done') return c.json({ error: 'status must be open or done' }, 400)
  await c.env.DB.prepare(
    `UPDATE tasks SET owner = COALESCE(?, owner), due_date = COALESCE(?, due_date), status = COALESCE(?, status)
     WHERE run_id = ? AND rid = ?`,
  ).bind(owner?.trim() || null, due_date ?? null, status ?? null, id, rid).run()
  return c.json({ ok: true })
})

// The internal policy register (public/samples/internal_policies_and_processes.csv).
type RegisterEntry = { id: string; title: string; owner: string; regulatory_basis: string }

async function loadRegister(assets: Fetcher): Promise<RegisterEntry[]> {
  const res = await assets.fetch('https://assets.local/samples/internal_policies_and_processes.csv')
  if (!res.ok) return []
  return parseRegisterCsv(await res.text())
}

export function parseRegisterCsv(text: string): RegisterEntry[] {
  const rows = text
    .trim()
    .split(/\r?\n/)
    .map((line) => [...line.matchAll(/("([^"]*)"|[^,]*)(,|$)/g)].map((m) => m[2] ?? m[1]).slice(0, -1))
  const [header, ...body] = rows
  return body.map((cells) => Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ''])) as RegisterEntry)
}
