-- Normalize legacy task-state rows now that task_state is workspace-bound.
-- Rows with a known workspace retain their state under the current taxonomy.
UPDATE memory_claims
SET applicability = 'workspace'
WHERE category = 'task_state'
  AND workspace_id IS NOT NULL
  AND workspace_id != '';

-- A legacy state with no workspace cannot be routed safely. Keep it for audit
-- history, but remove it from active context rather than leaking it elsewhere.
UPDATE memory_claims
SET status = 'retracted',
    valid_until = COALESCE(valid_until, unixepoch() * 1000),
    updated_at = unixepoch() * 1000
WHERE category = 'task_state'
  AND status = 'active'
  AND (workspace_id IS NULL OR workspace_id = '');
