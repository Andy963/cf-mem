-- forgetScopedMemory matches segments by their metadata user_id. Without a
-- matching expression index that is a full table scan plus a JSON parse per row,
-- which makes user-scoped deletion time out on large projects.
--
-- The expression must match the query in src/memory/retention.ts exactly for
-- SQLite to use the index. The CAST is required for correctness there:
-- json_extract returns the native JSON type, and metadata user_id is documented
-- as a number, so comparing it to a bound TEXT parameter without the CAST would
-- never match and would silently skip those segments.
CREATE INDEX IF NOT EXISTS idx_memory_segments_metadata_user_id
  ON memory_segments (project_id, CAST(json_extract(metadata_json, '$.user_id') AS TEXT))
  WHERE deletion_state = 'active';
