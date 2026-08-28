import type { ProjectScope } from "../project";
import { clampInt } from "../utils";

export const CLAIM_TYPES = ["preference", "instruction", "decision", "profile", "task_state"] as const;
export const CLAIM_STATUSES = ["active", "superseded", "retracted", "proposed"] as const;
export const CLAIM_PROVENANCES = ["user_explicit", "user_confirmed", "model_inferred"] as const;
export const SCOPE_KINDS = ["project", "user", "session"] as const;
export const CLAIM_APPLICABILITIES = ["global", "semantic", "workspace"] as const;

export type ClaimType = (typeof CLAIM_TYPES)[number];
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];
export type ClaimProvenance = (typeof CLAIM_PROVENANCES)[number];
export type ScopeKind = (typeof SCOPE_KINDS)[number];
export type ClaimApplicability = (typeof CLAIM_APPLICABILITIES)[number];

export interface ClaimInput {
  scopeKind: ScopeKind;
  scopeId: string;
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

  const provenance = asEnum(value.provenance, CLAIM_PROVENANCES, "claim.provenance");
  const evidenceSegmentIds = asSegmentIds(value.evidence_segment_ids, provenance !== "model_inferred");
  const validFrom = asOptionalTimestamp(value.valid_from, "claim.valid_from");
  const validUntil = asOptionalTimestamp(value.valid_until, "claim.valid_until");
  const applicability = value.applicability === undefined
    ? "semantic"
    : asEnum(value.applicability, CLAIM_APPLICABILITIES, "claim.applicability");
  const workspaceId = value.workspace_id === undefined || value.workspace_id === null
    ? null
    : asText(value.workspace_id, "claim.workspace_id", 256);
  if (applicability === "workspace" && !workspaceId) {
    throw new ClaimSchemaError("claim.workspace_id is required for workspace applicability");
  }
  if (applicability !== "workspace" && workspaceId !== null) {
    throw new ClaimSchemaError("claim.workspace_id is only valid for workspace applicability");
  }
  if (applicability === "global" && value.type !== "preference") {
    throw new ClaimSchemaError("only preference claims may have global applicability");
  }
  if (validFrom !== null && validUntil !== null && validUntil < validFrom) {
    throw new ClaimSchemaError("claim.valid_until must be after claim.valid_from");
  }

  return {
    scopeKind,
    scopeId,
    type: asEnum(value.type, CLAIM_TYPES, "claim.type"),
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
  "^(是|对|好|嗯|哦|行|可以|不用|没有|谢谢|多谢|辛苦|继续|"
  + "yes|no|ok|okay|sure|thanks|thank you|y|n|yep|nope|yeah|nah|hi|hey|hello|yo|sup|"
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

export function normalizeContextRequest(body: unknown): ContextRequest {
  if (body === undefined || body === null) {
    return { userId: null, sessionId: null, query: null, types: null, limit: 20, workspaceId: null, profileOnly: false };
  }
  if (!isRecord(body)) throw new ClaimSchemaError("Request body must be an object");

  const rawTypes = body.types;
  let types: ClaimType[] | null = null;
  if (rawTypes !== undefined) {
    if (!Array.isArray(rawTypes)) throw new ClaimSchemaError("types must be an array");
    types = [...new Set(rawTypes.map((value) => asEnum(value, CLAIM_TYPES, "types[]")))];
  }

  if (body.limit !== undefined && typeof body.limit !== "number") {
    throw new ClaimSchemaError("limit must be a number");
  }
  const limit = body.limit === undefined ? 20 : clampInt(body.limit as number, 1, 100);

  return {
    userId: body.user_id === undefined ? null : asText(body.user_id, "user_id", 256),
    sessionId: body.session_id === undefined ? null : asText(body.session_id, "session_id", 256),
    query: body.query === undefined ? null : asText(body.query, "query", 4000),
    types,
    limit,
    workspaceId: body.workspace_id === undefined || body.workspace_id === null
      ? null
      : asText(body.workspace_id, "workspace_id", 256),
    profileOnly: body.profile_only === true,
  };
}
