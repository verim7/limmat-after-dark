import { Show, SignInButton, SignUpButton, UserButton } from '@clerk/react'
import GapCheck from './gapcheck/GapCheck'

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
            <p className="eyebrow">Exercise 5 · Regulation gap check</p>
            <h1>FIDLEG vs. your Weisung.<br />Every gap cited.</h1>
            <p className="lede">
              Load a regulation and an internal policy. Claude extracts each requirement with its exact article and
              paragraph, maps it to the policy, and rates it covered, partially covered or missing.
            </p>
            <SignInButton mode="modal">
              <button className="btn big">Sign in to start</button>
            </SignInButton>
          </section>
        </Show>
        <Show when="signed-in">
          <GapCheck />
        </Show>
      </main>

      <footer className="foot">
        FIDLEG (SR 950.1) Art. 4–16 · fictional policy W-07 · Cloudflare Workers · Clerk · D1
      </footer>
    </div>
  )
}
