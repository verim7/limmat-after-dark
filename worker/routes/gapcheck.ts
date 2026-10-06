import { Hono } from 'hono'
import { getAuth } from '@clerk/hono'
import { quoteIsVerbatim, segmentPolicy, segmentRegulation, type Section } from '../../shared/segment'

type Env = { Bindings: { DB: D1Database } }

type DocInput = { filename?: string; text?: string; reuseLatest?: boolean }
type SectionRow = Section & { kind: 'regulation' | 'policy' }
type RequirementRow = { rid: string; section_sid: string; ref_label: string; quote: string; summary: string; ord: number }
type AssessmentRow = {
  rid: string
  policy_sids: string
  policy_quote: string
  rating: 'covered' | 'partial' | 'missing'
  reason: string
  proposed_text: string
}

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

  const [docs, sections, reqs, assessments] = await db.batch([
    db.prepare('SELECT kind, filename FROM documents WHERE run_id = ?').bind(runId),
    db.prepare('SELECT sid, kind, ref, heading, text, ord FROM sections WHERE run_id = ? ORDER BY kind, ord').bind(runId),
    db.prepare('SELECT rid, section_sid, ref_label, quote, summary, ord FROM requirements WHERE run_id = ? ORDER BY ord').bind(runId),
    db.prepare('SELECT rid, policy_sids, policy_quote, rating, reason, proposed_text FROM assessments WHERE run_id = ?').bind(runId),
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
      assessment = { ...a, policy_sids: sids, policySections, policyVerified }
    }
    return { ...r, section, refVerified, quoteVerified, assessment }
  })

  return {
    run,
    documents: docs.results,
    sections: { regulation: [...bySid.values()].filter((s) => s.kind === 'regulation'), policy: [...bySid.values()].filter((s) => s.kind === 'policy') },
    requirements,
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
