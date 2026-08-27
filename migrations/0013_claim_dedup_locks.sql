CREATE TABLE IF NOT EXISTS memory_claim_dedup_locks (
  project_id TEXT NOT NULL,
  scope_kind TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  type TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT '',
  lock_token TEXT NOT NULL,
  lock_until INTEGER NOT NULL,
  PRIMARY KEY (project_id, scope_kind, scope_id, type, workspace_id)
);
