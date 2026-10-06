-- Timing and token usage of the in-app AI engine (Workers AI), per step and per run.
ALTER TABLE runs ADD COLUMN ai_started_at INTEGER;  -- epoch ms
ALTER TABLE runs ADD COLUMN ai_finished_at INTEGER; -- epoch ms

CREATE TABLE IF NOT EXISTS ai_steps (
  run_id            TEXT NOT NULL,
  step              TEXT NOT NULL,  -- 'extract:N' | 'assess:N'
  label             TEXT NOT NULL,
  duration_ms       INTEGER NOT NULL,
  prompt_tokens     INTEGER,
  completion_tokens INTEGER,
  attempts          INTEGER NOT NULL,
  items             INTEGER NOT NULL,
  PRIMARY KEY (run_id, step)
);
