-- Regulation gap check (Exercise 5, Option A).
-- Stage 1 (app) fills runs/documents/sections; stages 2-4 (Claude Code) fill requirements/assessments.

CREATE TABLE IF NOT EXISTS runs (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'awaiting_ai' CHECK (status IN ('awaiting_ai', 'assessed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS runs_user_idx ON runs (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS documents (
  run_id    TEXT NOT NULL,
  kind      TEXT NOT NULL CHECK (kind IN ('regulation', 'policy')),
  filename  TEXT NOT NULL,
  full_text TEXT NOT NULL,
  PRIMARY KEY (run_id, kind)
);

CREATE TABLE IF NOT EXISTS sections (
  run_id  TEXT NOT NULL,
  sid     TEXT NOT NULL,
  kind    TEXT NOT NULL CHECK (kind IN ('regulation', 'policy')),
  ref     TEXT NOT NULL,
  heading TEXT NOT NULL,
  text    TEXT NOT NULL,
  ord     INTEGER NOT NULL,
  PRIMARY KEY (run_id, sid)
);

CREATE TABLE IF NOT EXISTS requirements (
  run_id      TEXT NOT NULL,
  rid         TEXT NOT NULL,
  section_sid TEXT NOT NULL,
  ref_label   TEXT NOT NULL,
  quote       TEXT NOT NULL,
  summary     TEXT NOT NULL,
  ord         INTEGER NOT NULL,
  PRIMARY KEY (run_id, rid)
);

CREATE TABLE IF NOT EXISTS assessments (
  run_id        TEXT NOT NULL,
  rid           TEXT NOT NULL,
  policy_sids   TEXT NOT NULL DEFAULT '[]', -- JSON array of sections.sid
  policy_quote  TEXT NOT NULL DEFAULT '',
  rating        TEXT NOT NULL CHECK (rating IN ('covered', 'partial', 'missing')),
  reason        TEXT NOT NULL,
  proposed_text TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (run_id, rid)
);
