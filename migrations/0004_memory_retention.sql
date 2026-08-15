ALTER TABLE memory_segments ADD COLUMN expires_at INTEGER;
ALTER TABLE memory_segments ADD COLUMN deletion_state TEXT NOT NULL DEFAULT 'active'
  CHECK (deletion_state IN ('active', 'pending_delete'));

CREATE INDEX IF NOT EXISTS idx_memory_segments_retention
  ON memory_segments (project_id, deletion_state, expires_at, created_at);

CREATE TABLE IF NOT EXISTS memory_deletion_jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('segment', 'claim')),
  resource_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (project_id, resource_type, resource_id)
);

CREATE INDEX IF NOT EXISTS idx_memory_deletion_jobs_pending
  ON memory_deletion_jobs (status, created_at);
