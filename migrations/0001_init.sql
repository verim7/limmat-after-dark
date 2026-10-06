-- Starter table so the API has something real to read/write.
-- Replace or extend once you know tonight's problem.
CREATE TABLE IF NOT EXISTS notes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT    NOT NULL,
  body       TEXT    NOT NULL,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS notes_user_id_idx ON notes (user_id, created_at DESC);
