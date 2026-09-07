-- Keep claim-vector synchronization durable and independent from request
-- lifetime. One row per claim coalesces rapid mutations while `revision`
-- prevents an older reconciliation attempt from completing newer work.
CREATE TABLE IF NOT EXISTS memory_claim_vector_jobs (
  project_id TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  operation TEXT NOT NULL CHECK (operation IN ('upsert', 'delete')),
  claim_updated_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  next_attempt_at INTEGER NOT NULL,
  lease_token TEXT,
  lease_expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, claim_id)
);

CREATE INDEX IF NOT EXISTS idx_memory_claim_vector_jobs_ready
  ON memory_claim_vector_jobs (status, next_attempt_at, lease_expires_at, updated_at);

-- Existing claims must be reconciled once when this migration is introduced.
INSERT OR IGNORE INTO memory_claim_vector_jobs (
  project_id,
  claim_id,
  revision,
  operation,
  claim_updated_at,
  status,
  attempt_count,
  last_error,
  next_attempt_at,
  lease_token,
  lease_expires_at,
  created_at,
  updated_at
)
SELECT
  project_id,
  id,
  1,
  CASE WHEN status = 'active' THEN 'upsert' ELSE 'delete' END,
  updated_at,
  'pending',
  0,
  NULL,
  updated_at,
  NULL,
  NULL,
  updated_at,
  updated_at
FROM memory_claims;

CREATE TRIGGER IF NOT EXISTS memory_claim_vector_jobs_after_insert
AFTER INSERT ON memory_claims
BEGIN
  INSERT INTO memory_claim_vector_jobs (
    project_id,
    claim_id,
    revision,
    operation,
    claim_updated_at,
    status,
    attempt_count,
    last_error,
    next_attempt_at,
    lease_token,
    lease_expires_at,
    created_at,
    updated_at
  ) VALUES (
    NEW.project_id,
    NEW.id,
    1,
    CASE WHEN NEW.status = 'active' THEN 'upsert' ELSE 'delete' END,
    NEW.updated_at,
    'pending',
    0,
    NULL,
    NEW.updated_at,
    NULL,
    NULL,
    NEW.updated_at,
    NEW.updated_at
  )
  ON CONFLICT (project_id, claim_id) DO UPDATE SET
    revision = memory_claim_vector_jobs.revision + 1,
    operation = excluded.operation,
    claim_updated_at = excluded.claim_updated_at,
    status = CASE WHEN memory_claim_vector_jobs.status = 'processing' THEN 'processing' ELSE 'pending' END,
    attempt_count = CASE WHEN memory_claim_vector_jobs.status = 'processing' THEN memory_claim_vector_jobs.attempt_count ELSE 0 END,
    last_error = NULL,
    next_attempt_at = excluded.next_attempt_at,
    lease_token = CASE WHEN memory_claim_vector_jobs.status = 'processing' THEN memory_claim_vector_jobs.lease_token ELSE NULL END,
    lease_expires_at = CASE WHEN memory_claim_vector_jobs.status = 'processing' THEN memory_claim_vector_jobs.lease_expires_at ELSE NULL END,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER IF NOT EXISTS memory_claim_vector_jobs_after_update
AFTER UPDATE OF project_id, scope_kind, scope_id, category, type, canonical_text, status, applicability, workspace_id ON memory_claims
BEGIN
  INSERT INTO memory_claim_vector_jobs (
    project_id,
    claim_id,
    revision,
    operation,
    claim_updated_at,
    status,
    attempt_count,
    last_error,
    next_attempt_at,
    lease_token,
    lease_expires_at,
    created_at,
    updated_at
  ) VALUES (
    NEW.project_id,
    NEW.id,
    1,
    CASE WHEN NEW.status = 'active' THEN 'upsert' ELSE 'delete' END,
    NEW.updated_at,
    'pending',
    0,
    NULL,
    NEW.updated_at,
    NULL,
    NULL,
    NEW.updated_at,
    NEW.updated_at
  )
  ON CONFLICT (project_id, claim_id) DO UPDATE SET
    revision = memory_claim_vector_jobs.revision + 1,
    operation = excluded.operation,
    claim_updated_at = excluded.claim_updated_at,
    status = CASE WHEN memory_claim_vector_jobs.status = 'processing' THEN 'processing' ELSE 'pending' END,
    attempt_count = CASE WHEN memory_claim_vector_jobs.status = 'processing' THEN memory_claim_vector_jobs.attempt_count ELSE 0 END,
    last_error = NULL,
    next_attempt_at = excluded.next_attempt_at,
    lease_token = CASE WHEN memory_claim_vector_jobs.status = 'processing' THEN memory_claim_vector_jobs.lease_token ELSE NULL END,
    lease_expires_at = CASE WHEN memory_claim_vector_jobs.status = 'processing' THEN memory_claim_vector_jobs.lease_expires_at ELSE NULL END,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER IF NOT EXISTS memory_claim_vector_jobs_after_delete
AFTER DELETE ON memory_claims
BEGIN
  INSERT INTO memory_claim_vector_jobs (
    project_id,
    claim_id,
    revision,
    operation,
    claim_updated_at,
    status,
    attempt_count,
    last_error,
    next_attempt_at,
    lease_token,
    lease_expires_at,
    created_at,
    updated_at
  ) VALUES (
    OLD.project_id,
    OLD.id,
    1,
    'delete',
    OLD.updated_at,
    'pending',
    0,
    NULL,
    OLD.updated_at,
    NULL,
    NULL,
    OLD.updated_at,
    OLD.updated_at
  )
  ON CONFLICT (project_id, claim_id) DO UPDATE SET
    revision = memory_claim_vector_jobs.revision + 1,
    operation = excluded.operation,
    claim_updated_at = excluded.claim_updated_at,
    status = CASE WHEN memory_claim_vector_jobs.status = 'processing' THEN 'processing' ELSE 'pending' END,
    attempt_count = CASE WHEN memory_claim_vector_jobs.status = 'processing' THEN memory_claim_vector_jobs.attempt_count ELSE 0 END,
    last_error = NULL,
    next_attempt_at = excluded.next_attempt_at,
    lease_token = CASE WHEN memory_claim_vector_jobs.status = 'processing' THEN memory_claim_vector_jobs.lease_token ELSE NULL END,
    lease_expires_at = CASE WHEN memory_claim_vector_jobs.status = 'processing' THEN memory_claim_vector_jobs.lease_expires_at ELSE NULL END,
    updated_at = excluded.updated_at;
END;
