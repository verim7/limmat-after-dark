import { Show, SignInButton, SignUpButton, UserButton, useUser } from '@clerk/react'
import { useEffect, useState, type FormEvent } from 'react'
import { useApi } from './api'

type Note = { id: number; body: string; created_at: string }

export default function App() {
  return (
    <div className="shell">
      <header className="nav">
        <a className="brand" href="/">
          <span className="dot" /> limmat after dark
        </a>
        <nav className="auth">
          <Show when="signed-out">
            <SignInButton mode="modal">
              <button className="btn ghost">Sign in</button>
            </SignInButton>
            <SignUpButton mode="modal">
              <button className="btn">Sign up</button>
            </SignUpButton>
          </Show>
          <Show when="signed-in">
            <UserButton />
          </Show>
        </nav>
      </header>

      <main>
        <Show when="signed-out">
          <section className="hero">
            <p className="eyebrow">Claude Code build night · Zürich</p>
            <h1>Cold brief in.<br />Live URL out.</h1>
            <p className="lede">
              React on Cloudflare Workers, a Hono API, D1 for data and Clerk for auth.
              Sign up to check the whole stack works from end to end.
            </p>
            <SignUpButton mode="modal">
              <button className="btn big">Create the first account</button>
            </SignUpButton>
          </section>
        </Show>
        <Show when="signed-in">
          <Dashboard />
        </Show>
      </main>

      <footer className="foot">
        <code>/api/health</code> · Cloudflare Workers · Clerk · D1
      </footer>
    </div>
  )
}

function Dashboard() {
  const { user } = useUser()
  const api = useApi()
  const [notes, setNotes] = useState<Note[]>([])
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api<Note[]>('/notes').then(setNotes, (e: Error) => setError(e.message))
  }, [api])

  async function add(e: FormEvent) {
    e.preventDefault()
    if (!draft.trim()) return
    try {
      const note = await api<Note>('/notes', { method: 'POST', body: JSON.stringify({ body: draft }) })
      setNotes((n) => [note, ...n])
      setDraft('')
    } catch (e) {
      setError((e as Error).message)
    }
  }

  async function remove(id: number) {
    await api(`/notes/${id}`, { method: 'DELETE' })
    setNotes((n) => n.filter((x) => x.id !== id))
  }

  return (
    <section className="panel">
      <p className="eyebrow">Signed in</p>
      <h2>Hey {user?.firstName ?? user?.username ?? 'builder'} 👋</h2>
      <p className="lede">
        This list is stored in D1 for each user and served by the Worker, which checks your
        Clerk session token on every call. Swap it out for tonight's problem.
      </p>

      <form onSubmit={add} className="row">
        <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Write a note…" />
        <button className="btn" type="submit">Add</button>
      </form>
      {error && <p className="error">{error}</p>}

      <ul className="notes">
        {notes.map((n) => (
          <li key={n.id}>
            <span>{n.body}</span>
            <button className="btn ghost small" onClick={() => remove(n.id)}>×</button>
          </li>
        ))}
        {notes.length === 0 && !error && <li className="muted">No notes yet.</li>}
      </ul>
    </section>
  )
}
