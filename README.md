# limmat after dark 🌉

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
2. **Extract, map, assess (Claude Code):** in this project, tell Claude Code *"Run the gap check for run <id>"*.
   The `gapcheck` skill reads the sections, writes requirements and ratings, and imports them with `npm run gapcheck -- import …`.
3. **Report (app):** the gap table shows the FIDLEG reference and passage next to the W-07 section, the rating, the
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
