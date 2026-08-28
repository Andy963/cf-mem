-- Tracks whether a raw user segment has been fed through the durable-memory
-- extraction pipeline. The cron nudge sweep uses extracted_at IS NULL to find
-- segments that were indexed (POST /memory/index) but never turned into
-- candidate evidence, and extract_failed_count to stop retrying segments whose
-- extraction keeps failing (LLM outage loops burn tokens for nothing).
ALTER TABLE memory_segments ADD COLUMN extracted_at INTEGER;
ALTER TABLE memory_segments ADD COLUMN extract_failed_count INTEGER NOT NULL DEFAULT 0;
