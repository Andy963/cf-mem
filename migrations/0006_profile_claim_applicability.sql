ALTER TABLE memory_claims ADD COLUMN applicability TEXT NOT NULL DEFAULT 'semantic'
  CHECK (applicability IN ('global', 'semantic', 'workspace'));
ALTER TABLE memory_claims ADD COLUMN workspace_id TEXT;
CREATE INDEX IF NOT EXISTS idx_memory_claims_applicability
  ON memory_claims (project_id, status, scope_kind, scope_id, applicability, workspace_id, updated_at DESC);

ALTER TABLE profile_extraction_jobs ADD COLUMN workspace_id TEXT;
