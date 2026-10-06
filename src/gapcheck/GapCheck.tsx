import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { useApi, useAuthedFetch } from '../api'
import { findStand } from '../../shared/segment'
import type { Rating, Requirement, RunData, Section } from './types'

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
      {waiting ? <AwaitingAi data={data} /> : <Report requirements={data.requirements ?? []} />}
    </>
  )
}

// Saved exercise documents (public/samples): the policy W-07 and the internal policy register.
const SAVED_POLICY = { url: '/samples/Weisung_W-07_Kundensegmentierung_und_Pruefung.pdf', filename: 'Weisung_W-07_Kundensegmentierung_und_Pruefung.pdf' }
const SAVED_REGISTER_URL = '/samples/internal_policies_and_processes.csv'
// Fetched server-side by the Worker from the official link on the exercise sheet (see worker/routes/sources.ts).
const FIDLEG_SOURCE = { key: 'fidleg-de-2026-10-01', label: 'FIDLEG (SR 950.1), German, Stand 1. Oktober 2026' }

type RegisterEntry = { id: string; title: string; owner: string; regulatory_basis: string }

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
  const count = (r: Rating) => reqs.filter((q) => q.assessment?.rating === r).length
  return (
    <section className="panel run">
      <div>
        <p className="eyebrow">Run {data.run!.id.slice(0, 8)}</p>
        <p className="muted small">
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

// Stages 2–4 run in Claude Code (no API key in the app).
function AwaitingAi({ data }: { data: RunData }) {
  return (
    <section className="panel">
      <p className="eyebrow">Steps 2–4 · Extract, map, assess</p>
      <h2>Waiting for Claude Code</h2>
      <p className="lede">
        The texts are stored and split. In Claude Code, inside this project, say:
      </p>
      <pre className="cmd">Run the gap check for run {data.run!.id}</pre>
      <p className="muted small">This page refreshes automatically when the results arrive.</p>
      <SectionList title="Regulation sections" sections={data.sections?.regulation ?? []} />
      <SectionList title="Policy sections" sections={data.sections?.policy ?? []} />
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

// Stage 6 — Report
function Report({ requirements }: { requirements: Requirement[] }) {
  const [onlyGaps, setOnlyGaps] = useState(true)
  const gaps = requirements.filter((r) => r.assessment && r.assessment.rating !== 'covered')
  const rows = onlyGaps ? gaps : requirements
  return (
    <section className="panel">
      <div className="row between">
        <div>
          <p className="eyebrow">Step 6 · Report</p>
          <h2>{onlyGaps ? `Gap table (${gaps.length})` : `All requirements (${requirements.length})`}</h2>
        </div>
        <div className="toggle">
          <button className={`btn small ${onlyGaps ? '' : 'ghost'}`} onClick={() => setOnlyGaps(true)}>Gaps</button>
          <button className={`btn small ${onlyGaps ? 'ghost' : ''}`} onClick={() => setOnlyGaps(false)}>All</button>
        </div>
      </div>
      <p className="muted small">
        AI ratings from Claude Code, not yet reviewed by compliance. ✓ means the cited reference and the quote were found
        verbatim in the stored source text; ⚠ means they were not.
      </p>
      <div className="findings">
        {rows.map((r) => (
          <Finding key={r.rid} r={r} />
        ))}
        {rows.length === 0 && <p className="muted">Nothing to show.</p>}
      </div>
    </section>
  )
}

function Finding({ r }: { r: Requirement }) {
  const a = r.assessment
  const regOk = r.refVerified && r.quoteVerified
  return (
    <article className={`finding ${a?.rating ?? ''}`}>
      <header>
        <span className={`chip ${a?.rating ?? ''}`}>{a ? RATING_LABEL[a.rating] : 'Not rated'}</span>
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
          <p><strong>Reason:</strong> {a.reason}</p>
          {a.proposed_text && (
            <p className="proposal"><strong>Proposed policy text:</strong> {a.proposed_text}</p>
          )}
        </div>
      )}
    </article>
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
