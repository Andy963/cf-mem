-- Evidence buffer for POST /memory/profile/ingest.
--
-- Ingest used to create one extraction job per message, which fragmented the
-- context an extractor needs (preferences are often expressed across several
-- turns) and cost three LLM calls per message. Ingest now appends here and the
-- cron sweep flushes a whole group into a single job.
--
-- `id` is the evidence segment id, which is already derived from the ingest
-- idempotency key, so re-posting the same text collapses onto the same row.
CREATE TABLE IF NOT EXISTS profile_evidence_inbox (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  group_key TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  source_app TEXT NOT NULL,
  external_session_id TEXT NOT NULL,
  workspace_id TEXT,
  char_count INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

-- Flush scans by group and always consumes oldest-first.
CREATE INDEX IF NOT EXISTS idx_profile_evidence_inbox_group
  ON profile_evidence_inbox (project_id, group_key, created_at ASC);
