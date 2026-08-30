import type { ProjectScope } from "../project";
import { clampInt } from "../utils";

export const CLAIM_CATEGORIES = ["rule", "tool_insight", "user_profile", "domain_fact", "task_state"] as const;
export const CLAIM_TYPES = ["preference", "instruction", "decision", "profile", "task_state"] as const;
export const CLAIM_STATUSES = ["active", "superseded", "retracted", "proposed"] as const;
export const CLAIM_PROVENANCES = ["user_explicit", "user_confirmed", "model_inferred"] as const;
export const SCOPE_KINDS = ["project", "user", "session"] as const;
export const CLAIM_APPLICABILITIES = ["global", "semantic", "workspace"] as const;

export type ClaimCategory = (typeof CLAIM_CATEGORIES)[number];
export type ClaimType = (typeof CLAIM_TYPES)[number];
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];
export type ClaimProvenance = (typeof CLAIM_PROVENANCES)[number];
export type ScopeKind = (typeof SCOPE_KINDS)[number];
export type ClaimApplicability = (typeof CLAIM_APPLICABILITIES)[number];

export function inferClaimCategory(
  type: ClaimType,
  applicability: ClaimApplicability | undefined,
  workspaceId: string | null,
): ClaimCategory {
  if (type === "task_state") return "task_state";
  if (type === "profile") return "user_profile";
  if (
    type === "instruction"
    || (type === "preference" && (
      applicability === "global"
      || applicability === "workspace"
      || (applicability === undefined && workspaceId !== null)
    ))
  ) {
    return "rule";
  }
  return "domain_fact";
}

export function defaultClaimApplicability(category: ClaimCategory, workspaceId: string | null): ClaimApplicability {
  if (category === "user_profile") return "global";
  if (category === "task_state") return "workspace";
  if (workspaceId && category !== "tool_insight") return "workspace";
  if (category === "rule") return "global";
  return "semantic";
}

export interface ClaimInput {
  scopeKind: ScopeKind;
  scopeId: string;
  category: ClaimCategory;
  type: ClaimType;
  subject: string;
  memoryKey: string;
  value: unknown;
  canonicalText: string;
  provenance: ClaimProvenance;
  confidence: number;
  validFrom: number | null;
  validUntil: number | null;
  evidenceSegmentIds: string[];
  applicability: ClaimApplicability;
  workspaceId: string | null;
}

export type ClaimMutationRequest =
  | { operation: "create" | "supersede"; claim: ClaimInput }
  | { operation: "reinforce"; claimId: string; evidenceSegmentIds: string[]; confidence: number | null }
  | { operation: "retract"; claimId: string };

export interface ContextRequest {
  userId: string | null;
  sessionId: string | null;
  query: string | null;
  types: ClaimType[] | null;
  categories: ClaimCategory[] | null;
  scopeId: string | null;
  limit: number;
  workspaceId: string | null;
  profileOnly: boolean;
}

export class ClaimSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaimSchemaError";
  }
}

export function validateClaimTaxonomy(
  category: ClaimCategory,
  type: ClaimType,
  applicability: ClaimApplicability,
  workspaceId: string | null,
): void {
  if (type === "task_state" || category === "task_state") {
    if (type !== "task_state" || category !== "task_state") {
      throw new ClaimSchemaError("task_state claims must use the task_state category and type");
    }
    if (applicability !== "workspace") {
      throw new ClaimSchemaError("task_state claims must use workspace applicability");
    }
  }
  if (type === "profile" && category !== "user_profile") {
    throw new ClaimSchemaError("profile claims must use the user_profile category");
  }
  if (category === "user_profile" && type !== "profile" && type !== "preference") {
    throw new ClaimSchemaError("user_profile claims must use profile or preference type");
  }
  if (category === "tool_insight" && type === "profile") {
    throw new ClaimSchemaError("tool_insight claims cannot use profile type");
  }
  if (category === "rule" && applicability === "semantic") {
    throw new ClaimSchemaError("rule claims must use global or workspace applicability");
  }
  if (category === "user_profile" && applicability !== "global") {
    throw new ClaimSchemaError("user_profile claims must use global applicability");
  }
  if (category === "tool_insight" && applicability === "global") {
    throw new ClaimSchemaError("tool_insight claims cannot have global applicability");
  }
  if (applicability === "workspace" && !workspaceId) {
    throw new ClaimSchemaError("claim.workspace_id is required for workspace applicability");
  }
  if (applicability !== "workspace" && workspaceId !== null) {
    throw new ClaimSchemaError("claim.workspace_id is only valid for workspace applicability");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asEnum<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
  throw new ClaimSchemaError(`${field} must be one of: ${allowed.join(", ")}`);
}

function asText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string") throw new ClaimSchemaError(`${field} must be a string`);
  const text = value.trim();
  if (!text) throw new ClaimSchemaError(`${field} must not be empty`);
  if (text.length > maxLength) throw new ClaimSchemaError(`${field} must be at most ${maxLength} characters`);
  return text;
}

function asOptionalTimestamp(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new ClaimSchemaError(`${field} must be a Unix timestamp in milliseconds`);
  }
  return value;
}

function asJsonValue(value: unknown): unknown {
  if (value === undefined) throw new ClaimSchemaError("claim.value is required");

  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error("not serializable");
    JSON.parse(serialized);
  } catch {
    throw new ClaimSchemaError("claim.value must be JSON-serializable");
  }

  return value;
}

function asSegmentIds(value: unknown, required: boolean): string[] {
  if (value === undefined && !required) return [];
  if (!Array.isArray(value)) throw new ClaimSchemaError("evidence_segment_ids must be an array of ids");
  if (value.length === 0 && required) throw new ClaimSchemaError("evidence_segment_ids must not be empty");
  if (value.length > 100) throw new ClaimSchemaError("evidence_segment_ids must contain at most 100 ids");

  const ids = value.map((item) => asText(item, "evidence_segment_ids[]", 512));
  return [...new Set(ids)];
}

function asConfidence(value: unknown, field: string, required: boolean): number | null {
  if (value === undefined || value === null) {
    if (required) throw new ClaimSchemaError(`${field} is required`);
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new ClaimSchemaError(`${field} must be a number from 0 to 1`);
  }
  return value;
}

function parseClaim(value: unknown, projectScope: ProjectScope): ClaimInput {
  if (!isRecord(value)) throw new ClaimSchemaError("claim must be an object");

  const scopeKind = asEnum(value.scope_kind, SCOPE_KINDS, "claim.scope_kind");
  const requestedScopeId = asText(value.scope_id, "claim.scope_id", 256);
  const scopeId = scopeKind === "project" ? projectScope.projectId : requestedScopeId;
  if (scopeKind === "project" && requestedScopeId !== projectScope.projectId) {
    throw new ClaimSchemaError("project claim scope_id must match the authenticated project");
  }

  const type = asEnum(value.type, CLAIM_TYPES, "claim.type");
  const provenance = asEnum(value.provenance, CLAIM_PROVENANCES, "claim.provenance");
  const evidenceSegmentIds = asSegmentIds(value.evidence_segment_ids, provenance !== "model_inferred");
  const validFrom = asOptionalTimestamp(value.valid_from, "claim.valid_from");
  const validUntil = asOptionalTimestamp(value.valid_until, "claim.valid_until");
  const workspaceId = value.workspace_id === undefined || value.workspace_id === null
    ? null
    : asText(value.workspace_id, "claim.workspace_id", 256);

  const requestedCategory = value.category === undefined || value.category === null
    ? null
    : asEnum(value.category, CLAIM_CATEGORIES, "claim.category");
  const requestedApplicability = value.applicability === undefined
    ? undefined
    : asEnum(value.applicability, CLAIM_APPLICABILITIES, "claim.applicability");
  const category = requestedCategory ?? inferClaimCategory(type, requestedApplicability, workspaceId);
  const applicability = requestedApplicability === undefined
    ? defaultClaimApplicability(category, workspaceId)
    : requestedApplicability;
  const resolvedCategory = requestedCategory ?? inferClaimCategory(type, applicability, workspaceId);
  validateClaimTaxonomy(resolvedCategory, type, applicability, workspaceId);
  if (resolvedCategory === "task_state" && (validUntil === null || validUntil <= Date.now())) {
    throw new ClaimSchemaError("task_state claims require a future valid_until timestamp");
  }
  if (validFrom !== null && validUntil !== null && validUntil < validFrom) {
    throw new ClaimSchemaError("claim.valid_until must be after claim.valid_from");
  }

  return {
    scopeKind,
    scopeId,
    category: resolvedCategory,
    type,
    subject: asText(value.subject, "claim.subject", 256),
    memoryKey: asText(value.memory_key, "claim.memory_key", 256),
    value: asJsonValue(value.value),
    canonicalText: asText(value.canonical_text, "claim.canonical_text", 4000),
    provenance,
    confidence: asConfidence(value.confidence, "claim.confidence", true) as number,
    validFrom,
    validUntil,
    evidenceSegmentIds,
    applicability,
    workspaceId,
  };
}

export function normalizeClaimMutationRequest(body: unknown, projectScope: ProjectScope): ClaimMutationRequest {
  if (!isRecord(body)) throw new ClaimSchemaError("Request body must be an object");
  const operation = body.operation;

  if (operation === "create" || operation === "supersede") {
    const claim = parseClaim(body.claim, projectScope);
    if (claim.provenance === "model_inferred" && operation === "supersede") {
      throw new ClaimSchemaError("model_inferred claims cannot supersede an active claim");
    }
    return { operation, claim };
  }

  if (operation === "reinforce") {
    return {
      operation,
      claimId: asText(body.claim_id, "claim_id", 512),
      evidenceSegmentIds: asSegmentIds(body.evidence_segment_ids, true),
      confidence: asConfidence(body.confidence, "confidence", false),
    };
  }

  if (operation === "retract") {
    return { operation, claimId: asText(body.claim_id, "claim_id", 512) };
  }

  throw new ClaimSchemaError("operation must be one of: create, reinforce, supersede, retract");
}

// Prompts that carry no semantic signal — trivial acknowledgements, greetings,
// slash commands, empty input. Ported from Hermes Agent's TRIVIAL_PROMPT_RE:
// used to skip semantic recall on turns that carry no signal, saving an
// embedding round-trip and preventing stale context from derailing one-word
// replies. The alternation is anchored and may only be followed by whitespace
// or punctuation, so words that merely START with a trivial word ("okhttp",
// "notes") do NOT match, while trailing-punctuation variants ("hi!", "好。") do.
const TRIVIAL_PROMPT_RE = new RegExp(
  "^(好的|好哒|好嘞|收到|明白|知道了|没问题|可以的|行的|是|对|好|嗯嗯|嗯|哦|行|可以|不用|没有|谢谢|多谢|辛苦|继续|成|"
  + "yes|no|ok|okay|sure|thanks|thank you|thx|ty|pls|np|y|n|yep|nope|yeah|nah|hi|hey|hello|yo|sup|"
  + "continue|go ahead|proceed|do it|got it|cool|nice|great|done|next|lgtm|k)"
  + "[\\s!?.:;,，。！？、'\"~（）()\\[\\]{}<>*&^%$#@!+=`\\u00a0]*$",
  "i",
);

// Returns true when the query is too trivial to warrant semantic recall:
// empty, a slash command, or a bare greeting/acknowledgement. Callers use this
// to skip the Vectorize query path entirely — deterministic claims (scope-
// matched instructions/preferences) still load; only the semantic search and
// its embedding call are skipped.
export function isTrivialPrompt(text: string | null | undefined): boolean {
  if (!text) return true;
  const stripped = text.trim();
  if (!stripped) return true;
  if (stripped.startsWith("/")) return true;
  return TRIVIAL_PROMPT_RE.test(stripped);
}

export function normalizeClaimCategoryList(value: unknown): ClaimCategory[] | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") {
    const parts = value.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length === 0) return null;
    return [...new Set(parts.map((item) => asEnum(item, CLAIM_CATEGORIES, "categories")))];
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    return [...new Set(value.map((item) => asEnum(item, CLAIM_CATEGORIES, "categories[]")))];
  }
  throw new ClaimSchemaError("categories must be an array or comma-separated string");
}

function parseTypeList(value: unknown): ClaimType[] | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") {
    const parts = value.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length === 0) return null;
    return [...new Set(parts.map((item) => asEnum(item, CLAIM_TYPES, "types")))];
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    return [...new Set(value.map((item) => asEnum(item, CLAIM_TYPES, "types[]")))];
  }
  throw new ClaimSchemaError("types must be an array or comma-separated string");
}

export function normalizeContextRequest(body: unknown): ContextRequest {
  if (body === undefined || body === null) {
    return { userId: null, sessionId: null, query: null, types: null, categories: null, scopeId: null, limit: 20, workspaceId: null, profileOnly: false };
  }
  if (!isRecord(body)) throw new ClaimSchemaError("Request body must be an object");

  const types = parseTypeList(body.types);
  const categories = normalizeClaimCategoryList(body.categories ?? body.category);

  let limit = 20;
  if (body.limit !== undefined && body.limit !== null) {
    const rawLimit = typeof body.limit === "string" ? Number(body.limit) : body.limit;
    if (typeof rawLimit !== "number" || !Number.isFinite(rawLimit) || !Number.isInteger(rawLimit)) {
      throw new ClaimSchemaError("limit must be a number");
    }
    limit = clampInt(rawLimit, 1, 100);
  }

  return {
    userId: body.user_id === undefined || body.user_id === null ? null : asText(body.user_id, "user_id", 256),
    sessionId: body.session_id === undefined || body.session_id === null ? null : asText(body.session_id, "session_id", 256),
    query: body.query === undefined || body.query === null ? null : asText(body.query, "query", 4000),
    types,
    categories,
    scopeId: body.scope_id === undefined || body.scope_id === null ? null : asText(body.scope_id, "scope_id", 256),
    limit,
    workspaceId: body.workspace_id === undefined || body.workspace_id === null
      ? null
      : asText(body.workspace_id, "workspace_id", 256),
    profileOnly: body.profile_only === true || body.profile_only === "true",
  };
}
