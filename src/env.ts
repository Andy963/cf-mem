export type Primitive = string | number | boolean;

export interface VectorizeMatch {
  id: string;
  namespace?: string;
  score?: number;
  metadata?: Record<string, unknown>;
}

export interface VectorizeQueryResult {
  matches?: VectorizeMatch[];
  results?: VectorizeMatch[];
}

export interface VectorizeIndex {
  upsert(
    vectors: Array<{
      id: string;
      namespace?: string;
      values: number[];
      metadata?: Record<string, Primitive>;
    }>,
  ): Promise<void>;
  query(
    values: number[],
    options: {
      topK: number;
      namespace?: string;
      filter?: Record<string, Primitive>;
      returnValues?: boolean;
    },
  ): Promise<VectorizeQueryResult>;
  deleteByIds?(ids: string[]): Promise<void>;
}

export interface Env {
  AI: Ai;
  DB: D1Database;
  SEGMENTS_INDEX: VectorizeIndex;
  CLAIMS_INDEX?: VectorizeIndex;

  API_TOKEN?: string;
  PROJECT_TOKENS_JSON?: string;
  PERSONAL_MEMORY_TOKEN?: string;
  PERSONAL_MEMORY_PROJECT_ID?: string;
  PERSONAL_MEMORY_OWNER_ID?: string;
  EXTRACTOR_LLM_API_BASE?: string;
  EXTRACTOR_LLM_API_KEY?: string;
  EXTRACTOR_LLM_MODEL?: string;
  PROFILE_EXTRACTOR_PROTOCOL?: string;
  PROFILE_CONTEXT_MIN_SCORE?: string;
  PROFILE_BATCH_MAX_CHARS?: string;
  PROFILE_BATCH_MAX_SEGMENTS?: string;
  PROFILE_BATCH_IDLE_MS?: string;
  CORS_ALLOW_ORIGIN?: string;
  ADMIN_ALLOWED_EMAIL?: string;

  EMBEDDING_MODEL?: string;
  RERANK_MODEL?: string;
  RERANK_DEFAULT_ENABLED?: string;
  RAW_MEMORY_RETENTION_DAYS?: string;
  RAW_MEMORY_MAX_BYTES_PER_PROJECT?: string;
  RAW_MEMORY_TARGET_BYTES_PER_PROJECT?: string;

  MEMORY_NUDGE_MAX_SEGMENTS_PER_TICK?: string;
  MEMORY_NUDGE_MIN_AGE_MS?: string;

  CLAIM_DEDUP_SAME_SCORE?: string;
  CLAIM_DEDUP_REVIEW_MIN_SCORE?: string;
  CLAIM_DEDUP_TOP_K?: string;
  CLAIM_DEDUP_LLM_ENABLED?: string;
  CLAIM_DEDUP_AUTO_REPLACE?: string;

  TAVILY_API_TOKEN?: string;
  TAVILY_BASE_URL?: string;
}
