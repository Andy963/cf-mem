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
    options: { topK: number; namespace?: string; filter?: Record<string, Primitive> },
  ): Promise<VectorizeQueryResult>;
}

export interface Env {
  AI: Ai;
  DB: D1Database;
  SEGMENTS_INDEX: VectorizeIndex;

  API_TOKEN?: string;
  PROJECT_TOKENS_JSON?: string;
  CORS_ALLOW_ORIGIN?: string;

  EMBEDDING_MODEL?: string;
  RERANK_MODEL?: string;
  RERANK_DEFAULT_ENABLED?: string;
}
