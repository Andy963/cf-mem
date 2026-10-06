ALTER TABLE memory_claim_dedup_locks RENAME TO memory_claim_dedup_locks_legacy;

CREATE TABLE memory_claim_dedup_locks (
  project_id TEXT NOT NULL,
  scope_kind TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'domain_fact',
  workspace_id TEXT NOT NULL DEFAULT '',
  lock_token TEXT NOT NULL,
  lock_until INTEGER NOT NULL,
  PRIMARY KEY (project_id, scope_kind, scope_id, category, workspace_id)
);

-- Per-type leases collapse into one category-level lease. Keep the row with
-- the latest expiry for each new key so an in-flight pre-migration writer is
-- never bypassed while any of its legacy leases is still valid.
INSERT INTO memory_claim_dedup_locks (
  project_id,
  scope_kind,
  scope_id,
  category,
  workspace_id,
  lock_token,
  lock_until
)
SELECT
  legacy.project_id,
  legacy.scope_kind,
  legacy.scope_id,
  legacy.category,
  legacy.workspace_id,
  legacy.lock_token,
  legacy.lock_until
FROM memory_claim_dedup_locks_legacy AS legacy
JOIN (
  SELECT
    project_id,
    scope_kind,
    scope_id,
    category,
    workspace_id,
    MAX(lock_until) AS latest_lock_until
  FROM memory_claim_dedup_locks_legacy
  GROUP BY project_id, scope_kind, scope_id, category, workspace_id
) AS latest
  ON latest.project_id = legacy.project_id
 AND latest.scope_kind = legacy.scope_kind
 AND latest.scope_id = legacy.scope_id
 AND latest.category = legacy.category
 AND latest.workspace_id = legacy.workspace_id
 AND latest.latest_lock_until = legacy.lock_until;

DROP TABLE memory_claim_dedup_locks_legacy;
