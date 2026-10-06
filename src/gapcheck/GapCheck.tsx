import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { useApi, useAuthedFetch } from '../api'
import { findStand } from '../../shared/segment'
import type { Rating, RegisterEntry, Requirement, RunData, Section, Task } from './types'

const RATING_LABEL: Record<Rating, string> = { covered: 'Covered', partial: 'Partially covered', missing: 'Missing' }

export default function GapCheck() {
  const api = useApi()
  const [data, setData] = useState<RunData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [newRun, setNewRun] = useState(false)

  const refresh = useCallback(
    () => api<RunData>('/runs/latest').then(setData, (e: Error) => setError(e.message)),
    [api],
  )
  const ai = useWorkersAiRunner(useCallback(() => void refresh(), [refresh]))
  useEffect(() => void refresh(), [refresh])

  // Poll while Claude Code is working on the run.
  const waiting = data?.run?.status === 'awaiting_ai'
  useEffect(() => {
    if (!waiting) return
    const t = setInterval(refresh, 5000)
    return () => clearInterval(t)
  }, [waiting, refresh])

  if (error) return <p className="error">{error}</p>
  if (!data) return <p className="muted">Loading…</p>

  if (!data.run || newRun) {
    return (
      <LoadStep
        onLoaded={() => {
          setNewRun(false)
          refresh()
        }}
      />
    )
  }

  return (
    <>
      <RunHeader data={data} onNew={() => setNewRun(true)} />
      <AiProgress ai={ai} />
      {waiting ? (
        <AwaitingAi data={data} ai={ai} />
      ) : (
        <>
          <Report runId={data.run.id} requirements={data.requirements ?? []} onChange={refresh} ai={ai} />
          <TaskList runId={data.run.id} requirements={data.requirements ?? []} tasks={data.tasks ?? []} onChange={refresh} />
        </>
      )}
    </>
  )
}

// Saved exercise documents (public/samples): the policy W-07 and the internal policy register.
const SAVED_POLICY = { url: '/samples/Weisung_W-07_Kundensegmentierung_und_Pruefung.pdf', filename: 'Weisung_W-07_Kundensegmentierung_und_Pruefung.pdf' }
const SAVED_REGISTER_URL = '/samples/internal_policies_and_processes.csv'
// Fetched server-side by the Worker from the official link on the exercise sheet (see worker/routes/sources.ts).
const FIDLEG_SOURCE = { key: 'fidleg-de-2026-10-01', label: 'FIDLEG (SR 950.1), German, Stand 1. Oktober 2026' }

function parseCsv(text: string): RegisterEntry[] {
  const rows = text.trim().split(/\r?\n/).map((line) => [...line.matchAll(/("([^"]*)"|[^,]*)(,|$)/g)].map((m) => m[2] ?? m[1]).slice(0, -1))
  const [header, ...body] = rows
  return body.map((cells) => Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ''])) as RegisterEntry)
}

async function fetchFile(url: string, filename: string): Promise<File> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Could not load ${filename}`)
  return new File([await res.blob()], filename, { type: res.headers.get('content-type') ?? '' })
}

// Stage 1 — Load
function LoadStep({ onLoaded }: { onLoaded: () => void }) {
  const api = useApi()
  const [regFile, setRegFile] = useState<File | null>(null)
  const [polFile, setPolFile] = useState<File | null>(null)
  const [savedReg, setSavedReg] = useState<string | null>(null)
  const [register, setRegister] = useState<RegisterEntry | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const authedFetch = useAuthedFetch()

  useEffect(() => {
    api<{ regulation: { filename: string } | null }>('/saved').then((s) => setSavedReg(s.regulation?.filename ?? null), () => {})
    fetch(SAVED_REGISTER_URL)
      .then((r) => r.text())
      .then((csv) => setRegister(parseCsv(csv).find((e) => e.id === 'W-07') ?? null), () => {})
  }, [api])

  type RegInput = { filename: string; text: string } | { reuseLatest: true }

  async function run(getRegulation: () => Promise<RegInput>, getPolicy: () => Promise<File>) {
    setBusy(true)
    setError(null)
    try {
      const { fileToText } = await import('../pdf') // pdf.js is large; load it only when needed
      const policyFile = await getPolicy()
      const [regulation, policyText] = await Promise.all([getRegulation(), fileToText(policyFile)])
      await api('/runs', {
        method: 'POST',
        body: JSON.stringify({ regulation, policy: { filename: policyFile.name, text: policyText } }),
      })
      onLoaded()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const readRegFile = async (file: File): Promise<RegInput> => {
    const { fileToText } = await import('../pdf')
    return { filename: file.name, text: await fileToText(file, { stripFootnotes: true }) }
  }

  function uploadBoth(e: FormEvent) {
    e.preventDefault()
    if (regFile && polFile) void run(() => readRegFile(regFile), async () => polFile)
  }

  // Downloads the official FIDLEG PDF via the Worker and checks the printed "Stand am" date.
  const fetchFidleg = async (): Promise<RegInput> => {
    const { fileToText } = await import('../pdf')
    const res = await authedFetch(`/api/sources/${FIDLEG_SOURCE.key}`)
    if (!res.ok) throw new Error(`Could not fetch FIDLEG: ${res.status} ${await res.text()}`)
    const filename = res.headers.get('X-Source-Filename') ?? 'FIDLEG.pdf'
    const expected = res.headers.get('X-Expected-Stand')
    const text = await fileToText(new File([await res.blob()], filename, { type: 'application/pdf' }), { stripFootnotes: true })
    const stand = findStand(text)
    if (expected && stand !== expected) {
      throw new Error(`The fetched PDF is not the expected version: expected "Stand am ${expected}", found "${stand ?? 'no Stand date'}".`)
    }
    return { filename, text }
  }

  function useSaved() {
    void run(
      () => (regFile ? readRegFile(regFile) : savedReg ? Promise.resolve({ reuseLatest: true as const }) : fetchFidleg()),
      () => fetchFile(SAVED_POLICY.url, SAVED_POLICY.filename),
    )
  }

  return (
    <section className="panel">
      <p className="eyebrow">Step 1 · Load</p>
      <h2>Regulation gap check</h2>
      <p className="lede">
        Upload the regulation (FIDLEG, German PDF) and the internal policy (Weisung), or use the saved documents. Both
        are split into sections by their own numbering; Articles 4–16 are kept from the regulation.
      </p>
      <form onSubmit={uploadBoth} className="stack">
        <label className="file">
          <span>Regulation (FIDLEG PDF)</span>
          <input type="file" accept=".pdf,.txt" onChange={(e) => setRegFile(e.target.files?.[0] ?? null)} />
        </label>
        <label className="file">
          <span>Internal policy (Weisung PDF)</span>
          <input type="file" accept=".pdf,.txt" onChange={(e) => setPolFile(e.target.files?.[0] ?? null)} />
        </label>
        <button className="btn big" disabled={!regFile || !polFile || busy}>
          {busy ? 'Reading PDFs…' : 'Load and split into sections'}
        </button>
      </form>

      <div className="saved">
        <p className="eyebrow">Or use the saved documents</p>
        <ul className="muted small">
          <li>
            Policy: <code>{SAVED_POLICY.filename}</code>
            {register && (
              <>
                {' '}· register entry {register.id} “{register.title}”, owner {register.owner}, basis {register.regulatory_basis}
                {' '}(<code>internal_policies_and_processes.csv</code>)
              </>
            )}
          </li>
          <li>
            Regulation:{' '}
            {regFile ? (
              <>the file chosen above (<code>{regFile.name}</code>)</>
            ) : savedReg ? (
              <>last uploaded <code>{savedReg}</code></>
            ) : (
              <>{FIDLEG_SOURCE.label}, fetched from the official link on the exercise sheet</>
            )}
          </li>
        </ul>
        <button className="btn big ghost" disabled={busy} onClick={useSaved}>
          Use saved documents
        </button>
      </div>
      {error && <p className="error">{error}</p>}
    </section>
  )
}

function RunHeader({ data, onNew }: { data: RunData; onNew: () => void }) {
  const reqs = data.requirements ?? []
  const count = (r: Rating) => reqs.filter((q) => q.assessment?.effectiveRating === r).length
  const reviewed = reqs.filter((q) => q.assessment && q.assessment.review_status !== 'pending').length
  return (
    <section className="panel run">
      <div>
        <p className="eyebrow">Run {data.run!.id.slice(0, 8)}</p>
        <p className="muted small">
          {data.run!.engine && <>AI step: <strong>{engineLabel(data.run!.engine)}</strong> · </>}
          {data.documents?.map((d) => d.filename).join(' vs. ')} · {data.sections?.regulation.length} regulation sections ·{' '}
          {data.sections?.policy.length} policy sections
        </p>
      </div>
      {data.run!.status === 'assessed' && (
        <div className="stats">
          <Stat n={reqs.length} label="requirements" />
          <Stat n={count('covered')} label="covered" tone="covered" />
          <Stat n={count('partial')} label="partial" tone="partial" />
          <Stat n={count('missing')} label="missing" tone="missing" />
          <Stat n={reviewed} label={`of ${reqs.length} reviewed`} />
        </div>
      )}
      <button className="btn ghost" onClick={onNew}>New run</button>
    </section>
  )
}

function Stat({ n, label, tone }: { n: number; label: string; tone?: Rating }) {
  return (
    <div className={`stat ${tone ?? ''}`}>
      <strong>{n}</strong>
      <span>{label}</span>
    </div>
  )
}

// Stages 2–4: run in the app with Workers AI, or in Claude Code (no API key in the app).
function AwaitingAi({ data, ai }: { data: RunData; ai: WorkersAiRunner }) {
  return (
    <section className="panel">
      <p className="eyebrow">Steps 2–4 · Extract, map, assess</p>
      <h2>Run the AI step</h2>
      <p className="lede">The texts are stored and split. Choose an engine.</p>
      <div className="engines">
        <div className="engine">
          <h3>In the app · Workers AI</h3>
          <p className="muted small">
            Llama 3.3 70B on Cloudflare. Runs here in about 1–2 minutes. Every citation is checked against the stored text;
            the quality is lower than Claude, so review every rating.
          </p>
          <button className="btn big" disabled={ai.running} onClick={() => ai.start(data.run!.id)}>
            {ai.running ? 'Running…' : 'Run with Workers AI'}
          </button>
        </div>
        <div className="engine">
          <h3>Claude Code</h3>
          <p className="muted small">In Claude Code, inside this project, say:</p>
          <pre className="cmd">Run the gap check for run {data.run!.id}</pre>
          <p className="muted small">This page refreshes automatically when the results arrive.</p>
        </div>
      </div>
      <SectionList title="Regulation sections" sections={data.sections?.regulation ?? []} />
      <SectionList title="Policy sections" sections={data.sections?.policy ?? []} />
    </section>
  )
}

function engineLabel(engine: string) {
  if (engine === 'claude-code') return 'Claude Code'
  if (engine.startsWith('workers-ai:')) return `Workers AI · ${engine.includes('llama-3.3-70b') ? 'Llama 3.3 70B' : engine.slice(11)}`
  return engine
}

// Drives the Workers AI steps one short request at a time and reports progress.
type WorkersAiRunner = { running: boolean; progress: string | null; error: string | null; start: (runId: string) => void }

function useWorkersAiRunner(onStep: () => void): WorkersAiRunner {
  const api = useApi()
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const start = useCallback(
    async (runId: string) => {
      setRunning(true)
      setError(null)
      try {
        let chunks = 1
        for (let n = 0; n < chunks; n++) {
          setProgress(`Step 2 · Extracting requirements (${n + 1}/${chunks === 1 && n === 0 ? '…' : chunks})`)
          const r = await api<{ chunks: number; label: string; total: number }>(`/runs/${runId}/ai/extract?chunk=${n}`, { method: 'POST' })
          chunks = r.chunks
          setProgress(`Step 2 · ${r.label} done (${n + 1}/${chunks}) · ${r.total} requirements so far`)
        }
        let batches = 1
        for (let b = 0; b < batches; b++) {
          setProgress(`Steps 3–4 · Mapping and rating (${b + 1}/${batches === 1 && b === 0 ? '…' : batches})`)
          const r = await api<{ batches: number; from: string; to: string }>(`/runs/${runId}/ai/assess?batch=${b}`, { method: 'POST' })
          batches = r.batches
          setProgress(`Steps 3–4 · ${r.from}–${r.to} rated (${b + 1}/${batches})`)
          onStep()
        }
        setProgress(null)
      } catch (e) {
        setError((e as Error).message)
      } finally {
        setRunning(false)
        onStep()
      }
    },
    [api, onStep],
  )
  return { running, progress, error, start: (id) => void start(id) }
}

function AiProgress({ ai }: { ai: WorkersAiRunner }) {
  if (!ai.running && !ai.error) return null
  return (
    <section className={`panel ai-progress ${ai.error ? 'failed' : ''}`}>
      {ai.running && <span className="spinner" aria-hidden />}
      <span>{ai.error ? `Workers AI stopped: ${ai.error}` : ai.progress ?? 'Starting Workers AI…'}</span>
    </section>
  )
}

function SectionList({ title, sections }: { title: string; sections: Section[] }) {
  return (
    <details className="sections">
      <summary>
        {title} ({sections.length})
      </summary>
      <ul>
        {sections.map((s) => (
          <li key={s.sid}>
            <code>{s.ref}</code> {s.text}
          </li>
        ))}
      </ul>
    </details>
  )
}

// Policy register (internal_policies_and_processes.csv) for the impact selector.
function useRegister() {
  const [register, setRegister] = useState<RegisterEntry[]>([])
  useEffect(() => {
    fetch(SAVED_REGISTER_URL)
      .then((r) => r.text())
      .then((csv) => setRegister(parseCsv(csv)), () => {})
  }, [])
  return register
}

// Stages 5–6 — Review and report
function Report({ runId, requirements, onChange, ai }: { runId: string; requirements: Requirement[]; onChange: () => void; ai: WorkersAiRunner }) {
  const [onlyGaps, setOnlyGaps] = useState(true)
  const register = useRegister()
  const gaps = requirements.filter((r) => r.assessment && r.assessment.effectiveRating !== 'covered')
  const rows = onlyGaps ? gaps : requirements
  const pending = requirements.filter((r) => r.assessment?.review_status === 'pending').length
  return (
    <section className="panel">
      <div className="row between">
        <div>
          <p className="eyebrow">Steps 5–6 · Review and report</p>
          <h2>{onlyGaps ? `Gap table (${gaps.length})` : `All requirements (${requirements.length})`}</h2>
        </div>
        <div className="toggle">
          <button className={`btn small ${onlyGaps ? '' : 'ghost'}`} onClick={() => setOnlyGaps(true)}>Gaps</button>
          <button className={`btn small ${onlyGaps ? 'ghost' : ''}`} onClick={() => setOnlyGaps(false)}>All</button>
          <button
            className="btn small ghost"
            disabled={ai.running}
            onClick={() => {
              if (window.confirm('Re-run steps 2–4 with Workers AI? This replaces the current requirements, reviews and tasks of this run.')) ai.start(runId)
            }}
          >
            Re-run with Workers AI
          </button>
          <button className="btn small ghost" onClick={() => exportGapTable(runId, requirements)}>Download gap table (CSV)</button>
        </div>
      </div>
      <ArticleSummary requirements={requirements} />
      <p className="muted small">
        {pending > 0
          ? `${pending} AI rating${pending === 1 ? '' : 's'} still to review. Confirm or override each one; covered ratings are under "All".`
          : 'All ratings reviewed.'}{' '}
        ✓ means the cited reference and the quote were found verbatim in the stored source text; ⚠ means they were not.
      </p>
      <div className="findings">
        {rows.map((r) => (
          <Finding key={r.rid} runId={runId} r={r} register={register} onChange={onChange} />
        ))}
        {rows.length === 0 && <p className="muted">Nothing to show.</p>}
      </div>
    </section>
  )
}

function Finding({ runId, r, register, onChange }: { runId: string; r: Requirement; register: RegisterEntry[]; onChange: () => void }) {
  const a = r.assessment
  const regOk = r.refVerified && r.quoteVerified
  const rating = a?.effectiveRating
  return (
    <article className={`finding ${rating ?? ''}`}>
      <header>
        <span className={`chip ${rating ?? ''}`}>{rating ? RATING_LABEL[rating] : 'Not rated'}</span>
        <strong>{r.rid}</strong> <span>{r.summary}</span>
      </header>
      <div className="sides">
        <div>
          <p className="side-label">
            Regulation · <code>{r.ref_label}</code> <Check ok={regOk} />
          </p>
          <Passage text={r.section?.text ?? ''} quote={r.quote} />
        </div>
        <div>
          <p className="side-label">
            Policy ·{' '}
            {a && a.policySections.length > 0 ? (
              a.policySections.map((s) => <code key={s.sid}>{s.ref}</code>)
            ) : (
              <em>no section addresses this</em>
            )}{' '}
            {a && <Check ok={a.policyVerified} />}
          </p>
          {a?.policySections.map((s) => <Passage key={s.sid} text={s.text} quote={a.policy_quote} />)}
        </div>
      </div>
      {a && (
        <div className="assessment">
          <p><strong>AI reason:</strong> {a.reason}</p>
          {a.proposed_text && a.effectiveRating !== 'covered' && (
            <p className="proposal"><strong>Proposed policy text:</strong> {a.proposed_text}</p>
          )}
          <ReviewBar runId={runId} r={r} onChange={onChange} />
          {a.effectiveRating !== 'covered' && <ImpactBar runId={runId} r={r} register={register} onChange={onChange} />}
        </div>
      )}
    </article>
  )
}

// Stage 5: confirm the AI rating or override it with a comment. The reviewer is the signed-in Clerk user.
function ReviewBar({ runId, r, onChange }: { runId: string; r: Requirement; onChange: () => void }) {
  const api = useApi()
  const a = r.assessment!
  const [editing, setEditing] = useState(false)
  const [rating, setRating] = useState<Rating>(a.effectiveRating)
  const [comment, setComment] = useState(a.review_comment)
  const [error, setError] = useState<string | null>(null)

  async function send(body: object) {
    setError(null)
    try {
      await api(`/runs/${runId}/requirements/${r.rid}/review`, { method: 'PATCH', body: JSON.stringify(body) })
      setEditing(false)
      onChange()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <div className={`review ${a.review_status}`}>
      {a.review_status === 'pending' ? (
        <span className="muted small">AI rating: {RATING_LABEL[a.rating]} · not yet reviewed</span>
      ) : (
        <span className="small">
          {a.review_status === 'confirmed' ? '✔ Confirmed' : `✎ Overridden (AI: ${RATING_LABEL[a.rating]})`} by{' '}
          <strong>{a.reviewer_name}</strong> · {a.reviewed_at?.slice(0, 16)} UTC
          {a.review_comment && <> · “{a.review_comment}”</>}
        </span>
      )}
      {!editing ? (
        <div className="row">
          {a.review_status === 'pending' && (
            <button className="btn small" onClick={() => send({ action: 'confirm' })}>Confirm</button>
          )}
          <button className="btn small ghost" onClick={() => setEditing(true)}>
            {a.review_status === 'pending' ? 'Override' : 'Change'}
          </button>
          {a.review_status !== 'pending' && (
            <button className="btn small ghost" onClick={() => send({ action: 'reset' })}>Reset</button>
          )}
        </div>
      ) : (
        <div className="override">
          <select value={rating} onChange={(e) => setRating(e.target.value as Rating)}>
            {(Object.keys(RATING_LABEL) as Rating[]).map((k) => (
              <option key={k} value={k}>{RATING_LABEL[k]}</option>
            ))}
          </select>
          <input placeholder="Reason for the review decision (required)" value={comment} onChange={(e) => setComment(e.target.value)} />
          <button className="btn small" disabled={!comment.trim()} onClick={() => send({ action: 'override', rating, comment })}>Save</button>
          <button className="btn small ghost" onClick={() => setEditing(false)}>Cancel</button>
        </div>
      )}
      {error && <p className="error small">{error}</p>}
    </div>
  )
}

// Impact: which internal policy must change for this gap. The user confirms or corrects it.
function ImpactBar({ runId, r, register, onChange }: { runId: string; r: Requirement; register: RegisterEntry[]; onChange: () => void }) {
  const api = useApi()
  const a = r.assessment!
  const [policyId, setPolicyId] = useState(a.impact_policy_id)
  const [error, setError] = useState<string | null>(null)
  const entry = register.find((p) => p.id === a.impact_policy_id)

  async function save(confirmed: boolean) {
    setError(null)
    try {
      await api(`/runs/${runId}/requirements/${r.rid}/impact`, { method: 'PATCH', body: JSON.stringify({ policyId, confirmed }) })
      onChange()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <div className={`impact ${a.impact_confirmed ? 'done' : ''}`}>
      <span className="small">Affected policy:</span>
      <select value={policyId} onChange={(e) => setPolicyId(e.target.value)}>
        {register.map((p) => (
          <option key={p.id} value={p.id}>{p.id} · {p.title} ({p.owner})</option>
        ))}
      </select>
      {a.impact_confirmed && policyId === a.impact_policy_id ? (
        <span className="small ok">
          ✔ impact confirmed{entry ? ` · owner ${entry.owner}` : ''}{' '}
          <button className="link" onClick={() => save(false)}>undo</button>
        </span>
      ) : (
        <button className="btn small" onClick={() => save(true)}>
          {policyId === a.impact_policy_id ? 'Confirm impact' : 'Correct and confirm'}
        </button>
      )}
      {error && <p className="error small">{error}</p>}
    </div>
  )
}

// Task list: one task per reviewed gap with a confirmed impact; owner from the policy register.
function TaskList({ runId, requirements, tasks, onChange }: { runId: string; requirements: Requirement[]; tasks: Task[]; onChange: () => void }) {
  const api = useApi()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const gaps = requirements.filter((r) => r.assessment && r.assessment.effectiveRating !== 'covered')
  const ready = gaps.filter((r) => r.assessment!.review_status !== 'pending' && r.assessment!.impact_confirmed)
  const byRid = new Map(requirements.map((r) => [r.rid, r]))
  const ordered = [...tasks].sort((x, y) => x.rid.localeCompare(y.rid))

  async function call(path: string, init: RequestInit) {
    setError(null)
    try {
      await api(path, init)
      onChange()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  async function generate() {
    setBusy(true)
    await call(`/runs/${runId}/tasks`, { method: 'POST' })
    setBusy(false)
  }

  function exportTasks() {
    downloadCsv(
      `gap-check-tasks-${runId.slice(0, 8)}.csv`,
      ['Requirement', 'FIDLEG reference', 'Rating', 'Policy', 'Task', 'Owner', 'Due date', 'Status', 'Proposed policy text'],
      ordered.map((t) => {
        const r = byRid.get(t.rid)
        return [t.rid, r?.ref_label ?? '', r?.assessment?.effectiveRating ?? '', t.policy_id, t.title, t.owner, t.due_date, t.status, r?.assessment?.proposed_text ?? '']
      }),
    )
  }

  return (
    <section className="panel tasks">
      <div className="row between">
        <div>
          <p className="eyebrow">Action plan</p>
          <h2>Task list ({tasks.length})</h2>
        </div>
        <div className="row">
          <button className="btn small" disabled={busy || ready.length === 0} onClick={generate}>
            {tasks.length ? 'Update task list' : 'Generate task list'}
          </button>
          <button className="btn small ghost" disabled={tasks.length === 0} onClick={exportTasks}>Download CSV</button>
        </div>
      </div>
      <p className="muted small">
        {ready.length} of {gaps.length} gaps are reviewed and have a confirmed impact; only those become tasks.
      </p>
      {error && <p className="error">{error}</p>}
      {tasks.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Done</th><th>Req.</th><th>Policy</th><th>Task</th><th>Owner</th><th>Due</th></tr>
            </thead>
            <tbody>
              {ordered.map((t) => (
                <tr key={t.rid} className={t.status}>
                  <td>
                    <input
                      type="checkbox"
                      checked={t.status === 'done'}
                      onChange={(e) => call(`/runs/${runId}/tasks/${t.rid}`, { method: 'PATCH', body: JSON.stringify({ status: e.target.checked ? 'done' : 'open' }) })}
                    />
                  </td>
                  <td><code>{t.rid}</code></td>
                  <td><code>{t.policy_id}</code></td>
                  <td>{t.title}</td>
                  <td>
                    <input
                      className="cell"
                      defaultValue={t.owner}
                      onBlur={(e) => e.target.value !== t.owner && call(`/runs/${runId}/tasks/${t.rid}`, { method: 'PATCH', body: JSON.stringify({ owner: e.target.value }) })}
                    />
                  </td>
                  <td>
                    <input
                      className="cell"
                      type="date"
                      defaultValue={t.due_date}
                      onChange={(e) => e.target.value && call(`/runs/${runId}/tasks/${t.rid}`, { method: 'PATCH', body: JSON.stringify({ due_date: e.target.value }) })}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

// CSV download with a BOM so Excel opens umlauts correctly.
function downloadCsv(filename: string, header: string[], rows: (string | number)[][]) {
  const esc = (v: string | number) => `"${String(v).replaceAll('"', '""')}"`
  const csv = [header, ...rows].map((row) => row.map(esc).join(',')).join('\n')
  const url = URL.createObjectURL(new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' }))
  const link = Object.assign(document.createElement('a'), { href: url, download: filename })
  link.click()
  URL.revokeObjectURL(url)
}

// Gap table export: one row per requirement with both references, both ratings, the review and the proposal.
function exportGapTable(runId: string, requirements: Requirement[]) {
  downloadCsv(
    `gap-table-${runId.slice(0, 8)}.csv`,
    [
      'Requirement', 'FIDLEG reference', 'Requirement summary', 'FIDLEG text (quote)', 'Policy sections', 'Policy text (quote)',
      'AI rating', 'Final rating', 'Review status', 'Reviewer', 'Reviewed at (UTC)', 'Review comment', 'AI reason',
      'Proposed policy text', 'Affected policy', 'Impact confirmed', 'Citations verified',
    ],
    requirements.map((r) => {
      const a = r.assessment
      return [
        r.rid, r.ref_label, r.summary, r.quote,
        a?.policySections.map((s) => s.ref).join('; ') ?? '', a?.policy_quote ?? '',
        a?.rating ?? '', a?.effectiveRating ?? '', a?.review_status ?? '', a?.reviewer_name ?? '', a?.reviewed_at ?? '',
        a?.review_comment ?? '', a?.reason ?? '', a?.proposed_text ?? '',
        a && a.effectiveRating !== 'covered' ? a.impact_policy_id : '', a?.impact_confirmed ? 'yes' : 'no',
        r.refVerified && r.quoteVerified && (a?.policyVerified ?? true) ? 'yes' : 'no',
      ]
    }),
  )
}

// Rolls paragraph-level ratings up to articles: all covered → covered, all missing → missing, otherwise partial.
function articleSummary(requirements: Requirement[]) {
  const byArticle = new Map<string, Rating[]>()
  for (const r of requirements) {
    const art = r.ref_label.match(/Art\. (\d+[a-z]?)/)?.[1]
    if (!art || !r.assessment) continue
    byArticle.set(art, [...(byArticle.get(art) ?? []), r.assessment.effectiveRating])
  }
  return [...byArticle.entries()]
    .sort((x, y) => parseInt(x[0]) - parseInt(y[0]))
    .map(([art, ratings]) => {
      const rating: Rating = ratings.every((x) => x === 'covered') ? 'covered' : ratings.every((x) => x === 'missing') ? 'missing' : 'partial'
      return { art, rating, rows: ratings.length }
    })
}

function ArticleSummary({ requirements }: { requirements: Requirement[] }) {
  const articles = articleSummary(requirements)
  const gaps = articles.filter((a) => a.rating !== 'covered')
  const count = (r: Rating) => gaps.filter((a) => a.rating === r).length
  return (
    <div className="articles">
      <p className="small">
        <strong>By article:</strong> {gaps.length} of {articles.length} articles with gaps ({count('missing')} missing,{' '}
        {count('partial')} partial). The table below lists paragraph-level findings.
      </p>
      <div className="article-chips">
        {articles.map((a) => (
          <span key={a.art} className={`chip ${a.rating}`} title={`${a.rows} requirement${a.rows === 1 ? '' : 's'}`}>
            Art. {a.art} · {RATING_LABEL[a.rating]}
          </span>
        ))}
      </div>
    </div>
  )
}

function Check({ ok }: { ok: boolean }) {
  return ok ? <span className="ok" title="verified against source">✓</span> : <span className="warn" title="not found verbatim in source">⚠</span>
}

// Shows the full stored passage with the cited quote highlighted.
function Passage({ text, quote }: { text: string; quote: string }) {
  const i = quote ? text.indexOf(quote) : -1
  if (i < 0) return <blockquote>{text}</blockquote>
  return (
    <blockquote>
      {text.slice(0, i)}
      <mark>{quote}</mark>
      {text.slice(i + quote.length)}
    </blockquote>
  )
}
