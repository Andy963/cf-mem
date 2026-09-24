CREATE TABLE IF NOT EXISTS memory_segment_vector_jobs (
  project_id TEXT NOT NULL,
  segment_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('upsert', 'delete')),
  segment_updated_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  next_attempt_at INTEGER NOT NULL,
  lease_token TEXT,
  lease_expires_at INTEGER,
  operation_token TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, segment_id)
);

CREATE INDEX IF NOT EXISTS idx_memory_segment_vector_jobs_ready
  ON memory_segment_vector_jobs (status, next_attempt_at, updated_at);

CREATE TRIGGER IF NOT EXISTS memory_segment_vector_jobs_after_insert
AFTER INSERT ON memory_segments
BEGIN
  INSERT INTO memory_segment_vector_jobs (
    project_id, segment_id, revision, operation, segment_updated_at, status,
    attempt_count, last_error, next_attempt_at, lease_token, lease_expires_at, operation_token, created_at, updated_at
  ) VALUES (
    NEW.project_id, NEW.id, 1,
    CASE WHEN NEW.deletion_state = 'active' THEN 'upsert' ELSE 'delete' END,
    NEW.updated_at, 'pending', 0, NULL, NEW.updated_at, NULL, NULL, NULL, NEW.updated_at, NEW.updated_at
  )
  ON CONFLICT (project_id, segment_id) DO UPDATE SET
    revision = memory_segment_vector_jobs.revision + 1,
    operation = excluded.operation,
    segment_updated_at = excluded.segment_updated_at,
    status = CASE WHEN memory_segment_vector_jobs.status = 'processing' THEN 'processing' ELSE 'pending' END,
    attempt_count = CASE WHEN memory_segment_vector_jobs.status = 'processing' THEN memory_segment_vector_jobs.attempt_count ELSE 0 END,
    last_error = NULL,
    next_attempt_at = excluded.next_attempt_at,
    lease_token = CASE WHEN memory_segment_vector_jobs.status = 'processing' THEN memory_segment_vector_jobs.lease_token ELSE NULL END,
    lease_expires_at = CASE WHEN memory_segment_vector_jobs.status = 'processing' THEN memory_segment_vector_jobs.lease_expires_at ELSE NULL END,
    operation_token = NULL,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER IF NOT EXISTS memory_segment_vector_jobs_after_update
AFTER UPDATE OF text, content_hash, metadata_json, session_id, tape, expires_at, deletion_state ON memory_segments
BEGIN
  INSERT INTO memory_segment_vector_jobs (
    project_id, segment_id, revision, operation, segment_updated_at, status,
    attempt_count, last_error, next_attempt_at, lease_token, lease_expires_at, operation_token, created_at, updated_at
  ) VALUES (
    NEW.project_id, NEW.id, 1,
    CASE WHEN NEW.deletion_state = 'active' THEN 'upsert' ELSE 'delete' END,
    NEW.updated_at, 'pending', 0, NULL, NEW.updated_at, NULL, NULL, NULL, NEW.updated_at, NEW.updated_at
  )
  ON CONFLICT (project_id, segment_id) DO UPDATE SET
    revision = memory_segment_vector_jobs.revision + 1,
    operation = excluded.operation,
    segment_updated_at = excluded.segment_updated_at,
    status = CASE WHEN memory_segment_vector_jobs.status = 'processing' THEN 'processing' ELSE 'pending' END,
    attempt_count = CASE WHEN memory_segment_vector_jobs.status = 'processing' THEN memory_segment_vector_jobs.attempt_count ELSE 0 END,
    last_error = NULL,
    next_attempt_at = excluded.next_attempt_at,
    lease_token = CASE WHEN memory_segment_vector_jobs.status = 'processing' THEN memory_segment_vector_jobs.lease_token ELSE NULL END,
    lease_expires_at = CASE WHEN memory_segment_vector_jobs.status = 'processing' THEN memory_segment_vector_jobs.lease_expires_at ELSE NULL END,
    operation_token = NULL,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER IF NOT EXISTS memory_segment_vector_jobs_after_delete
AFTER DELETE ON memory_segments
BEGIN
  INSERT INTO memory_segment_vector_jobs (
    project_id, segment_id, revision, operation, segment_updated_at, status,
    attempt_count, last_error, next_attempt_at, lease_token, lease_expires_at, operation_token, created_at, updated_at
  ) VALUES (
    OLD.project_id, OLD.id, 1, 'delete', OLD.updated_at,
    'pending', 0, NULL, OLD.updated_at, NULL, NULL, NULL, OLD.updated_at, OLD.updated_at
  )
  ON CONFLICT (project_id, segment_id) DO UPDATE SET
    revision = memory_segment_vector_jobs.revision + 1,
    operation = 'delete',
    segment_updated_at = excluded.segment_updated_at,
    status = CASE WHEN memory_segment_vector_jobs.status = 'processing' THEN 'processing' ELSE 'pending' END,
    last_error = NULL,
    next_attempt_at = excluded.next_attempt_at,
    operation_token = NULL,
    updated_at = excluded.updated_at;
END;
