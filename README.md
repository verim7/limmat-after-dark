# limmat after dark 🌉

> 📘 **Reusable playbook:** [`docs/verim-stack.md`](docs/verim-stack.md). The stack, setup checklist, deploy secrets, Clerk/AI notes and a troubleshooting log, for building new apps the same way.

Starter for the **Claude Code build night in Zürich**: cold brief in, live URL out.

**Stack:** React + Vite · Hono API on **Cloudflare Workers** · **Clerk** auth · **D1** database

```
src/                 React SPA (Clerk sign-in/up, gap-check UI in src/gapcheck/)
shared/              PDF text extraction + deterministic section splitting
worker/              Hono API at /api/* with Clerk-verified routes (routes/gapcheck.ts)
scripts/gapcheck.mjs D1 bridge for the Claude Code AI step
.claude/skills/      gapcheck skill (AI stages 2–4)
migrations/          D1 SQL migrations
wrangler.jsonc       Worker + assets + D1 binding
.github/workflows/   Push to main → build → migrate → deploy
```

## Regulation gap check (Exercise 5, Option A)

1. **Load (app):** sign in, then upload the FIDLEG PDF and the Weisung PDF. The browser extracts the text (pdf.js), and the
   Worker splits it into sections (`shared/segment.ts`): FIDLEG Art. 4–16 by article and paragraph, W-07 by its `Ziff.` numbering.
2. **Extract, map, assess:** pick an engine on the screen.
   - **Workers AI (in the app):** click **Run with Workers AI**. Llama 3.3 70B on Cloudflare extracts all article groups
     **in parallel**, numbers the requirements in article order, then maps and rates all batches **in parallel**. The model
     returns no quotes: the server fills them in from the stored text, which keeps model output (the main cost of latency)
     small. Each step's duration and token usage are stored and shown under **AI timing** in the run header. Server-side guardrails: references come only from stored sections, unknown
     sections are dropped, non-verbatim quotes are replaced by the exact paragraph, and every requirement gets a rating.
     The free tier covers ~10k neurons/day, about 7 runs.
   - **Claude Code:** in this project, tell Claude Code *"Run the gap check for run <id>"*. The `gapcheck` skill reads the
     sections, writes requirements and ratings, and imports them with `npm run gapcheck -- import …`.
   The run header shows which engine produced the ratings.
3. **Review (app):** a signed-in compliance user confirms each AI rating or overrides it with a comment. The reviewer's
   Clerk name and the time are stored, and the report uses the final rating.
4. **Impact and tasks (app):** for each gap, confirm or correct the affected policy (from `internal_policies_and_processes.csv`).
   **Generate task list** then creates one task per reviewed gap, with the owner from the register, a due date and a status, plus CSV export.
5. **Report (app):** the gap table shows the FIDLEG reference and passage next to the W-07 section, the rating, the
   reason and the proposed text. ✓ means the reference and quote were verified verbatim against the stored source.

## Run locally

```bash
npm install
cp .env.example .env.local        # VITE_CLERK_PUBLISHABLE_KEY
cp .dev.vars.example .dev.vars    # CLERK_SECRET_KEY + CLERK_PUBLISHABLE_KEY
npm run db:migrate:local
npm run dev                       # http://localhost:5173
```

You'll find the keys at https://dashboard.clerk.com → your app → **API keys**.

## Tests

- `npm run test:e2e` runs Playwright against the live app (or `BASE_URL`) in **Chromium and WebKit** (Safari's engine).
  It needs `CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY` (development instance). Test users `e2e-<browser>+clerk_test@example.com`
  are created automatically.
- In CI the `e2e` job runs after every deploy; the HTML report is uploaded as the `playwright-report` artifact.

## Sign-in (Clerk)

- **SSO:** *Continue with Microsoft* is enabled in the Clerk dashboard (User & authentication → SSO connections). Clerk's
  sign-in/sign-up modals show it automatically, so there is no code change. Corporate tenants may ask for admin consent the first time.
- **Email code:** works, but on the Clerk *development* instance codes come from Clerk's shared sender and may be quarantined
  by corporate mail filters. For tests use `name+clerk_test@domain` with code `424242` (no email is sent).
- **Production:** a Clerk production instance needs a domain you own (not `*.workers.dev`), DNS records from Clerk,
  `pk_live_`/`sk_live_` keys, and your own OAuth app for Microsoft.

## Go live

**Option A, from your laptop:**
```bash
npx wrangler login
npx wrangler secret put CLERK_SECRET_KEY
npm run deploy                    # → https://limmat-after-dark.<your-subdomain>.workers.dev
```
`VITE_CLERK_PUBLISHABLE_KEY` must be in `.env.local` at build time. Also set `CLERK_PUBLISHABLE_KEY`
in `wrangler.jsonc` → `vars`.

**Option B, push to deploy (GitHub Actions):** add these in the repo settings → Secrets and variables → Actions:

| Kind     | Name                         | Value |
|----------|------------------------------|-------|
| Secret   | `CLOUDFLARE_API_TOKEN`       | Cloudflare → My Profile → API Tokens → template *Edit Cloudflare Workers* (add **D1: Edit**) |
| Secret   | `CLOUDFLARE_ACCOUNT_ID`      | Cloudflare dashboard → Workers & Pages → right sidebar |
| Secret   | `CLERK_SECRET_KEY`           | `sk_test_…` |
| Variable | `VITE_CLERK_PUBLISHABLE_KEY` | `pk_test_…` |

Every push to `main` then lints, builds, applies D1 migrations and deploys.

After the first deploy, add the `workers.dev` URL in Clerk under **Domains / allowed origins** if needed.
For production, switch to a Clerk production instance.

## API

| Method | Path              | Auth | |
|--------|-------------------|------|-|
| GET    | `/api/health`     | –    | liveness |
| POST   | `/api/runs`       | ✅   | stage 1: `{regulation:{filename,text}, policy:{filename,text}}` → stored sections |
| GET    | `/api/runs/latest`| ✅   | latest run with sections, requirements, assessments and verification flags |
| GET    | `/api/runs/:id`   | ✅   | same for one run |
| POST   | `/api/runs/:id/ai/start` | ✅ | Workers AI: reset the run's results, return the article groups |
| POST   | `/api/runs/:id/ai/extract?chunk=N` | ✅ | Workers AI stage 2 for one article group (parallel-safe) |
| POST   | `/api/runs/:id/ai/number` | ✅ | assign R01… in article order |
| POST   | `/api/runs/:id/ai/assess?batch=N` | ✅ | Workers AI stages 3–4 for one batch (parallel-safe) |
| POST   | `/api/runs/:id/ai/finish` | ✅ | rate anything left, mark the run assessed, store the wall-clock time |
| PATCH  | `/api/runs/:id/requirements/:rid/review` | ✅ | `{action: confirm \| override \| reset, rating?, comment?}` |
| PATCH  | `/api/runs/:id/requirements/:rid/impact` | ✅ | `{policyId, confirmed}`; policyId from the policy register |
| POST   | `/api/runs/:id/tasks` | ✅ | (re)generate the task list from reviewed gaps with a confirmed impact |
| PATCH  | `/api/runs/:id/tasks/:rid` | ✅ | `{owner?, due_date?, status?}` |
