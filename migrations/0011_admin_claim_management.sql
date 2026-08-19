CREATE TABLE IF NOT EXISTS memory_claim_tags (
  project_id TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (claim_id, tag)
);

CREATE INDEX IF NOT EXISTS idx_memory_claim_tags_project_tag
  ON memory_claim_tags (project_id, tag, claim_id);

CREATE TABLE IF NOT EXISTS memory_claim_audit_log (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('edit', 'retract', 'tag_add', 'tag_remove')),
  actor_email TEXT NOT NULL,
  reason TEXT,
  before_json TEXT,
  after_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_claim_audit_claim
  ON memory_claim_audit_log (project_id, claim_id, created_at DESC);
