-- Add category column to memory_claims with default 'domain_fact'
ALTER TABLE memory_claims ADD COLUMN category TEXT NOT NULL DEFAULT 'domain_fact';

-- Create composite index for category, scope_kind, and status routing
CREATE INDEX IF NOT EXISTS idx_claims_category_scope_status ON memory_claims(project_id, category, scope_kind, status);

-- Preserve the short-lived semantics of legacy task-state claims. A missing
-- expiry must never turn a temporary handoff into a permanent memory row.
UPDATE memory_claims
SET category = 'task_state',
    valid_until = COALESCE(valid_until, created_at + 72 * 60 * 60 * 1000)
WHERE type = 'task_state';

-- Category is part of a claim identity so different memory classes do not
-- block each other from coexisting under the same scope and memory key.
DROP INDEX IF EXISTS idx_memory_claims_active_identity;
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_claims_active_identity
  ON memory_claims (project_id, scope_kind, scope_id, category, type, subject, memory_key, COALESCE(workspace_id, ''))
  WHERE status = 'active';
