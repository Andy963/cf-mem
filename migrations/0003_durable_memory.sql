CREATE TABLE IF NOT EXISTS memory_claims (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('project', 'user', 'session')),
  scope_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('preference', 'instruction', 'decision', 'profile', 'task_state')),
  subject TEXT NOT NULL,
  memory_key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  canonical_text TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'superseded', 'retracted', 'proposed')),
  provenance TEXT NOT NULL CHECK (provenance IN ('user_explicit', 'user_confirmed', 'model_inferred')),
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  valid_from INTEGER,
  valid_until INTEGER,
  superseded_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_claims_active_identity
  ON memory_claims (project_id, scope_kind, scope_id, type, subject, memory_key)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_memory_claims_context
  ON memory_claims (project_id, status, scope_kind, scope_id, type, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_claims_superseded_by
  ON memory_claims (project_id, superseded_by);

CREATE TABLE IF NOT EXISTS memory_evidence (
  claim_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  segment_id TEXT NOT NULL,
  relation TEXT NOT NULL CHECK (relation IN ('supports', 'contradicts')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (claim_id, segment_id, relation)
);

CREATE INDEX IF NOT EXISTS idx_memory_evidence_project_segment
  ON memory_evidence (project_id, segment_id);

CREATE INDEX IF NOT EXISTS idx_memory_evidence_claim
  ON memory_evidence (claim_id);
