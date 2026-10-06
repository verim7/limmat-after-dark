// Pure logic for the in-app AI engine (Workers AI): chunking, prompts, schemas and guardrails.
// The model only proposes; everything it returns is checked against the stored sections here.

import { quoteIsVerbatim } from './segment'

export type StoredSection = { sid: string; ref: string; heading: string; text: string }
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
- Every quote must be copied character for character from the cited section (German, unchanged). No ellipses, no paraphrase.
- Write summaries and reasons in English.`

export function extractPrompt(chunk: StoredSection[]) {
  const system = `You are a Swiss compliance analyst. Split regulation paragraphs into single, checkable obligations of the financial service provider.
${RULES}
- One requirement per distinct duty. Skip pure definitions, options without a duty, exemptions and delegations to the Federal Council unless an internal policy must reflect them.
- Always extract: the client segment rules and definitions (which clients are private, professional, institutional) and every paragraph on opting-out or opting-in, including the client's right to opt out, the conditions and the form of the declaration.`
  const user =
    'Regulation sections (FIDLEG):\n' +
    chunk.map((s) => `[${s.sid}] ${s.ref}\n${s.text}`).join('\n\n') +
    '\n\nReturn JSON: {"requirements": [{"section_sid": "...", "quote": "...", "summary": "..."}]}'
  return { system, user }
}

export const EXTRACT_SCHEMA = {
  type: 'object',
  properties: {
    requirements: {
      type: 'array',
      items: {
        type: 'object',
        properties: { section_sid: { type: 'string' }, quote: { type: 'string' }, summary: { type: 'string' } },
        required: ['section_sid', 'quote', 'summary'],
      },
    },
  },
  required: ['requirements'],
}

export type ExtractItem = { section_sid: string; quote: string; summary: string }
export type CleanRequirement = { section_sid: string; ref_label: string; quote: string; summary: string }

/** Guardrails for stage 2: known sids only, refs from storage, quotes verbatim or the full section text. */
export function cleanExtract(items: unknown, chunk: StoredSection[]): CleanRequirement[] {
  const bySid = new Map(chunk.map((s) => [s.sid, s]))
  const out: CleanRequirement[] = []
  for (const it of Array.isArray(items) ? (items as Partial<ExtractItem>[]) : []) {
    const section = typeof it?.section_sid === 'string' ? bySid.get(it.section_sid.trim()) : undefined
    if (!section) continue
    const quote = typeof it.quote === 'string' && quoteIsVerbatim(section.text, it.quote) ? it.quote.trim() : section.text
    const summary = typeof it.summary === 'string' && it.summary.trim() ? it.summary.trim() : section.heading
    if (out.some((r) => r.section_sid === section.sid && r.quote === quote)) continue
    out.push({ section_sid: section.sid, ref_label: section.ref, quote, summary })
  }
  return out
}

export function assessPrompt(
  reqs: { rid: string; ref_label: string; quote: string; summary: string }[],
  policy: StoredSection[],
) {
  const system = `You are a Swiss compliance analyst. For each regulatory requirement, find the internal policy sections that address it and rate the coverage.
${RULES}
- rating: "covered" = the policy fully meets the requirement, including when it meets or exceeds it (for example reporting more often, or informing earlier, than the law requires); "partial" = the policy addresses the topic but leaves out an element the law requires (name that element); "missing" = no policy section addresses it.
- A general duty that the policy's scope clause already commits to (for example "comply with the duties of this Act") counts as covered by that clause.
- For "missing", policy_sids must be [] and policy_quote "". Never guess a section.
- proposed_text: REQUIRED for "partial" and "missing": a German policy clause that closes the gap. "" for "covered".`
  const user =
    'Internal policy sections (Weisung W-07):\n' +
    policy.map((s) => `[${s.sid}] ${s.ref}\n${s.text}`).join('\n\n') +
    '\n\nRequirements to assess:\n' +
    reqs.map((r) => `[${r.rid}] ${r.ref_label}: ${r.summary}\nLaw text: ${r.quote}`).join('\n\n') +
    '\n\nReturn JSON: {"assessments": [{"rid": "...", "policy_sids": ["..."], "policy_quote": "...", "rating": "covered|partial|missing", "reason": "...", "proposed_text": "..."}]}'
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
          policy_quote: { type: 'string' },
          rating: { type: 'string', enum: ['covered', 'partial', 'missing'] },
          reason: { type: 'string' },
          proposed_text: { type: 'string' },
        },
        required: ['rid', 'policy_sids', 'policy_quote', 'rating', 'reason', 'proposed_text'],
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

/** Guardrails for stages 3–4: known policy sids only, consistent ratings, verbatim quotes, every requirement rated. */
export function cleanAssess(items: unknown, rids: string[], policy: StoredSection[]): CleanAssessment[] {
  const bySid = new Map(policy.map((s) => [s.sid, s]))
  const byRid = new Map<string, Record<string, unknown>>()
  for (const it of Array.isArray(items) ? (items as Record<string, unknown>[]) : []) {
    if (typeof it?.rid === 'string' && rids.includes(it.rid.trim()) && !byRid.has(it.rid.trim())) byRid.set(it.rid.trim(), it)
  }
  return rids.map((rid) => withProposalNote(assessOne(rid, byRid.get(rid), bySid)))
}

// A gap without a proposed clause is flagged, so the reviewer sees it immediately.
function withProposalNote(a: CleanAssessment): CleanAssessment {
  if (a.rating === 'covered' || a.proposed_text || a.reason.includes('[No proposal')) return a
  return { ...a, reason: `${a.reason} [No proposal from the model — draft the policy text in review.]` }
}

function assessOne(rid: string, it: Record<string, unknown> | undefined, bySid: Map<string, StoredSection>): CleanAssessment {
  if (!it) {
    return { rid, policy_sids: [], policy_quote: '', rating: 'missing', reason: 'Not assessed by the model — review manually.', proposed_text: '' }
  }
  let rating: Rating = it.rating === 'covered' || it.rating === 'partial' || it.rating === 'missing' ? it.rating : 'missing'
  let reason = typeof it.reason === 'string' && it.reason.trim() ? it.reason.trim() : 'No reason given by the model.'
  const sids = (Array.isArray(it.policy_sids) ? it.policy_sids : [])
    .map((s) => String(s).trim())
    .filter((s, i, all) => bySid.has(s) && all.indexOf(s) === i)
  let quote = typeof it.policy_quote === 'string' ? it.policy_quote.trim() : ''
  if (rating === 'missing') {
    return { rid, policy_sids: [], policy_quote: '', rating, reason, proposed_text: str(it.proposed_text) }
  }
  if (sids.length === 0) {
    rating = 'missing'
    reason = `${reason} [Model named no existing W-07 section; rated missing.]`
    return { rid, policy_sids: [], policy_quote: '', rating, reason, proposed_text: str(it.proposed_text) }
  }
  if (!sids.some((s) => quoteIsVerbatim(bySid.get(s)!.text, quote))) quote = bySid.get(sids[0])!.text
  return { rid, policy_sids: sids, policy_quote: quote, rating, reason, proposed_text: rating === 'covered' ? '' : str(it.proposed_text) }
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
