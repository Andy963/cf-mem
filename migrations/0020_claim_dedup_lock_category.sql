ALTER TABLE memory_claim_dedup_locks RENAME TO memory_claim_dedup_locks_legacy;

CREATE TABLE memory_claim_dedup_locks (
  project_id TEXT NOT NULL,
  scope_kind TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'domain_fact',
  type TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT '',
  lock_token TEXT NOT NULL,
  lock_until INTEGER NOT NULL,
  PRIMARY KEY (project_id, scope_kind, scope_id, category, type, workspace_id)
);

-- The old table did not record category, so preserve every existing lease
-- across the supported categories until its original expiry. This avoids an
-- in-flight pre-migration writer bypassing the new category-aware key.
INSERT INTO memory_claim_dedup_locks (
  project_id,
  scope_kind,
  scope_id,
  category,
  type,
  workspace_id,
  lock_token,
  lock_until
)
SELECT
  legacy.project_id,
  legacy.scope_kind,
  legacy.scope_id,
  categories.category,
  legacy.type,
  legacy.workspace_id,
  legacy.lock_token,
  legacy.lock_until
FROM memory_claim_dedup_locks_legacy AS legacy
CROSS JOIN (
  SELECT 'rule' AS category
  UNION ALL SELECT 'tool_insight'
  UNION ALL SELECT 'user_profile'
  UNION ALL SELECT 'domain_fact'
) AS categories;

DROP TABLE memory_claim_dedup_locks_legacy;
