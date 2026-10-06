#!/usr/bin/env node
// Bridge between Claude Code (the AI engine) and the app's D1 database.
//
//   node scripts/gapcheck.mjs sections <runId|latest> [--local]   → prints the run's stored sections as JSON
//   node scripts/gapcheck.mjs import <results.json> [--local|--print]
//        validates the AI results and writes requirements + assessments, then marks the run "assessed".
//        --print only prints the SQL (for the Cloudflare D1 MCP tool instead of wrangler).
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DB = 'limmat-after-dark-db'
const [cmd, arg, ...flags] = process.argv.slice(2)
const target = flags.includes('--local') ? '--local' : '--remote'

const q = (v) => `'${String(v).replaceAll("'", "''")}'`
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx'

function d1(args) {
  return execFileSync(npx, ['wrangler', 'd1', 'execute', DB, target, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    shell: process.platform === 'win32',
  })
}

function query(sql) {
  const out = JSON.parse(d1(['--json', '--command', sql]))
  return out[0].results
}

if (cmd === 'sections') {
  const runId =
    arg === 'latest' || !arg ? query('SELECT id FROM runs ORDER BY created_at DESC, rowid DESC LIMIT 1')[0]?.id : arg
  if (!runId) throw new Error('No run found')
  const sections = query(`SELECT sid, kind, ref, heading, text FROM sections WHERE run_id = ${q(runId)} ORDER BY kind DESC, ord`)
  console.log(JSON.stringify({ runId, sections }, null, 2))
} else if (cmd === 'import') {
  const input = JSON.parse(readFileSync(arg, 'utf8'))
  const sql = toSql(validate(input))
  if (flags.includes('--print')) {
    console.log(sql)
  } else {
    const file = join(mkdtempSync(join(tmpdir(), 'gapcheck-')), 'import.sql')
    writeFileSync(file, sql)
    d1(['--file', file, '--yes'])
    console.log(`Imported ${input.requirements.length} requirements into run ${input.runId}`)
  }
} else {
  console.error('usage: gapcheck.mjs sections <runId|latest> [--local] | import <results.json> [--local|--print]')
  process.exit(1)
}

function validate(input) {
  const fail = (m) => {
    throw new Error(`Invalid results file: ${m}`)
  }
  if (typeof input.runId !== 'string') fail('runId missing')
  if (!Array.isArray(input.requirements) || input.requirements.length === 0) fail('requirements must be a non-empty array')
  const rids = new Set()
  for (const [i, r] of input.requirements.entries()) {
    const at = `requirements[${i}]`
    for (const k of ['rid', 'section_sid', 'ref_label', 'quote', 'summary'])
      if (typeof r[k] !== 'string' || !r[k].trim()) fail(`${at}.${k} must be a non-empty string`)
    if (rids.has(r.rid)) fail(`${at}.rid "${r.rid}" is duplicated`)
    rids.add(r.rid)
    const a = r.assessment
    if (!a) fail(`${at}.assessment missing`)
    if (!['covered', 'partial', 'missing'].includes(a.rating)) fail(`${at}.assessment.rating must be covered|partial|missing`)
    if (!Array.isArray(a.policy_sids)) fail(`${at}.assessment.policy_sids must be an array`)
    if (a.rating !== 'missing' && (a.policy_sids.length === 0 || !a.policy_quote?.trim()))
      fail(`${at}: a ${a.rating} rating needs policy_sids and a policy_quote`)
    if (typeof a.reason !== 'string' || !a.reason.trim()) fail(`${at}.assessment.reason missing`)
    if (a.rating !== 'covered' && !a.proposed_text?.trim()) fail(`${at}: a gap needs proposed_text`)
  }
  return input
}

function toSql({ runId, requirements }) {
  const lines = [
    `DELETE FROM tasks WHERE run_id = ${q(runId)};`,
    `DELETE FROM assessments WHERE run_id = ${q(runId)};`,
    `DELETE FROM requirements WHERE run_id = ${q(runId)};`,
  ]
  requirements.forEach((r, ord) => {
    const a = r.assessment
    lines.push(
      `INSERT INTO requirements (run_id, rid, section_sid, ref_label, quote, summary, ord) VALUES (${[runId, r.rid, r.section_sid, r.ref_label, r.quote, r.summary].map(q).join(', ')}, ${ord});`,
      `INSERT INTO assessments (run_id, rid, policy_sids, policy_quote, rating, reason, proposed_text) VALUES (${[runId, r.rid, JSON.stringify(a.policy_sids), a.policy_quote ?? '', a.rating, a.reason, a.proposed_text ?? ''].map(q).join(', ')});`,
    )
  })
  lines.push(`UPDATE runs SET status = 'assessed' WHERE id = ${q(runId)};`)
  return lines.join('\n') + '\n'
}
