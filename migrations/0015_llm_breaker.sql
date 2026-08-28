-- Single-row circuit breaker for the extractor LLM (profile extraction,
-- verification, reconciliation, and claim-dedup judging all share one upstream
-- endpoint). When the provider starts failing consistently, the breaker opens
-- so cron ticks stop burning retries against a dead endpoint. after_open_until
-- passes, one real call is allowed through (half-open); success closes it.
CREATE TABLE IF NOT EXISTS llm_breaker_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  open_until_at INTEGER,
  last_error TEXT,
  updated_at INTEGER NOT NULL
);
INSERT OR IGNORE INTO llm_breaker_state (id, consecutive_failures, open_until_at, updated_at)
VALUES (1, 0, NULL, unixepoch() * 1000);
