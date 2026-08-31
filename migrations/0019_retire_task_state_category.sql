-- Retire the task_state category and type.
--
-- Usage data showed zero task_state claims were ever produced in production,
-- while the category carried the most routing complexity of the taxonomy: a
-- mandatory TTL, workspace-exact matching, and a dedicated context branch that
-- had already leaked across workspaces once (see 0018).
--
-- Historical rows are retracted rather than deleted so the audit trail and any
-- attached evidence survive. Retracted claims are never injected into context.
UPDATE memory_claims
SET status = 'retracted',
    updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE status != 'retracted'
  AND (category = 'task_state' OR type = 'task_state');
