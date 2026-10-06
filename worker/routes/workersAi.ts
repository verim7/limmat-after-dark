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
  parseUsage,
  type StoredSection,
} from '../../shared/aiSteps'
import { ownsRun } from './gapcheck'

// In-app AI engine for stages 2–4 (fallback to Claude Code).
// Flow, driven by the browser: start → extract chunks (in parallel) → number → assess batches (in parallel) → finish.
type Env = { Bindings: { DB: D1Database; AI: Ai } }

export const workersAi = new Hono<Env>()

const ENGINE = `workers-ai:${WORKERS_AI_MODEL}`

async function sections(db: D1Database, runId: string, kind: 'regulation' | 'policy') {
  const { results } = await db
    .prepare('SELECT sid, ref, heading, text, ord FROM sections WHERE run_id = ? AND kind = ? ORDER BY ord')
    .bind(runId, kind)
    .all<StoredSection>()
  return results
}

type AiResult = { data: Record<string, unknown>; durationMs: number; attempts: number; promptTokens: number | null; completionTokens: number | null }

async function runJson(ai: Ai, system: string, user: string, schema: object): Promise<AiResult> {
  const started = Date.now()
  let lastError: unknown
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await (ai as unknown as { run: (model: string, input: unknown) => Promise<unknown> }).run(WORKERS_AI_MODEL, {
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        response_format: { type: 'json_schema', json_schema: schema },
        max_tokens: 2048,
        temperature: 0.1,
      })
      const data = parseAiResponse(res)
      if (data) {
        const usage = parseUsage(res)
        return { data, durationMs: Date.now() - started, attempts: attempt, promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens }
      }
      lastError = new Error('Model returned no JSON')
    } catch (e) {
      lastError = e // e.g. "JSON Mode couldn't be met" — retry once
    }
  }
  throw lastError
}

function recordStep(db: D1Database, runId: string, step: string, label: string, r: AiResult, items: number) {
  return db
    .prepare(
      `INSERT INTO ai_steps (run_id, step, label, duration_ms, prompt_tokens, completion_tokens, attempts, items) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (run_id, step) DO UPDATE SET label = excluded.label, duration_ms = excluded.duration_ms, prompt_tokens = excluded.prompt_tokens,
         completion_tokens = excluded.completion_tokens, attempts = excluded.attempts, items = excluded.items`,
    )
    .bind(runId, step, label, r.durationMs, r.promptTokens, r.completionTokens, r.attempts, items)
}

const stepInfo = (r: AiResult) => ({ durationMs: r.durationMs, attempts: r.attempts, completionTokens: r.completionTokens })

// Reset the run's AI results and return the extraction chunks.
workersAi.post('/runs/:id/ai/start', async (c) => {
  const userId = getAuth(c)!.userId!
  const runId = c.req.param('id')
  const db = c.env.DB
  if (!(await ownsRun(db, runId, userId))) return c.json({ error: 'not found' }, 404)
  const chunks = chunkByArticle(await sections(db, runId, 'regulation'))
  await db.batch([
    db.prepare('DELETE FROM tasks WHERE run_id = ?').bind(runId),
    db.prepare('DELETE FROM assessments WHERE run_id = ?').bind(runId),
    db.prepare('DELETE FROM requirements WHERE run_id = ?').bind(runId),
    db.prepare('DELETE FROM ai_steps WHERE run_id = ?').bind(runId),
    db.prepare(`UPDATE runs SET status = 'awaiting_ai', engine = ?, ai_started_at = ?, ai_finished_at = NULL WHERE id = ?`)
      .bind(ENGINE, Date.now(), runId),
  ])
  return c.json({ chunks: chunks.map(chunkLabel) })
})

// Stage 2 — extract the requirements of one chunk of articles. Chunks are independent and run in parallel.
workersAi.post('/runs/:id/ai/extract', async (c) => {
  const userId = getAuth(c)!.userId!
  const runId = c.req.param('id')
  const db = c.env.DB
  if (!(await ownsRun(db, runId, userId))) return c.json({ error: 'not found' }, 404)
  const chunks = chunkByArticle(await sections(db, runId, 'regulation'))
  const n = Number(c.req.query('chunk') ?? -1)
  if (!Number.isInteger(n) || n < 0 || n >= chunks.length) return c.json({ error: 'invalid chunk' }, 400)
  const label = chunkLabel(chunks[n])

  const { system, user } = extractPrompt(chunks[n])
  let r: AiResult
  try {
    r = await runJson(c.env.AI, system, user, EXTRACT_SCHEMA)
  } catch (e) {
    return c.json({ error: `Workers AI failed on ${label}: ${(e as Error).message}` }, 502)
  }
  const reqs = cleanExtract(r.data.requirements, chunks[n])
  // Temporary ids (X<ord>) — /ai/number assigns R01… in article order once all chunks are in.
  const insert = db.prepare(
    'INSERT INTO requirements (run_id, rid, section_sid, ref_label, quote, summary, ord) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
  await db.batch([
    db.prepare(`DELETE FROM requirements WHERE run_id = ? AND rid LIKE 'X%' AND section_sid IN (SELECT value FROM json_each(?))`)
      .bind(runId, JSON.stringify(chunks[n].map((s) => s.sid))),
    ...reqs.map((q) => insert.bind(runId, `X${q.ord}`, q.section_sid, q.ref_label, q.quote, q.summary, q.ord)),
    recordStep(db, runId, `extract:${n}`, `Extract ${label}`, r, reqs.length),
  ])
  return c.json({ label, added: reqs.length, ...stepInfo(r) })
})

// Assign R01… in source order after all chunks are extracted.
workersAi.post('/runs/:id/ai/number', async (c) => {
  const userId = getAuth(c)!.userId!
  const runId = c.req.param('id')
  const db = c.env.DB
  if (!(await ownsRun(db, runId, userId))) return c.json({ error: 'not found' }, 404)
  const { results } = await db.prepare('SELECT rid FROM requirements WHERE run_id = ? ORDER BY ord').bind(runId).all<{ rid: string }>()
  if (results.length === 0) return c.json({ error: 'No requirements extracted' }, 409)
  const rename = db.prepare('UPDATE requirements SET rid = ?, ord = ? WHERE run_id = ? AND rid = ?')
  await db.batch(results.map((r, i) => rename.bind(`R${String(i + 1).padStart(2, '0')}`, i, runId, r.rid)))
  return c.json({ total: results.length, batches: Math.ceil(results.length / ASSESS_BATCH) })
})

// Stages 3–4 — map and rate one batch of requirements. Batches are independent and run in parallel.
workersAi.post('/runs/:id/ai/assess', async (c) => {
  const userId = getAuth(c)!.userId!
  const runId = c.req.param('id')
  const db = c.env.DB
  if (!(await ownsRun(db, runId, userId))) return c.json({ error: 'not found' }, 404)
  const { results: all } = await db
    .prepare('SELECT rid, ref_label, quote, summary FROM requirements WHERE run_id = ? ORDER BY ord')
    .bind(runId)
    .all<{ rid: string; ref_label: string; quote: string; summary: string }>()
  const batches = Math.ceil(all.length / ASSESS_BATCH)
  const b = Number(c.req.query('batch') ?? -1)
  if (!Number.isInteger(b) || b < 0 || b >= batches) return c.json({ error: 'invalid batch' }, 400)
  const batch = all.slice(b * ASSESS_BATCH, (b + 1) * ASSESS_BATCH)
  const label = `Assess ${batch[0].rid}–${batch[batch.length - 1].rid}`

  const policy = await sections(db, runId, 'policy')
  const { system, user } = assessPrompt(batch, policy)
  let r: AiResult
  try {
    r = await runJson(c.env.AI, system, user, ASSESS_SCHEMA)
  } catch (e) {
    return c.json({ error: `Workers AI failed on ${label}: ${(e as Error).message}` }, 502)
  }
  const assessed = cleanAssess(r.data.assessments, batch, policy)
  const upsert = db.prepare(
    `INSERT INTO assessments (run_id, rid, policy_sids, policy_quote, rating, reason, proposed_text) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (run_id, rid) DO UPDATE SET policy_sids = excluded.policy_sids, policy_quote = excluded.policy_quote,
       rating = excluded.rating, reason = excluded.reason, proposed_text = excluded.proposed_text`,
  )
  await db.batch([
    ...assessed.map((a) => upsert.bind(runId, a.rid, JSON.stringify(a.policy_sids), a.policy_quote, a.rating, a.reason, a.proposed_text)),
    recordStep(db, runId, `assess:${b}`, label, r, batch.length),
  ])
  return c.json({ label, ...stepInfo(r) })
})

// Every requirement gets a rating; the run is marked assessed and the wall-clock time is stored.
workersAi.post('/runs/:id/ai/finish', async (c) => {
  const userId = getAuth(c)!.userId!
  const runId = c.req.param('id')
  const db = c.env.DB
  if (!(await ownsRun(db, runId, userId))) return c.json({ error: 'not found' }, 404)
  const now = Date.now()
  await db.batch([
    db.prepare(
      `INSERT INTO assessments (run_id, rid, rating, reason)
       SELECT run_id, rid, 'missing', 'Not assessed by the model — review manually.' FROM requirements q
       WHERE q.run_id = ? AND NOT EXISTS (SELECT 1 FROM assessments a WHERE a.run_id = q.run_id AND a.rid = q.rid)`,
    ).bind(runId),
    db.prepare(`UPDATE runs SET status = 'assessed', ai_finished_at = ? WHERE id = ?`).bind(now, runId),
  ])
  const run = await db.prepare('SELECT ai_started_at FROM runs WHERE id = ?').bind(runId).first<{ ai_started_at: number | null }>()
  return c.json({ wallMs: run?.ai_started_at ? now - run.ai_started_at : null })
})
