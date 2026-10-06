// Pure logic for the in-app AI engine (Workers AI): chunking, prompts, schemas and guardrails.
// The model only proposes; everything it returns is checked against the stored sections here.
// Output is kept small on purpose (no quotes from the model): generation time dominates latency,
// and every quote is filled in server-side from the stored source text, so it is always exact.

import { normalize } from './segment'

export type StoredSection = { sid: string; ref: string; heading: string; text: string; ord: number }
export type Rating = 'covered' | 'partial' | 'missing'

export const WORKERS_AI_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast'
export const ASSESS_BATCH = 6

/** Groups regulation sections by article into chunks of roughly `target` sections, never splitting an article. */
export function chunkByArticle(sections: StoredSection[], target = 11): StoredSection[][] {
  const byArticle = new Map<string, StoredSection[]>()
  for (const s of sections) {
    const art = s.sid.split('.')[0]
    byArticle.set(art, [...(byArticle.get(art) ?? []), s])
  }
  const chunks: StoredSection[][] = []
  let current: StoredSection[] = []
  for (const group of byArticle.values()) {
    if (current.length && current.length + group.length > target) {
      chunks.push(current)
      current = []
    }
    current.push(...group)
  }
  if (current.length) {
    // Merge a small tail (e.g. a single short article) into the previous chunk.
    if (chunks.length && current.length < 4) chunks[chunks.length - 1].push(...current)
    else chunks.push(current)
  }
  return chunks
}

export function chunkLabel(chunk: StoredSection[]): string {
  const first = chunk[0]?.ref.match(/Art\. (\S+)/)?.[1]
  const last = chunk[chunk.length - 1]?.ref.match(/Art\. (\S+)/)?.[1]
  return first === last ? `Art. ${first}` : `Art. ${first}–${last}`
}

const RULES = `Rules:
- Use ONLY the sections given below. No outside legal knowledge, no other articles, no other sources.
- Cite sections only by their exact "sid".
- Write summaries and reasons in English. Be concise.`

// ---------------------------------------------------------------------------
// Stage 2 — extract requirements

export function extractPrompt(chunk: StoredSection[]) {
  const system = `You are a Swiss compliance analyst. Turn regulation paragraphs into single, checkable requirements for a bank's internal policy.
${RULES}
- One requirement per distinct duty of the financial service provider. Skip pure definitions, exemptions and delegations to the Federal Council unless the policy must reflect them.
- Client segmentation: include the duty to segment clients and the definitions of each client segment.
- Client options (rights the client may exercise, e.g. opting-out or opting-in): ONE requirement per option, covering its conditions and the form of the declaration. Do not create separate requirements for the conditions or the form.
- Include the provider's duty to inform clients about such options.`
  const user =
    'Regulation sections (FIDLEG):\n' +
    chunk.map((s) => `[${s.sid}] ${s.ref}\n${s.text}`).join('\n\n') +
    '\n\nReturn JSON: {"requirements": [{"section_sid": "...", "summary": "one sentence: what the provider must do"}]}'
  return { system, user }
}

export const EXTRACT_SCHEMA = {
  type: 'object',
  properties: {
    requirements: {
      type: 'array',
      items: {
        type: 'object',
        properties: { section_sid: { type: 'string' }, summary: { type: 'string' } },
        required: ['section_sid', 'summary'],
      },
    },
  },
  required: ['requirements'],
}

export type CleanRequirement = { section_sid: string; ref_label: string; quote: string; summary: string; ord: number }

/** Guardrails for stage 2: known sids only, refs and quotes from storage, no duplicates, in source order. */
export function cleanExtract(items: unknown, chunk: StoredSection[]): CleanRequirement[] {
  const bySid = new Map(chunk.map((s) => [s.sid, s]))
  const out: CleanRequirement[] = []
  const perSection = new Map<string, number>()
  for (const it of Array.isArray(items) ? (items as Record<string, unknown>[]) : []) {
    const section = typeof it?.section_sid === 'string' ? bySid.get(it.section_sid.trim()) : undefined
    if (!section) continue
    const summary = typeof it.summary === 'string' && it.summary.trim() ? it.summary.trim() : section.heading
    if (out.some((r) => r.section_sid === section.sid && normalize(r.summary) === normalize(summary))) continue
    const n = perSection.get(section.sid) ?? 0
    perSection.set(section.sid, n + 1)
    out.push({ section_sid: section.sid, ref_label: section.ref, quote: section.text, summary, ord: section.ord * 100 + n })
  }
  return out
}

// ---------------------------------------------------------------------------
// Stages 3–4 — map to policy sections and assess

export function assessPrompt(
  reqs: { rid: string; ref_label: string; quote: string; summary: string }[],
  policy: StoredSection[],
) {
  const system = `You are a Swiss compliance analyst. For each regulatory requirement, find the internal policy sections that address it and rate the coverage.
${RULES}
- rating: "covered" = the policy meets the requirement, including when it meets or exceeds it (e.g. reports more often or informs earlier than required). "partial" = the policy addresses the topic but leaves out an element the law requires; name that element. "missing" = no policy section addresses it.
- A general duty to comply with the duties of this Act is covered by the policy's purpose and scope section.
- Judge each requirement only on what it asks. A timing requirement is covered if the policy states the same timing, even if other information duties are incomplete.
- For "missing", policy_sids must be [].
- proposed_text: REQUIRED for "partial" and "missing". Write it in German as a new clause of the bank's internal policy W-07, in the policy's own voice (e.g. "Die Bank …" or "Die Kundenberaterin oder der Kundenberater …"), concrete about the missing element. Never copy the law text. "" for "covered".`
  const user =
    'Internal policy sections (Weisung W-07):\n' +
    policy.map((s) => `[${s.sid}] ${s.ref}\n${s.text}`).join('\n\n') +
    '\n\nRequirements to assess:\n' +
    reqs.map((r) => `[${r.rid}] ${r.ref_label}: ${r.summary}\nLaw text: ${r.quote}`).join('\n\n') +
    '\n\nReturn JSON: {"assessments": [{"rid": "...", "policy_sids": ["..."], "rating": "covered|partial|missing", "reason": "...", "proposed_text": "..."}]}'
  return { system, user }
}

export const ASSESS_SCHEMA = {
  type: 'object',
  properties: {
    assessments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          rid: { type: 'string' },
          policy_sids: { type: 'array', items: { type: 'string' } },
          rating: { type: 'string', enum: ['covered', 'partial', 'missing'] },
          reason: { type: 'string' },
          proposed_text: { type: 'string' },
        },
        required: ['rid', 'policy_sids', 'rating', 'reason', 'proposed_text'],
      },
    },
  },
  required: ['assessments'],
}

export type CleanAssessment = {
  rid: string
  policy_sids: string[]
  policy_quote: string
  rating: Rating
  reason: string
  proposed_text: string
}

/**
 * Guardrails for stages 3–4: known policy sids only, consistent ratings, policy quote from storage,
 * every requirement rated, and proposals that merely repeat the law are rejected.
 */
export function cleanAssess(
  items: unknown,
  reqs: { rid: string; quote: string }[],
  policy: StoredSection[],
): CleanAssessment[] {
  const bySid = new Map(policy.map((s) => [s.sid, s]))
  const rids = reqs.map((r) => r.rid)
  const byRid = new Map<string, Record<string, unknown>>()
  for (const it of Array.isArray(items) ? (items as Record<string, unknown>[]) : []) {
    const rid = typeof it?.rid === 'string' ? it.rid.trim() : ''
    if (rids.includes(rid) && !byRid.has(rid)) byRid.set(rid, it)
  }
  return reqs.map((r) => checkProposal(assessOne(r.rid, byRid.get(r.rid), bySid), r.quote))
}

function assessOne(rid: string, it: Record<string, unknown> | undefined, bySid: Map<string, StoredSection>): CleanAssessment {
  if (!it) {
    return { rid, policy_sids: [], policy_quote: '', rating: 'missing', reason: 'Not assessed by the model — review manually.', proposed_text: '' }
  }
  let rating: Rating = it.rating === 'covered' || it.rating === 'partial' || it.rating === 'missing' ? it.rating : 'missing'
  let reason = typeof it.reason === 'string' && it.reason.trim() ? it.reason.trim() : 'No reason given by the model.'
  const proposal = str(it.proposed_text)
  const sids = (Array.isArray(it.policy_sids) ? it.policy_sids : [])
    .map((s) => String(s).trim())
    .filter((s, i, all) => bySid.has(s) && all.indexOf(s) === i)
  if (rating === 'missing') return { rid, policy_sids: [], policy_quote: '', rating, reason, proposed_text: proposal }
  if (sids.length === 0) {
    rating = 'missing'
    reason = `${reason} [Model named no existing W-07 section; rated missing.]`
    return { rid, policy_sids: [], policy_quote: '', rating, reason, proposed_text: proposal }
  }
  // The policy quote is the exact stored text of the first mapped section.
  return { rid, policy_sids: sids, policy_quote: bySid.get(sids[0])!.text, rating, reason, proposed_text: rating === 'covered' ? '' : proposal }
}

/** Flags gaps without a proposal, and drops proposals that only repeat the law text. */
function checkProposal(a: CleanAssessment, lawText: string): CleanAssessment {
  if (a.rating === 'covered') return a
  if (a.proposed_text && repeatsLaw(a.proposed_text, lawText)) {
    return { ...a, proposed_text: '', reason: `${a.reason} [The model's proposal only repeated the law text; draft the policy clause in review.]` }
  }
  if (!a.proposed_text) return { ...a, reason: `${a.reason} [No proposal from the model; draft the policy clause in review.]` }
  return a
}

// Signs that a clause is written in the internal policy's own voice rather than copied from the law.
const POLICY_VOICE = /\b(bank|kundenberater\w*|weisung|ziff\.)/i

/**
 * True when the proposal is (nearly) the law text: identical / contained, or the same words without
 * being rewritten in the policy's voice ("Die Bank …", "Ziff. …"). Adapted clauses are kept.
 */
export function repeatsLaw(proposal: string, law: string): boolean {
  const p = normalize(proposal).toLowerCase()
  const l = normalize(law).toLowerCase()
  if (!p || !l) return false
  if (l.includes(p) || p.includes(l)) return true
  if (POLICY_VOICE.test(proposal)) return false
  const words = (s: string) => new Set(s.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 3))
  const pw = words(p)
  const lw = words(l)
  if (pw.size === 0) return false
  let shared = 0
  for (const w of pw) if (lw.has(w)) shared++
  return shared / pw.size >= 0.85
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

/** Workers AI JSON mode returns either an object or a JSON string in `response`. */
export function parseAiResponse(res: unknown): Record<string, unknown> | null {
  const r = (res as { response?: unknown })?.response ?? res
  if (r && typeof r === 'object') return r as Record<string, unknown>
  if (typeof r === 'string') {
    const m = r.match(/\{[\s\S]*\}/)
    try {
      return m ? JSON.parse(m[0]) : null
    } catch {
      return null
    }
  }
  return null
}

/** Token usage as reported by Workers AI (absent on some models). */
export function parseUsage(res: unknown): { prompt_tokens: number | null; completion_tokens: number | null } {
  const u = (res as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } })?.usage
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  return { prompt_tokens: n(u?.prompt_tokens), completion_tokens: n(u?.completion_tokens) }
}
