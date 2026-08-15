CREATE TABLE IF NOT EXISTS profile_extraction_jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  evidence_segment_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  source_app TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'dead')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  next_attempt_at INTEGER NOT NULL,
  lease_token TEXT,
  lease_expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (project_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_profile_extraction_jobs_ready
  ON profile_extraction_jobs (status, next_attempt_at, lease_expires_at);
