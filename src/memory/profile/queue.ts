import { fetchByIds } from "../../db/d1";
import type { Env } from "../../env";
import type { ProjectScope } from "../../project";
import { chunkArray, sha256Hex } from "../../utils";
import { ClaimSchemaError } from "../claims";
import { indexMemoryItems } from "../indexer";
import { type BreakerOpenError } from "../llm-breaker";
import { defaultMemorySchema, deriveSegmentIdSuffix } from "../schema";
import {
  configuredOwner,
  parseEvidenceIngestInput,
  parseIngestInput,
  requiredExternalSessionId,
} from "./input";
import {
  INBOX_DELETE_CHUNK_SIZE,
  LEASE_DURATION_MS,
  MAX_ATTEMPTS,
  PROFILE_EVIDENCE_HASH_CHARS,
  errorLabel,
  retryDelayMs,
  type JobStatus,
  type ProfileJob,
} from "./shared";

export async function leaseJob(env: Env, id: string, now: number): Promise<ProfileJob | null> {
  const leaseToken = crypto.randomUUID();
  const result = await env.DB.prepare(
    `UPDATE profile_extraction_jobs
     SET status = 'processing', attempt_count = attempt_count + 1, lease_token = ?, lease_expires_at = ?, updated_at = ?
     WHERE id = ? AND attempt_count < ? AND (
       (status IN ('pending', 'failed') AND next_attempt_at <= ?)
       OR (status = 'processing' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
     )`,
  ).bind(leaseToken, now + LEASE_DURATION_MS, now, id, MAX_ATTEMPTS, now, now).run();
  if (!result.meta.changes) return null;
  return await env.DB.prepare(
    "SELECT id, project_id, evidence_segment_id, evidence_segment_ids_json, owner_id, source_app, workspace_id, status, attempt_count, lease_token FROM profile_extraction_jobs WHERE id = ?",
  ).bind(id).first<ProfileJob>();
}

export async function nextReadyJobIds(env: Env, now: number, limit: number): Promise<string[]> {
  await env.DB.prepare(
    "UPDATE profile_extraction_jobs SET status = 'dead', lease_token = NULL, lease_expires_at = NULL, last_error = COALESCE(last_error, 'lease_expired_after_final_attempt'), updated_at = ? WHERE status = 'processing' AND attempt_count >= ? AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?",
  ).bind(now, MAX_ATTEMPTS, now).run();
  const result = await env.DB.prepare(
    `SELECT id FROM profile_extraction_jobs
     WHERE attempt_count < ? AND (
       (status IN ('pending', 'failed') AND next_attempt_at <= ?)
       OR (status = 'processing' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
     )
     ORDER BY next_attempt_at ASC, created_at ASC
     LIMIT ?`,
  ).bind(MAX_ATTEMPTS, now, now, limit).all<{ id: string }>();
  return result.results.map((job) => job.id);
}

export async function completeJob(env: Env, job: ProfileJob, note: string | null): Promise<void> {
  await env.DB.prepare(
    "UPDATE profile_extraction_jobs SET status = 'completed', lease_token = NULL, lease_expires_at = NULL, last_error = ?, updated_at = ? WHERE id = ? AND lease_token = ?",
  ).bind(note, Date.now(), job.id, job.lease_token).run();
}

export async function failJob(env: Env, job: ProfileJob, error: unknown): Promise<void> {
  const now = Date.now();
  const status: JobStatus = job.attempt_count >= MAX_ATTEMPTS ? "dead" : "failed";
  await env.DB.prepare(
    "UPDATE profile_extraction_jobs SET status = ?, lease_token = NULL, lease_expires_at = NULL, last_error = ?, next_attempt_at = ?, updated_at = ? WHERE id = ? AND lease_token = ?",
  ).bind(status, errorLabel(error), now + retryDelayMs(job.attempt_count), now, job.id, job.lease_token).run();
}

export async function deferJobAfterBreakerOpen(env: Env, job: ProfileJob, error: BreakerOpenError): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    "UPDATE profile_extraction_jobs SET status = 'pending', attempt_count = CASE WHEN attempt_count > 0 THEN attempt_count - 1 ELSE 0 END, lease_token = NULL, lease_expires_at = NULL, last_error = ?, next_attempt_at = ?, updated_at = ? WHERE id = ? AND lease_token = ?",
  ).bind(errorLabel(error), error.openUntilAt, now, job.id, job.lease_token).run();
}

function evidenceGroupKey(input: { ownerId: string; sourceApp: string; externalSessionId: string; workspaceId: string | null }): string {
  return [input.ownerId, input.sourceApp, input.externalSessionId, input.workspaceId ?? ""].join("\n");
}

/**
 * Appends evidence to the buffer instead of creating one extraction job per
 * message. The cron sweep decides where a batch ends, so the extractor sees a
 * whole span of conversation rather than a single isolated turn.
 */
export async function enqueueProfileIngest(
  env: Env,
  scope: ProjectScope,
  body: unknown,
): Promise<{ evidenceId: string; buffered: true }> {
  const input = parseIngestInput(body);
  const ownerId = configuredOwner(env);
  const idempotencyKey = await sha256Hex([input.sourceApp, input.externalSessionId, input.workspaceId ?? "", input.role, input.idempotencySuffix || input.text].join("\n"));
  // Vectorize ids are capped at 64 bytes and `project:<id>:` eats into that, so
  // the digest width adapts to the project id instead of assuming it is short.
  const evidenceId = deriveSegmentIdSuffix(scope, "pe_", idempotencyKey, PROFILE_EVIDENCE_HASH_CHARS);
  const prepared = await defaultMemorySchema.prepareIndexItems([{
    id: evidenceId,
    text: `[${input.role}] ${input.text}`,
    metadata: {
      session_id: `${input.sourceApp}:${input.externalSessionId}`,
      kind: "profile_inbox",
      // Buffered conversation evidence is not a domain fact. Tag it so the
      // default raw-memory search cannot surface personal prompts as RAG facts.
      category: "user_profile",
      role: input.role,
      source_app: input.sourceApp,
      user_id: ownerId,
      workspace_id: input.workspaceId ?? "",
      ...(input.workspaceName ? { workspace_name: input.workspaceName } : {}),
    },
  }], scope);
  const indexed = await indexMemoryItems(env, prepared);
  const segmentId = indexed.ids[0];
  const now = Date.now();
  // The segment id already encodes the ingest idempotency key, so re-posting the
  // same text is a no-op rather than a duplicate buffer entry.
  await env.DB.prepare(
    "INSERT OR IGNORE INTO profile_evidence_inbox (id, project_id, group_key, owner_id, source_app, external_session_id, workspace_id, char_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(
    segmentId,
    scope.projectId,
    evidenceGroupKey({ ownerId, sourceApp: input.sourceApp, externalSessionId: input.externalSessionId, workspaceId: input.workspaceId }),
    ownerId,
    input.sourceApp,
    input.externalSessionId,
    input.workspaceId,
    // Only the `[user]` payload survives userOriginatedText, so budget on that.
    input.text.length,
    now,
  ).run();
  return { evidenceId: segmentId, buffered: true };
}

/**
 * Creates one extraction job covering a whole batch of evidence. The
 * idempotency key is derived from the sorted evidence ids, so re-flushing the
 * same batch collapses onto the existing job.
 */
export async function createExtractionJob(
  env: Env,
  projectId: string,
  batch: {
    evidenceSegmentIds: string[];
    ownerId: string;
    sourceApp: string;
    externalSessionId: string;
    workspaceId: string | null;
  },
): Promise<string> {
  const sourceApp = batch.sourceApp.trim().toLowerCase();
  if (!sourceApp) throw new ClaimSchemaError("source_app must not be empty");
  const externalSessionId = requiredExternalSessionId(sourceApp, batch.externalSessionId);
  const idempotencyKey = await sha256Hex([
    sourceApp,
    externalSessionId,
    batch.ownerId,
    batch.workspaceId ?? "",
    ...[...batch.evidenceSegmentIds].sort(),
  ].join("\n"));
  const now = Date.now();
  const jobId = `profile_job_${crypto.randomUUID()}`;
  await env.DB.prepare(
    "INSERT OR IGNORE INTO profile_extraction_jobs (id, project_id, evidence_segment_id, evidence_segment_ids_json, owner_id, source_app, workspace_id, idempotency_key, status, attempt_count, next_attempt_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)",
  ).bind(
    jobId,
    projectId,
    batch.evidenceSegmentIds[0],
    JSON.stringify(batch.evidenceSegmentIds),
    batch.ownerId,
    sourceApp,
    batch.workspaceId,
    idempotencyKey,
    now,
    now,
    now,
  ).run();
  const job = await env.DB.prepare(
    "SELECT id FROM profile_extraction_jobs WHERE project_id = ? AND idempotency_key = ?",
  ).bind(projectId, idempotencyKey).first<{ id: string }>();
  if (!job) throw new Error("profile_evidence_job_not_created");
  return job.id;
}

export async function markSegmentsExtracted(env: Env, projectId: string, segmentIds: string[], now: number): Promise<void> {
  const uniqueIds = [...new Set(segmentIds)];
  for (const idChunk of chunkArray(uniqueIds, INBOX_DELETE_CHUNK_SIZE)) {
    const placeholders = idChunk.map(() => "?").join(",");
    await env.DB.prepare(
      `UPDATE memory_segments SET extracted_at = COALESCE(extracted_at, ?) WHERE project_id = ? AND deletion_state = 'active' AND id IN (${placeholders})`,
    ).bind(now, projectId, ...idChunk).run();
  }
}

export async function enqueueEvidenceExtraction(env: Env, scope: ProjectScope, body: unknown): Promise<{ jobId: string }> {
  const input = parseEvidenceIngestInput(body);
  const evidence = await fetchByIds(env.DB, scope.projectId, input.evidenceSegmentIds);
  if (evidence.size !== input.evidenceSegmentIds.length) {
    throw new ClaimSchemaError("All evidence_segment_ids must reference memory segments in the authenticated project");
  }
  const jobId = await createExtractionJob(env, scope.projectId, {
    evidenceSegmentIds: input.evidenceSegmentIds,
    ownerId: input.userId,
    sourceApp: input.sourceApp,
    externalSessionId: input.externalSessionId,
    workspaceId: input.workspaceId,
  });
  await markSegmentsExtracted(env, scope.projectId, input.evidenceSegmentIds, Date.now());
  return { jobId };
}
