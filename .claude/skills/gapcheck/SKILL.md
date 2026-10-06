---
name: gapcheck
description: Run the AI stages (extract requirements, map to policy, assess) of the regulation gap check for a run that was loaded in the app, and write the results back into D1. Use when the user says "run the gap check", "process run <id>", or the app shows "Waiting for Claude Code".
---

# Gap check: AI stages 2–4 (Exercise 5, Option A)

The app (stage 1) has already stored both texts and split them into sections. Each section has a
short id (`sid`): regulation `A8` / `A8.1` (= Art. 8 / Art. 8 Abs. 1 FIDLEG), policy `P4.2` (= W-07 Ziff. 4.2).
Your job is stages 2–4. The app then verifies every citation against the stored text and shows the gap table.

## 1. Read the sections
- **On a machine with wrangler logged in:** `npm run gapcheck -- sections <runId|latest>`. It prints `{ runId, sections: [...] }`.
- **In a Claude Code cloud session with the Cloudflare D1 MCP:** query database `83a77478-b01a-4e79-b705-2e7747debea7`:
  `SELECT sid, kind, ref, heading, text FROM sections WHERE run_id = ? ORDER BY kind DESC, ord`

Read **every** regulation section and **every** policy section in full before you write anything.

## 2. Extract requirements (stage 2)
Split each regulation section into single, checkable obligations, one per duty. Use `lit.` items as separate
requirements where they impose distinct duties. For each requirement:
- `rid`: `R01`, `R02`, … in article order
- `section_sid`: the regulation `sid` it comes from. It must exist.
- `ref_label`: exact reference built from that section's `ref`, e.g. `Art. 8 Abs. 1 FIDLEG`, plus `lit. a` only if the
  letter appears in that section's text
- `quote`: a **contiguous, verbatim** excerpt (German, unchanged) of that section's text that states the duty
- `summary`: one English sentence

Skip provisions that impose no duty on the financial service provider (pure definitions, delegations to the
Federal Council), unless the policy has to reflect them, e.g. the client segments. At least 10 requirements are required.

## 3. Map and 4. Assess
For each requirement, find the policy sections that address it:
- `policy_sids`: the policy `sid`s. Use `[]` if none addresses it. **Never guess a section.**
- `policy_quote`: a contiguous, verbatim excerpt from one of those sections (empty if missing)
- `rating`:
  - `covered`: the policy fully meets the requirement
  - `partial`: the policy addresses the topic but leaves out an element the law requires; name the missing element
  - `missing`: no policy section addresses it
- `reason`: one or two English sentences that name the exact element that is present or missing
- `proposed_text`: required for `partial` / `missing`. A German policy clause that closes the gap and would fit as a new `Ziff.` in W-07.
  Empty for `covered`.

## Hard rules
- Use **only** the stored section texts. Use no outside legal knowledge, no other FIDLEG articles, no FIDLEV, and no web.
- Every `quote` / `policy_quote` must be copied character for character. Use no ellipses and do not merge passages. The app flags
  anything it cannot find verbatim with ⚠.
- The sheet's self-check says W-07 has 4 planted gaps: 2 missing and 2 partial. Use it only to double-check your reading. Never
  force a rating to hit that count.

## 5. Write the results
Save a JSON file in your scratchpad (never in the repo):
```json
{ "runId": "<runId>", "requirements": [
  { "rid": "R01", "section_sid": "A8.1", "ref_label": "Art. 8 Abs. 1 FIDLEG", "quote": "…", "summary": "…",
    "assessment": { "policy_sids": ["P3.1"], "policy_quote": "…", "rating": "partial", "reason": "…", "proposed_text": "…" } }
] }
```
Then import it:
- **With wrangler:** `npm run gapcheck -- import <file.json>`
- **With the D1 MCP:** `npm run gapcheck -- import <file.json> --print`, then run the printed SQL with the D1 query tool.

The import validates the shape, replaces any earlier results for that run, and sets the run to `assessed`. The app polls
every 5 s and shows the gap table. Finally, report the counts per rating and any row the app marks ⚠.
