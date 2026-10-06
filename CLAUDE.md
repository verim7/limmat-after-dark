# limmat-after-dark: notes for Claude Code

**Current build: Exercise 5, Option A, regulation gap check** (FIDLEG Art. 4–16 vs. internal policy W-07).
- The app loads both PDFs (stage 1), splits them deterministically (`shared/segment.ts`) and stores them in D1.
- **Claude Code is the AI engine** for stages 2–4. There is no Anthropic API key in the app. Use the `gapcheck` skill
  (`.claude/skills/gapcheck/SKILL.md`) when asked to "run the gap check".
- The Worker verifies every cited reference and quote against the stored text (✓ / ⚠) before the report shows it.
- Never cite anything that is not in the stored sections.

This is a build-night repo. We get a cold brief and have one evening to ship it to a live URL.
Go for speed and a working deploy over polish. Keep the stack below unless asked to change it.

## Stack
- **Frontend**: React 19 + Vite 8, `src/`. SPA served as Workers static assets.
- **API**: Hono on Cloudflare Workers, `worker/index.ts`, mounted at `/api/*`
  (`run_worker_first` in `wrangler.jsonc`). All other paths fall back to `index.html`.
- **Auth**: Clerk. Frontend uses `@clerk/react` (`ClerkProvider` in `src/main.tsx`, controls
  in `src/App.tsx`). The Worker verifies the bearer token with `@clerk/hono`.
  Use `getAuth(c).userId` in handlers and the `requireUser` middleware for protected routes.
- **Data**: Cloudflare D1 (SQLite), binding `DB`, db `limmat-after-dark-db`.
  The schema lives in `migrations/NNNN_*.sql`.
- **Client → API**: always call through `useApi()` in `src/api.ts`, which attaches the Clerk token.

## Commands
- `npm run dev`: Vite + workerd locally (API, D1 and secrets the same as in prod)
- `npm run build`: typecheck (`tsc -b`) and build client + worker
- `npm run lint`: oxlint
- `npm run deploy`: build + `wrangler deploy`
- `npm run db:migrate:local` / `db:migrate:remote`: apply D1 migrations
- New migration: `npx wrangler d1 migrations create limmat-after-dark-db <name>`

## Rules
- Never commit `.env.local` or `.dev.vars`. Never expose `CLERK_SECRET_KEY` to client code.
  Only `VITE_*` vars reach the browser.
- Scope every DB query to `userId` unless the data is meant to be public.
- Add new API routes in `worker/index.ts`. If it grows past ~200 lines, split it into `worker/routes/*.ts`
  using `app.route()`.
- Run `npm run build && npm run lint` before committing. A push to `main` deploys.
