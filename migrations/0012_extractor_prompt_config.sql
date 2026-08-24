-- Stores editable extractor and verifier prompt instructions.
-- When no row exists, profile.ts falls back to compiled defaults.
CREATE TABLE IF NOT EXISTS extractor_prompt_config (
  id TEXT PRIMARY KEY DEFAULT 'default',
  extractor_instructions TEXT NOT NULL,
  verifier_instructions TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);
