DROP INDEX IF EXISTS idx_memory_claims_active_identity;

CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_claims_active_identity
  ON memory_claims (project_id, scope_kind, scope_id, type, subject, memory_key, COALESCE(workspace_id, ''))
  WHERE status = 'active';
