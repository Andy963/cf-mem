import { fetchOwnerClaims as fetchOwnerClaimRows, type StoredClaimRow } from "../../db/d1";
import type { Env } from "../../env";
import {
  CLAIM_CATEGORIES,
  defaultClaimApplicability,
  inferClaimCategory,
  type ClaimApplicability,
  type ClaimCategory,
  type ClaimType,
} from "../claims";

export const MAX_TEXT_LENGTH = 8_000;
export const MAX_SOURCE_APP_LENGTH = 64;
export const MAX_SESSION_ID_LENGTH = 256;
export const MAX_EVIDENCE_SEGMENTS = 64;
export const MAX_EVIDENCE_CHARS = 64_000;
export const MAX_WEB_REFERENCE_EVIDENCE_CHARS = 6_000;
export const MAX_ASSISTANT_EVIDENCE_CHARS = 8_000;
export const MAX_WEB_REFERENCE_SEGMENTS_PER_JOB = 3;
export const MAX_ATTEMPTS = 8;
export const LEASE_DURATION_MS = 240_000;
export const EXTRACTOR_TIMEOUT_MS = 60_000;
export const MAX_EXTRACTOR_OUTPUT_TOKENS = 32_000;
export const MAX_VERIFIER_OUTPUT_TOKENS = 8_000;
export const MAX_RECONCILIATION_OUTPUT_TOKENS = 16_000;
export const MAX_EXTRACTOR_CANDIDATES = 32;
export const PROFILE_EVIDENCE_HASH_CHARS = 40;
export const MAX_ACTIVE_OWNER_CLAIMS = 200;
export const MAX_INACTIVE_OWNER_CLAIMS = 50;
export const DEFAULT_BATCH_MAX_CHARS = 64_000;
export const DEFAULT_BATCH_IDLE_MS = 900_000;
export const MAX_FLUSH_BATCHES_PER_GROUP = 4;
export const INBOX_DELETE_CHUNK_SIZE = 50;

export type JobStatus = "pending" | "processing" | "completed" | "failed" | "dead";

export interface ProfileJob {
  id: string;
  project_id: string;
  evidence_segment_id: string;
  evidence_segment_ids_json: string | null;
  owner_id: string;
  source_app: string;
  workspace_id: string | null;
  status: JobStatus;
  attempt_count: number;
  lease_token: string | null;
}

export interface ExtractedClaim {
  operation: "create" | "reinforce" | "supersede" | "retract";
  replaces_claim_id?: string;
  claim_id?: string;
  category?: ClaimCategory;
  category_explicit?: boolean;
  applicability_explicit?: boolean;
  scope_id?: string;
  type?: string;
  subject?: string;
  memory_key?: string;
  value?: unknown;
  canonical_text?: string;
  confidence?: number;
  applicability?: "global" | "semantic" | "workspace";
  evidence_segment_ids?: string[];
  candidate_kind?: "preference" | "instruction" | "decision" | "profile" | "current_state" | "opinion" | "none";
  explicit?: boolean;
  agent_relevance?: "global_behavior" | "contextual" | "none";
  valid_until?: number;
}

export interface CandidateVerdict {
  candidate_index: number;
  verdict: "accept" | "reject" | "hold";
  reason: string;
}

export interface ReconciliationDecision {
  candidate_index: number;
  action: "keep" | "reinforce" | "supersede";
  claim_id?: string;
  replaces_claim_id?: string;
  reason: string;
}

export const CLAIM_TYPES = new Set(["preference", "instruction", "decision", "profile"]);

export function normalizedExtractorCandidate(value: unknown, workspaceId: string | null = null): ExtractedClaim | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  let candidate = value as Record<string, unknown>;
  if (candidate.operation && typeof candidate.operation === "object" && !Array.isArray(candidate.operation)) {
    const nested = candidate.operation as Record<string, unknown>;
    candidate = { ...candidate, ...nested, operation: "create" };
  }

  const typeStr = typeof candidate.type === "string" ? candidate.type : undefined;
  const kindStr = typeof candidate.candidate_kind === "string" ? candidate.candidate_kind : undefined;
  const effectiveType = (typeStr && CLAIM_TYPES.has(typeStr))
    ? typeStr
    : (kindStr && CLAIM_TYPES.has(kindStr) ? kindStr : undefined);
  const effectiveKind = kindStr ?? effectiveType;

  let applicability: ClaimApplicability | undefined;
  if (typeof candidate.applicability === "string") {
    const appLower = candidate.applicability.toLowerCase();
    if (appLower === "global" || appLower === "always" || appLower.includes("所有") || appLower.includes("全局")) {
      applicability = "global";
    } else if (appLower === "workspace" || appLower.includes("工作区")) {
      applicability = "workspace";
    } else {
      applicability = "semantic";
    }
  }

  const explicit = candidate.explicit !== false;
  const agentRelevance = candidate.agent_relevance === "contextual" || candidate.agent_relevance === "global_behavior"
    ? candidate.agent_relevance
    : "global_behavior";

  const categoryExplicit = candidate.category !== undefined && candidate.category !== null;
  const applicabilityExplicit = candidate.applicability !== undefined && candidate.applicability !== null;
  let category: ClaimCategory | undefined;
  if (categoryExplicit) {
    if (typeof candidate.category !== "string" || !(CLAIM_CATEGORIES as readonly string[]).includes(candidate.category)) return null;
    category = candidate.category as ClaimCategory;
  } else if (effectiveType && CLAIM_TYPES.has(effectiveType)) {
    category = inferClaimCategory(effectiveType as ClaimType, applicability, workspaceId);
  } else {
    category = "domain_fact";
  }

  const resolvedCategory = category ?? "domain_fact";
  if (applicability === undefined) applicability = defaultClaimApplicability(resolvedCategory, workspaceId);

  const rawScopeId = candidate.scope_id;
  if (rawScopeId !== undefined && (typeof rawScopeId !== "string" || !rawScopeId.trim() || rawScopeId.trim().length > 256)) {
    return null;
  }

  const val = candidate.value !== undefined ? candidate.value : candidate.canonical_text;
  const op = typeof candidate.operation === "string" ? candidate.operation : "create";

  return {
    ...candidate,
    category: resolvedCategory,
    category_explicit: categoryExplicit,
    applicability_explicit: applicabilityExplicit,
    scope_id: typeof rawScopeId === "string" ? rawScopeId.trim() : undefined,
    type: effectiveType,
    candidate_kind: effectiveKind as any,
    applicability,
    explicit,
    agent_relevance: agentRelevance,
    value: val,
    operation: op as any,
  } as ExtractedClaim;
}


export type ExtractorProtocol = "chat_completions" | "responses";

export interface ExtractorConfig {
  endpoint: string;
  apiKey: string;
  model: string;
  protocol: ExtractorProtocol;
}


export function retryDelayMs(attemptCount: number): number {
  return Math.min(30_000 * 2 ** Math.max(attemptCount - 1, 0), 6 * 60 * 60 * 1_000);
}

export function errorLabel(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

export async function fetchOwnerClaims(env: Env, projectId: string, ownerId: string, workspaceId: string | null): Promise<StoredClaimRow[]> {
  return await fetchOwnerClaimRows(env.DB, projectId, ownerId, MAX_ACTIVE_OWNER_CLAIMS, MAX_INACTIVE_OWNER_CLAIMS, workspaceId);
}

export interface ResolvedProfileClaimScope {
  scopeKind: StoredClaimRow["scope_kind"];
  scopeId: string;
}

export function resolveProfileClaimScope(
  existing: Pick<StoredClaimRow, "scope_kind" | "scope_id"> | null,
  category: ClaimCategory,
  type: ClaimType | undefined,
  extractedScopeId: string | undefined,
  ownerId: string,
  projectId: string,
): ResolvedProfileClaimScope {
  if (existing) return { scopeKind: existing.scope_kind, scopeId: existing.scope_id };
  if (category === "tool_insight") {
    const scopeId = extractedScopeId?.trim();
    if (!scopeId) throw new Error("extractor_tool_insight_scope_id_required");
    return { scopeKind: "user", scopeId };
  }
  if (category === "user_profile" || type === "preference") {
    return { scopeKind: "user", scopeId: ownerId };
  }
  return { scopeKind: "project", scopeId: projectId };
}

export interface InboxRow {
  id: string;
  owner_id: string;
  source_app: string;
  external_session_id: string;
  workspace_id: string | null;
  char_count: number;
  created_at: number;
}
