import { Hono } from 'hono'
import { getAuth } from '@clerk/hono'
import {
  ASSESS_BATCH,
  ASSESS_SCHEMA,
  EXTRACT_SCHEMA,
  WORKERS_AI_MODEL,
  assessPrompt,
  chunkByArticle,
  chunkLabel,
  cleanAssess,
  cleanExtract,
  extractPrompt,
  parseAiResponse,
  type StoredSection,
} from '../../shared/aiSteps'
import { ownsRun } from './gapcheck'

// In-app AI engine for stages 2–4 (fallback to Claude Code). The client calls one short step at a time.
type Env = { Bindings: { DB: D1Database; AI: Ai } }

export const workersAi = new Hono<Env>()

const ENGINE = `workers-ai:${WORKERS_AI_MODEL}`

async function sections(db: D1Database, runId: string, kind: 'regulation' | 'policy') {
  const { results } = await db
    .prepare('SELECT sid, ref, heading, text FROM sections WHERE run_id = ? AND kind = ? ORDER BY ord')
    .bind(runId, kind)
    .all<StoredSection>()
  return results
}

async function runJson(ai: Ai, system: string, user: string, schema: object) {
  const call = () =>
    (ai as unknown as { run: (model: string, input: unknown) => Promise<unknown> }).run(WORKERS_AI_MODEL, {
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      response_format: { type: 'json_schema', json_schema: schema },
      max_tokens: 4096,
      temperature: 0.1,
    })
  let lastError: unknown
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const parsed = parseAiResponse(await call())
      if (parsed) return parsed
      lastError = new Error('Model returned no JSON')
    } catch (e) {
      lastError = e // e.g. "JSON Mode couldn't be met" — retry once
    }
  }
  throw lastError
}

// Stage 2 — extract requirements, one chunk of articles per call.
workersAi.post('/runs/:id/ai/extract', async (c) => {
  const userId = getAuth(c)!.userId!
  const runId = c.req.param('id')
  const db = c.env.DB
  if (!(await ownsRun(db, runId, userId))) return c.json({ error: 'not found' }, 404)

  const chunks = chunkByArticle(await sections(db, runId, 'regulation'))
  const n = Number(c.req.query('chunk') ?? 0)
  if (!Number.isInteger(n) || n < 0 || n >= chunks.length) return c.json({ error: 'invalid chunk' }, 400)

  if (n === 0) {
    await db.batch([
      db.prepare('DELETE FROM tasks WHERE run_id = ?').bind(runId),
      db.prepare('DELETE FROM assessments WHERE run_id = ?').bind(runId),
      db.prepare('DELETE FROM requirements WHERE run_id = ?').bind(runId),
      db.prepare(`UPDATE runs SET status = 'awaiting_ai', engine = ? WHERE id = ?`).bind(ENGINE, runId),
    ])
  }

  const { system, user } = extractPrompt(chunks[n])
  let items: unknown
  try {
    items = (await runJson(c.env.AI, system, user, EXTRACT_SCHEMA)).requirements
  } catch (e) {
    return c.json({ error: `Workers AI failed on ${chunkLabel(chunks[n])}: ${(e as Error).message}` }, 502)
  }
  const reqs = cleanExtract(items, chunks[n])

  const existing = await db.prepare('SELECT COUNT(*) AS n FROM requirements WHERE run_id = ?').bind(runId).first<{ n: number }>()
  const start = existing?.n ?? 0
  const insert = db.prepare(
    'INSERT INTO requirements (run_id, rid, section_sid, ref_label, quote, summary, ord) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
  if (reqs.length) {
    await db.batch(
      reqs.map((r, i) =>
        insert.bind(runId, `R${String(start + i + 1).padStart(2, '0')}`, r.section_sid, r.ref_label, r.quote, r.summary, start + i),
      ),
    )
  }
  return c.json({ chunk: n, chunks: chunks.length, label: chunkLabel(chunks[n]), added: reqs.length, total: start + reqs.length })
})

// Stages 3–4 — map to policy sections and rate, a batch of requirements per call.
workersAi.post('/runs/:id/ai/assess', async (c) => {
  const userId = getAuth(c)!.userId!
  const runId = c.req.param('id')
  const db = c.env.DB
  if (!(await ownsRun(db, runId, userId))) return c.json({ error: 'not found' }, 404)

  const { results: all } = await db
    .prepare('SELECT rid, ref_label, quote, summary FROM requirements WHERE run_id = ? ORDER BY ord')
    .bind(runId)
    .all<{ rid: string; ref_label: string; quote: string; summary: string }>()
  if (all.length === 0) return c.json({ error: 'No requirements extracted yet' }, 409)
  const batches = Math.ceil(all.length / ASSESS_BATCH)
  const b = Number(c.req.query('batch') ?? 0)
  if (!Number.isInteger(b) || b < 0 || b >= batches) return c.json({ error: 'invalid batch' }, 400)

  const batch = all.slice(b * ASSESS_BATCH, (b + 1) * ASSESS_BATCH)
  const policy = await sections(db, runId, 'policy')
  const { system, user } = assessPrompt(batch, policy)
  let items: unknown
  try {
    items = (await runJson(c.env.AI, system, user, ASSESS_SCHEMA)).assessments
  } catch (e) {
    return c.json({ error: `Workers AI failed on requirements ${batch[0].rid}–${batch[batch.length - 1].rid}: ${(e as Error).message}` }, 502)
  }
  const assessed = cleanAssess(items, batch.map((r) => r.rid), policy)

  const upsert = db.prepare(
    `INSERT INTO assessments (run_id, rid, policy_sids, policy_quote, rating, reason, proposed_text) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (run_id, rid) DO UPDATE SET policy_sids = excluded.policy_sids, policy_quote = excluded.policy_quote,
       rating = excluded.rating, reason = excluded.reason, proposed_text = excluded.proposed_text`,
  )
  const last = b === batches - 1
  await db.batch([
    ...assessed.map((a) => upsert.bind(runId, a.rid, JSON.stringify(a.policy_sids), a.policy_quote, a.rating, a.reason, a.proposed_text)),
    ...(last ? [db.prepare(`UPDATE runs SET status = 'assessed' WHERE id = ?`).bind(runId)] : []),
  ])
  return c.json({ batch: b, batches, from: batch[0].rid, to: batch[batch.length - 1].rid, done: last })
})
