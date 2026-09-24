ALTER TABLE memory_claims ADD COLUMN mutation_token TEXT;

CREATE TABLE memory_claim_audit_log_v2 (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('edit', 'retract', 'tag_add', 'tag_remove', 'delete')),
  actor_email TEXT NOT NULL,
  reason TEXT,
  before_json TEXT,
  after_json TEXT,
  created_at INTEGER NOT NULL
);

INSERT INTO memory_claim_audit_log_v2 (id, project_id, claim_id, action, actor_email, reason, before_json, after_json, created_at)
SELECT id, project_id, claim_id, action, actor_email, reason, before_json, after_json, created_at
FROM memory_claim_audit_log;

DROP TABLE memory_claim_audit_log;

ALTER TABLE memory_claim_audit_log_v2 RENAME TO memory_claim_audit_log;

CREATE INDEX idx_memory_claim_audit_claim
  ON memory_claim_audit_log (project_id, claim_id, created_at DESC);
