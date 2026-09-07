import type { Env } from "../../env";
import { ClaimSchemaError } from "../claims";
import { normalizeExternalSessionId } from "../session";
import { sanitizeIngestText } from "../web-reference";
import {
  MAX_EVIDENCE_SEGMENTS,
  MAX_SESSION_ID_LENGTH,
  MAX_SOURCE_APP_LENGTH,
  MAX_TEXT_LENGTH,
} from "./shared";

export function configuredOwner(env: Env): string {
  const value = env.PERSONAL_MEMORY_OWNER_ID?.trim();
  if (!value) throw new ClaimSchemaError("PERSONAL_MEMORY_OWNER_ID is required");
  return value;
}

export function boundedText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string") throw new ClaimSchemaError(`${field} must be a string`);
  const normalized = value.trim();
  if (!normalized) throw new ClaimSchemaError(`${field} must not be empty`);
  if (normalized.length > maxLength) throw new ClaimSchemaError(`${field} must be at most ${maxLength} characters`);
  return normalized;
}

export function sanitizedIngestText(text: string): string {
  const sanitized = sanitizeIngestText(text);
  if (!sanitized) throw new ClaimSchemaError("text must contain user-authored content");
  return sanitized;
}

export function requiredExternalSessionId(sourceApp: string, value: string): string {
  const normalized = normalizeExternalSessionId(sourceApp, value);
  if (!normalized) throw new ClaimSchemaError("external_session_id must not be empty after normalization");
  return normalized;
}

export function parseIngestInput(value: unknown): { text: string; role: "user" | "assistant"; sourceApp: string; externalSessionId: string; idempotencySuffix: string; workspaceId: string | null; workspaceName: string | null } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ClaimSchemaError("Request body must be an object");
  }
  const body = value as Record<string, unknown>;
  const sourceApp = boundedText(body.source_app, "source_app", MAX_SOURCE_APP_LENGTH).toLowerCase();
  if (!["claude", "codex", "droid", "whisper"].includes(sourceApp)) {
    throw new ClaimSchemaError("source_app must be claude, codex, droid, or whisper");
  }
  const rawRole = body.role === undefined || body.role === null
    ? "user"
    : boundedText(body.role, "role", 16).toLowerCase();
  if (rawRole !== "user" && rawRole !== "assistant") {
    throw new ClaimSchemaError("role must be user or assistant");
  }
  return {
    // Page text inlined by a client is stripped here; the Worker fetches the
    // links itself at flush time, so what a caller labels as web content can
    // never enter the evidence stream as user speech.
    text: sanitizedIngestText(boundedText(body.text, "text", MAX_TEXT_LENGTH)),
    role: rawRole,
    sourceApp,
    externalSessionId: requiredExternalSessionId(
      sourceApp,
      boundedText(body.external_session_id, "external_session_id", MAX_SESSION_ID_LENGTH),
    ),
    idempotencySuffix: body.event_id === undefined
      ? ""
      : boundedText(body.event_id, "event_id", 128),
    workspaceId: body.workspace_id === undefined || body.workspace_id === null
      ? null
      : boundedText(body.workspace_id, "workspace_id", 256),
    workspaceName: body.workspace_name === undefined || body.workspace_name === null
      ? null
      : boundedText(body.workspace_name, "workspace_name", 256),
  };
}

export function parseEvidenceIngestInput(value: unknown): {
  evidenceSegmentIds: string[];
  sourceApp: string;
  externalSessionId: string;
  userId: string;
  workspaceId: string | null;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ClaimSchemaError("Request body must be an object");
  }
  const body = value as Record<string, unknown>;
  const sourceApp = boundedText(body.source_app, "source_app", MAX_SOURCE_APP_LENGTH).toLowerCase();
  if (!["claude", "codex", "droid", "whisper"].includes(sourceApp)) {
    throw new ClaimSchemaError("source_app must be claude, codex, droid, or whisper");
  }
  if (!Array.isArray(body.evidence_segment_ids)) {
    throw new ClaimSchemaError("evidence_segment_ids must be an array");
  }
  const evidenceSegmentIds = [...new Set(body.evidence_segment_ids.map((segmentId) => boundedText(segmentId, "evidence_segment_ids[]", 512)))];
  if (evidenceSegmentIds.length === 0 || evidenceSegmentIds.length > MAX_EVIDENCE_SEGMENTS) {
    throw new ClaimSchemaError(`evidence_segment_ids must contain 1 to ${MAX_EVIDENCE_SEGMENTS} ids`);
  }
  return {
    evidenceSegmentIds,
    sourceApp,
    externalSessionId: requiredExternalSessionId(
      sourceApp,
      boundedText(body.external_session_id, "external_session_id", MAX_SESSION_ID_LENGTH),
    ),
    userId: boundedText(body.user_id, "user_id", 256),
    workspaceId: body.workspace_id === undefined || body.workspace_id === null
      ? null
      : boundedText(body.workspace_id, "workspace_id", 256),
  };
}
