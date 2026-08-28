-- Usage feedback for durable claims: /memory/context updates these when a
-- claim is actually injected into an agent turn. Enables "dead memory"
-- identification (admin views, retention rules for never-used proposed claims)
-- instead of judging only by wall-clock age.
ALTER TABLE memory_claims ADD COLUMN use_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memory_claims ADD COLUMN last_used_at INTEGER;
