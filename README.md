# limmat after dark 🌉

Starter for the **Claude Code build night in Zürich**: cold brief in, live URL out.

**Stack:** React + Vite · Hono API on **Cloudflare Workers** · **Clerk** auth · **D1** database

```
src/                 React SPA (Clerk sign-in/up, user button, demo notes UI)
worker/index.ts      Hono API at /api/* with Clerk-verified routes
migrations/          D1 SQL migrations
wrangler.jsonc       Worker + assets + D1 binding
.github/workflows/   Push to main → build → migrate → deploy
```

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
| GET    | `/api/me`         | ✅   | Clerk user profile |
| GET    | `/api/notes`      | ✅   | caller's notes (D1) |
| POST   | `/api/notes`      | ✅   | `{ "body": "…" }` |
| DELETE | `/api/notes/:id`  | ✅   | delete own note |

The notes feature is just a placeholder. Replace it with tonight's problem.
