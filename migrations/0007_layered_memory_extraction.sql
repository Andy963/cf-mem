ALTER TABLE profile_extraction_jobs ADD COLUMN evidence_segment_ids_json TEXT;

CREATE TABLE IF NOT EXISTS memory_extraction_candidates (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('accepted', 'rejected', 'held')),
  candidate_json TEXT NOT NULL,
  verifier_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_extraction_candidates_job
  ON memory_extraction_candidates (project_id, job_id, created_at ASC);
