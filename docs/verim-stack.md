# Verim Stack: playbook for new apps

Everything used to build **limmat-after-dark** (Claude Build Night Zürich, 6 Oct 2026), grouped so it can be reused for new apps.
Reference implementation: this repo. Live: https://limmat-after-dark.verimajdini.workers.dev
No secrets in this file. Keys live in `.env.local` / `.dev.vars` (local), Worker secrets and GitHub Actions secrets.

---

## 1. Accounts and consoles

| Service | Used for | Where |
|---|---|---|
| GitHub (`verim7`) | Code, CI/CD (Actions) | https://github.com/verim7 |
| Cloudflare (`verimajdini`) | Workers hosting, D1 database, Workers AI | https://dash.cloudflare.com |
| Clerk | Auth (email code, SSO: Microsoft / Apple) | https://dashboard.clerk.com |
| Claude (claude.ai / Claude Code) | Building, AI engine via a project skill | https://claude.ai/code |

Use a personal identity for personal projects. The Clerk CLI and git picked up the work account (Synpulse) on the first try; see §9.

## 2. The stack

| Layer | Choice | Notes |
|---|---|---|
| Frontend | React 19 + Vite 8 + TypeScript | SPA served as Workers static assets |
| API | Hono on Cloudflare Workers | `/api/*` hits the Worker first (`run_worker_first`); everything else falls back to `index.html` |
| Auth | Clerk: `@clerk/react` (UI), `@clerk/hono` (Worker) | `@hono/clerk-auth` is deprecated; use `@clerk/hono` |
| Database | Cloudflare D1 (SQLite) | migrations in `migrations/NNNN_*.sql`, applied by CI |
| AI in app | Cloudflare Workers AI, `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | JSON mode, no API key, free 10k neurons/day |
| AI via Claude | Claude Code + a project skill + a D1 bridge script | best quality, no Anthropic API key needed |
| PDF parsing | `pdfjs-dist` **legacy build**, in the browser | keeps the Worker within free-plan CPU limits; legacy build works on Safari |
| Lint / types | oxlint, `tsc -b` | `npm run build && npm run lint` before every commit |
| E2E tests | Playwright (Chromium + **WebKit**, desktop + **iPhone/Pixel**) + `@clerk/testing` | WebKit = Safari's engine; phone tests mock the API with a real fixture |
| CI/CD | GitHub Actions: lint → build → D1 migrations → deploy → E2E | a push to `main` deploys |

## 3. Repo layout (copy this)

```
src/                React app (src/api.ts: useApi() adds the Clerk token)
worker/index.ts     Hono app, requireUser middleware, mounts routes
worker/routes/*.ts  feature routes (split when index.ts > ~200 lines)
shared/             pure TS used by browser, Worker and Node tests
migrations/         D1 SQL migrations
scripts/            CLI bridges (e.g. Claude Code ↔ D1 import)
e2e/                Playwright tests (+ global.setup.ts for Clerk test users)
.claude/skills/     project skills for Claude Code
CLAUDE.md           rules and stack notes for Claude Code
public/samples/     reference data shipped with the app
```

## 4. New app: setup checklist

1. **Create the repo** on github.com (empty, no README) and clone it. Write `CLAUDE.md` first: stack, commands, rules.
2. **Scaffold:** `npm create vite@latest <name> -- --template react-ts`, then add `hono @clerk/hono @clerk/react` and
   `-D wrangler @cloudflare/vite-plugin @cloudflare/workers-types`.
3. **`wrangler.jsonc`:** `main`, `assets` (`not_found_handling: single-page-application`, `run_worker_first: ["/api/*"]`, `binding: ASSETS`),
   `d1_databases`, `ai` binding, `observability`, `vars.CLERK_PUBLISHABLE_KEY`.
4. **D1:** create the database (Cloudflare MCP `d1_database_create`, or `npx wrangler d1 create <name>`, region `weur`), put its id in `wrangler.jsonc`.
5. **Clerk:**
   ```
   npm i -g clerk
   clerk auth login
   clerk init --app <app_id>
   clerk doctor
   ```
   The keys land in `.env.local`. Copy `.dev.vars.example` to `.dev.vars` for the Worker.
6. **Cloudflare:**
   ```
   npx wrangler login
   npx wrangler secret put CLERK_SECRET_KEY
   npm run deploy
   ```
7. **CI:** copy `.github/workflows/deploy.yml` and add the secrets and variables (§5).
8. **Tests:** copy `playwright.config.ts` and `e2e/`, and adapt the assertions.

## 5. Deploy: GitHub Actions secrets and Cloudflare token

| Kind | Name | Value |
|---|---|---|
| Secret | `CLOUDFLARE_API_TOKEN` | Account API token with **Workers Scripts: Edit**, **D1: Edit**, **Account Settings: Read** |
| Secret | `CLOUDFLARE_ACCOUNT_ID` | from the dashboard URL / Workers & Pages sidebar |
| Secret | `CLERK_SECRET_KEY` | `sk_test_…` (dev) or `sk_live_…` (prod) |
| Variable | `VITE_CLERK_PUBLISHABLE_KEY` | `pk_test_…` / `pk_live_…` (public) |

- The workflow passes the secret with `wrangler deploy --secrets-file` and the publishable key with `--var`.
- A manual run is possible via **Actions → Run workflow**. If "Re-run" doesn't seem to register, trigger a new run.

## 6. Auth (Clerk)

- **Dev vs. production:** a development instance (`pk_test_`) works on `*.workers.dev`. A production instance needs **a domain you own**,
  Clerk's DNS records (Frontend API, accounts, email/DKIM), `pk_live_`/`sk_live_` keys, and your **own OAuth apps** for SSO.
- **Email codes in dev** come from Clerk's shared sender, and corporate filters (e.g. Microsoft 365) may quarantine them.
- **Test identities:** `name+clerk_test@domain` with code **`424242`**. No email is sent; dev instances only.
- **SSO:** Clerk dashboard → User & authentication → SSO connections (Microsoft, Apple, Google). The prebuilt `<SignInButton mode="modal">` shows them
  automatically. A corporate Microsoft tenant may require admin consent.
- **Worker side:** `app.use('*', clerkMiddleware())`, then `getAuth(c).userId` with a `requireUser` middleware. Scope every query to `userId`.
- **E2E:** `@clerk/testing/playwright`: `clerkSetup()` in global setup, then `clerk.signIn({ page, emailAddress })` (ticket sign-in).
  Create test users with `@clerk/backend` (`users.createUser({ emailAddress, skipPasswordRequirement: true })`).

## 7. AI options

| Option | When | Cost / limits | Quality |
|---|---|---|---|
| **Claude Code as engine** (skill + `scripts/*.mjs` bridge + D1) | best results, no API key | Claude subscription | ★★★ |
| **Workers AI** (binding `AI`, JSON mode) | in-app button, fully automatic | free 10k neurons/day (~7 runs of this app) | ★★ (needs guardrails and human review) |
| Anthropic API (`@anthropic-ai/sdk` in the Worker) | in-app, best quality | needs an API key (console.anthropic.com) | ★★★ |

Workers AI lessons:
- **Generating output** is what takes the time; reading input is fast. Keep the model's output small: no quotes, the server fills them in.
- Run independent calls **in parallel** from the browser; each request is one model call, so none runs long.
- Store a **duration and token count per step** (`usage` in the response) and show them. Measure before optimising.
- One retry on "JSON Mode couldn't be met".

## 8. Reusable patterns

- **Traceability guardrails:** references come only from stored sections. Every quote is checked word for word against the source (✓/⚠), and a
  non-verbatim quote is replaced with the exact paragraph. Models never invent references.
- **Deterministic segmentation** before any AI step. For Fedlex PDFs, drop footnotes by **font size**: body 9 pt, footnotes 8 pt,
  superscripts 6.5 pt. A superscript at the start of a line is a paragraph number; mid-line it is a footnote marker.
- **Server-side fetch of official sources** with a fixed allowlist (not an open proxy), plus a version check (e.g. "Stand am …").
- **Human in the loop:** AI rating, then confirm / override (comment required). Store the reviewer from Clerk and a timestamp; reports use the final rating.
- **Impact → tasks:** map gaps to an internal register (CSV), confirm the impact, and generate tasks with owner and due date. CSV export.
- **Engine labelling:** store which engine produced a result (`claude-code` / `workers-ai:<model>`) and show it.
- **Proposal sanity check:** drop AI "proposals" that only repeat the source text.
- **CSV downloads:** prepend a BOM (`\uFEFF`) so Excel shows umlauts correctly.

## 9. Troubleshooting log (things that actually happened)

| Symptom | Cause | Fix |
|---|---|---|
| `npm` is not recognized (Windows) | Node.js not installed | `winget install OpenJS.NodeJS.LTS`, then reopen PowerShell |
| `npm.ps1 cannot be loaded … running scripts is disabled` | PowerShell execution policy | `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, or use `npm.cmd` |
| `fatal: not a git repository` | terminal in the wrong folder | `cd C:\Users\<you>\<repo>` |
| Commits made with the work email | git global identity not set | `git config --global user.email "<personal>"` |
| Clerk CLI logged in with the wrong account | browser session reused | `clerk auth logout`; log in again in a private window |
| Clerk login from the cloud session failed (403) | sandbox network blocks `clerk.clerk.com` | run the Clerk CLI locally, or allow the host |
| Email verification code never arrives | dev-instance sender + corporate filter | `+clerk_test` / `424242`, SSO, or a production instance on your own domain |
| `@hono/clerk-auth` deprecation warning | package renamed | switch to `@clerk/hono` (same API) |
| `undefined is not a function (near '…e of t…')` on Safari | pdf.js `for await` over a `ReadableStream` | read `streamTextContent()` with `getReader()` and use the pdf.js **legacy** build |
| Page wider than the phone; sideways scrolling | `<select>` sized to its longest option inside a CSS grid (`1fr` = `minmax(auto, 1fr)`), wide tables and stat rows | `grid-template-columns: minmax(0, 1fr)`, `select { min-width: 0; width: 100% }` on mobile, tables as cards under 640 px, and a Playwright phone test that fails if any element passes the viewport edge |
| iPhone/Safari page still too wide, but no element or text passes the edge | WebKit counts a `<select>`'s internal text (shadow DOM) as overflow | `overflow: hidden; overflow: clip` on the card that holds the select; the test bisects by hiding children to name the culprit |
| Footnotes inside law paragraphs | PDF text extraction mixes in footnotes | strip by font size (§8) |
| GitHub Actions deploy fails: no `CLOUDFLARE_API_TOKEN` | secrets not set | add the secrets (§5) |
| Couldn't open the live site or fetch sources from the cloud session | sandbox network allowlist | allow the hosts (§10) or let the Worker fetch |

## 10. Working with Claude Code: cloud vs. local

- **Cloud session (Claude Code on the web):** an isolated, temporary container in Anthropic's cloud. The repo is cloned in fresh and anything that matters must be pushed.
  Outbound hosts follow the environment's **network policy**. Allow the app's domains (`*.workers.dev`, `clerk.com`, `api.clerk.com`,
  source sites) so Claude can test the live app with the preinstalled headless Chromium.
- **Claude in Chrome / your own browser** needs a **local** session: `claude` in the repo folder on your PC (with the Claude in Chrome extension),
  or `claude remote-control` to use it from the Claude app while it runs on your machine.
- **Connectors used:**
  - GitHub (repo, Actions runs and logs)
  - Cloudflare Developer Platform (D1 create/query, Workers list, docs search)
  - Clerk (SDK snippets only; it cannot change dashboard settings)
- **Plan mode** for anything non-trivial: plan file, then approval, then build. Write acceptance criteria into the plan and cross-check them at the end.

## 11. New-app quick start (copy-paste prompt for Claude Code)

> Read `docs/verim-stack.md`. Build `<idea>` on the Verim Stack (React + Vite, Hono on Cloudflare Workers, Clerk, D1,
> Workers AI as the in-app AI). Plan first, with acceptance criteria. Reuse the repo layout, CI workflow and E2E setup
> from `verim7/limmat-after-dark`. No secrets in code.
