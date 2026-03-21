ALTER TABLE memory_segments ADD COLUMN project_id TEXT;

UPDATE memory_segments
SET project_id = COALESCE(
  NULLIF(json_extract(metadata_json, '$.project_id'), ''),
  'legacy'
)
WHERE project_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_memory_segments_project_id ON memory_segments(project_id);
CREATE INDEX IF NOT EXISTS idx_memory_segments_project_updated_at ON memory_segments(project_id, updated_at);
