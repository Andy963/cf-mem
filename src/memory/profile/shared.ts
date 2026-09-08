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

const CLAIM_OPERATIONS = ["create", "reinforce", "supersede", "retract"] as const;
type ClaimOperation = (typeof CLAIM_OPERATIONS)[number];

const CANDIDATE_KINDS = [
  "preference",
  "instruction",
  "decision",
  "profile",
  "current_state",
  "opinion",
  "none",
] as const;
type CandidateKind = (typeof CANDIDATE_KINDS)[number];

const AGENT_RELEVANCES = ["global_behavior", "contextual", "none"] as const;
type AgentRelevance = (typeof AGENT_RELEVANCES)[number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim());
}

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!isRecord(value)) return false;
  return Object.values(value).every(isJsonValue);
}

function isClaimOperation(value: unknown): value is ClaimOperation {
  return typeof value === "string" && (CLAIM_OPERATIONS as readonly string[]).includes(value);
}

function isClaimType(value: unknown): value is ClaimType {
  return typeof value === "string" && CLAIM_TYPES.has(value);
}

function isClaimCategory(value: unknown): value is ClaimCategory {
  return typeof value === "string" && (CLAIM_CATEGORIES as readonly string[]).includes(value);
}

function isCandidateKind(value: unknown): value is CandidateKind {
  return typeof value === "string" && (CANDIDATE_KINDS as readonly string[]).includes(value);
}

function isAgentRelevance(value: unknown): value is AgentRelevance {
  return typeof value === "string" && (AGENT_RELEVANCES as readonly string[]).includes(value);
}

export function normalizedExtractorCandidate(value: unknown, workspaceId: string | null = null): ExtractedClaim | null {
  if (!isRecord(value)) return null;
  let candidate = value;
  if (isRecord(candidate.operation)) {
    const nested = candidate.operation;
    if (hasOwn(nested, "claim_id") || hasOwn(nested, "replaces_claim_id")) return null;
    candidate = { ...candidate, ...nested, operation: "create" };
  }

  const rawOperation = candidate.operation;
  const operation = rawOperation === undefined ? "create" : rawOperation;
  if (!isClaimOperation(operation)) return null;

  const rawType = candidate.type === null ? undefined : candidate.type;
  const effectiveType = rawType === undefined
    ? undefined
    : isClaimType(rawType) ? rawType : null;
  if (effectiveType === null) return null;

  const rawKind = candidate.candidate_kind;
  if (rawKind !== undefined && !isCandidateKind(rawKind)) return null;
  const effectiveKind = rawKind ?? effectiveType;
  if (effectiveKind === undefined) return null;
  if (effectiveType !== undefined && effectiveKind !== effectiveType) return null;
  if (isClaimType(effectiveKind) && effectiveType === undefined) return null;

  let applicability: ClaimApplicability | undefined;
  const applicabilityExplicit = candidate.applicability !== undefined && candidate.applicability !== null;
  if (applicabilityExplicit && typeof candidate.applicability !== "string") return null;
  if (typeof candidate.applicability === "string") {
    const appLower = candidate.applicability.toLowerCase();
    if (appLower === "global" || appLower === "always" || appLower.includes("所有") || appLower.includes("全局")) {
      applicability = "global";
    } else if (appLower === "workspace" || appLower.includes("工作区")) {
      applicability = "workspace";
    } else if (appLower === "semantic") {
      applicability = "semantic";
    } else {
      return null;
    }
  }

  const explicit = candidate.explicit === undefined ? true : candidate.explicit;
  if (typeof explicit !== "boolean") return null;
  const agentRelevance = candidate.agent_relevance === undefined ? "global_behavior" : candidate.agent_relevance;
  if (!isAgentRelevance(agentRelevance)) return null;

  const categoryExplicit = candidate.category !== undefined && candidate.category !== null;
  let category: ClaimCategory | undefined;
  if (categoryExplicit) {
    if (!isClaimCategory(candidate.category)) return null;
    category = candidate.category;
  } else if (effectiveType) {
    category = inferClaimCategory(effectiveType, applicability, workspaceId);
  } else {
    category = "domain_fact";
  }

  const resolvedCategory = category ?? "domain_fact";
  if (applicability === undefined) applicability = defaultClaimApplicability(resolvedCategory, workspaceId);

  const rawScopeId = candidate.scope_id;
  if (rawScopeId !== undefined && (typeof rawScopeId !== "string" || !rawScopeId.trim() || rawScopeId.trim().length > 256)) {
    return null;
  }

  const claimId = candidate.claim_id === null ? undefined : candidate.claim_id;
  if (claimId !== undefined && (!isNonEmptyString(claimId) || claimId.trim().length > 512)) return null;
  const replacesClaimId = candidate.replaces_claim_id === null ? undefined : candidate.replaces_claim_id;
  if (replacesClaimId !== undefined && (!isNonEmptyString(replacesClaimId) || replacesClaimId.trim().length > 512)) return null;

  if (operation === "reinforce" || operation === "retract") {
    if (!isNonEmptyString(claimId)) return null;
  } else if (operation === "supersede" && !isNonEmptyString(replacesClaimId)) {
    return null;
  }

  const evidenceSegmentIds = candidate.evidence_segment_ids;
  if (evidenceSegmentIds !== undefined) {
    if (!Array.isArray(evidenceSegmentIds) || !evidenceSegmentIds.every(isNonEmptyString)) return null;
  }

  const validUntil = candidate.valid_until;
  if (validUntil !== undefined && validUntil !== null
    && (typeof validUntil !== "number" || !Number.isInteger(validUntil) || validUntil < 0)) {
    return null;
  }

  const confidence = candidate.confidence;
  if (operation === "create" || operation === "supersede") {
    if (!isNonEmptyString(candidate.subject)
      || !isNonEmptyString(candidate.memory_key)
      || !isNonEmptyString(candidate.canonical_text)
      || !hasOwn(candidate, "value")
      || !isJsonValue(candidate.value)
      || typeof confidence !== "number"
      || !Number.isFinite(confidence)
      || confidence < 0
      || confidence > 1) {
      return null;
    }
  } else if (confidence !== undefined && confidence !== null
    && (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1)) {
    return null;
  }

  const normalized: ExtractedClaim = {
    operation,
    category: resolvedCategory,
    category_explicit: categoryExplicit,
    applicability_explicit: applicabilityExplicit,
    scope_id: typeof rawScopeId === "string" ? rawScopeId.trim() : undefined,
    type: effectiveType,
    candidate_kind: effectiveKind,
    applicability,
    explicit,
    agent_relevance: agentRelevance,
    evidence_segment_ids: Array.isArray(evidenceSegmentIds)
      ? evidenceSegmentIds.map((id) => id.trim())
      : undefined,
    claim_id: typeof claimId === "string" ? claimId.trim() : undefined,
    replaces_claim_id: typeof replacesClaimId === "string" ? replacesClaimId.trim() : undefined,
    valid_until: typeof validUntil === "number" ? validUntil : undefined,
    confidence: typeof confidence === "number" ? confidence : undefined,
    subject: typeof candidate.subject === "string" ? candidate.subject.trim() : undefined,
    memory_key: typeof candidate.memory_key === "string" ? candidate.memory_key.trim() : undefined,
    canonical_text: typeof candidate.canonical_text === "string" ? candidate.canonical_text.trim() : undefined,
    value: hasOwn(candidate, "value") ? candidate.value : undefined,
  };

  return normalized;
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
