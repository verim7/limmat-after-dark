-- Which engine produced the AI stages of a run: 'claude-code' or 'workers-ai:<model>'.
ALTER TABLE runs ADD COLUMN engine TEXT;
