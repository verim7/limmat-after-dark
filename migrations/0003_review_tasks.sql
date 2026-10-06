-- Stage 5 (human review), impact confirmation and the task list.

ALTER TABLE assessments ADD COLUMN review_status TEXT NOT NULL DEFAULT 'pending'; -- pending | confirmed | overridden
ALTER TABLE assessments ADD COLUMN final_rating TEXT;                              -- set on review; NULL = unreviewed
ALTER TABLE assessments ADD COLUMN review_comment TEXT NOT NULL DEFAULT '';
ALTER TABLE assessments ADD COLUMN reviewed_by TEXT;                               -- Clerk user id
ALTER TABLE assessments ADD COLUMN reviewer_name TEXT;
ALTER TABLE assessments ADD COLUMN reviewed_at TEXT;
ALTER TABLE assessments ADD COLUMN impact_policy_id TEXT NOT NULL DEFAULT 'W-07';  -- id from the policy register
ALTER TABLE assessments ADD COLUMN impact_confirmed INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS tasks (
  run_id     TEXT NOT NULL,
  rid        TEXT NOT NULL,
  policy_id  TEXT NOT NULL,
  title      TEXT NOT NULL,
  owner      TEXT NOT NULL,
  due_date   TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (run_id, rid)
);
