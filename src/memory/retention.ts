import { embedTexts } from "../ai/embedding";
import type { Env, Primitive } from "../env";
import { chunkArray } from "../utils";
import type { ProjectScope } from "../project";

const DELETE_BATCH_SIZE = 100;
const DEFAULT_RETENTION_DAYS = 90;
const DEFAULT_MAX_BYTES_PER_PROJECT = 100 * 1024 * 1024;
const DEFAULT_TARGET_BYTES_PER_PROJECT = 80 * 1024 * 1024;

type ResourceType = "segment" | "claim";
type DeletionReason = "expired" | "quota" | "user_forget";

interface DeletionJob {
  id: string;
  project_id: string;
  resource_type: ResourceType;
  resource_id: string;
}

interface SegmentCandidate {
  id: string;
  project_id: string;
  logical_bytes: number;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function retentionMillis(env: Env): number {
  return positiveInt(env.RAW_MEMORY_RETENTION_DAYS, DEFAULT_RETENTION_DAYS) * 24 * 60 * 60 * 1000;
}

function maxBytes(env: Env): number {
  return positiveInt(env.RAW_MEMORY_MAX_BYTES_PER_PROJECT, DEFAULT_MAX_BYTES_PER_PROJECT);
}

function targetBytes(env: Env): number {
  return Math.min(
    positiveInt(env.RAW_MEMORY_TARGET_BYTES_PER_PROJECT, DEFAULT_TARGET_BYTES_PER_PROJECT),
    maxBytes(env),
  );
}

function deletionJobId(): string {
  return `delete_${crypto.randomUUID()}`;
}

function segmentEligibilitySql(): string {
  return `
    NOT EXISTS (
      SELECT 1
      FROM memory_evidence AS evidence
      JOIN memory_claims AS claim
        ON claim.id = evidence.claim_id AND claim.project_id = evidence.project_id
      WHERE evidence.project_id = memory_segments.project_id
        AND evidence.segment_id = memory_segments.id
        AND claim.status = 'active'
        AND (claim.valid_from IS NULL OR claim.valid_from <= CAST(strftime('%s', 'now') AS INTEGER) * 1000)
        AND (claim.valid_until IS NULL OR claim.valid_until > CAST(strftime('%s', 'now') AS INTEGER) * 1000)
    )
  `;
}

async function queueDeletionJobs(
  db: D1Database,
  candidates: Array<{ projectId: string; resourceType: ResourceType; resourceId: string }>,
  reason: DeletionReason,
  now: number,
): Promise<number> {
  if (candidates.length === 0) return 0;
  const statements: D1PreparedStatement[] = [];
  for (const candidate of candidates) {
    if (candidate.resourceType === "segment") {
      statements.push(
        db
          .prepare("UPDATE memory_segments SET deletion_state = 'pending_delete', updated_at = ? WHERE project_id = ? AND id = ? AND deletion_state = 'active'")
          .bind(now, candidate.projectId, candidate.resourceId),
      );
    } else {
      statements.push(
        db
          .prepare("UPDATE memory_claims SET status = 'retracted', valid_until = COALESCE(valid_until, ?), updated_at = ? WHERE project_id = ? AND id = ?")
          .bind(now, now, candidate.projectId, candidate.resourceId),
      );
    }
    statements.push(
      db
        .prepare(
          "INSERT OR IGNORE INTO memory_deletion_jobs (id, project_id, resource_type, resource_id, reason, status, attempt_count, last_error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', 0, NULL, ?, ?)",
        )
        .bind(deletionJobId(), candidate.projectId, candidate.resourceType, candidate.resourceId, reason, now, now),
    );
  }
  for (const batch of chunkArray(statements, 50)) await db.batch(batch);
  return candidates.length;
}

async function queueExpiredSegments(env: Env, now: number): Promise<number> {
  const result = await env.DB
    .prepare(
      `SELECT id, project_id
       FROM memory_segments
       WHERE deletion_state = 'active'
         AND expires_at IS NOT NULL
         AND expires_at <= ?
         AND ${segmentEligibilitySql()}
       ORDER BY expires_at ASC
       LIMIT ?`,
    )
    .bind(now, DELETE_BATCH_SIZE)
    .all<{ id: string; project_id: string }>();
  return await queueDeletionJobs(
    env.DB,
    result.results.map((row) => ({ projectId: row.project_id, resourceType: "segment", resourceId: row.id })),
    "expired",
    now,
  );
}

async function queueQuotaSegments(env: Env, projectId: string, now: number): Promise<number> {
  const sizeResult = await env.DB
    .prepare(
      "SELECT COALESCE(SUM(LENGTH(CAST(id AS BLOB)) + LENGTH(CAST(text AS BLOB)) + LENGTH(CAST(content_hash AS BLOB)) + LENGTH(CAST(metadata_json AS BLOB))), 0) AS logical_bytes FROM memory_segments WHERE project_id = ? AND deletion_state = 'active'",
    )
    .bind(projectId)
    .first<{ logical_bytes: number }>();
  let logicalBytes = Number(sizeResult?.logical_bytes ?? 0);
  if (logicalBytes <= maxBytes(env)) return 0;

  const candidates = await env.DB
    .prepare(
      `SELECT id, project_id, LENGTH(CAST(id AS BLOB)) + LENGTH(CAST(text AS BLOB)) + LENGTH(CAST(content_hash AS BLOB)) + LENGTH(CAST(metadata_json AS BLOB)) AS logical_bytes
       FROM memory_segments
       WHERE project_id = ?
         AND deletion_state = 'active'
         AND ${segmentEligibilitySql()}
       ORDER BY created_at ASC
       LIMIT ?`,
    )
    .bind(projectId, DELETE_BATCH_SIZE)
    .all<SegmentCandidate>();
  const selected: SegmentCandidate[] = [];
  for (const candidate of candidates.results) {
    if (logicalBytes <= targetBytes(env)) break;
    selected.push(candidate);
    logicalBytes -= Number(candidate.logical_bytes ?? 0);
  }
  return await queueDeletionJobs(
    env.DB,
    selected.map((row) => ({ projectId: row.project_id, resourceType: "segment", resourceId: row.id })),
    "quota",
    now,
  );
}

async function failDeletionJobs(db: D1Database, jobIds: string[], error: unknown, now: number): Promise<void> {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
  for (const batch of chunkArray(jobIds, DELETE_BATCH_SIZE)) {
    const placeholders = batch.map(() => "?").join(",");
    await db
      .prepare(`UPDATE memory_deletion_jobs SET status = 'failed', attempt_count = attempt_count + 1, last_error = ?, updated_at = ? WHERE id IN (${placeholders})`)
      .bind(message, now, ...batch)
      .run();
  }
}

function restoreVectorMetadata(metadataJson: unknown): Record<string, Primitive> | undefined {
  if (typeof metadataJson !== "string") return undefined;
  try {
    const metadata = JSON.parse(metadataJson) as Record<string, unknown>;
    const projected: Record<string, Primitive> = {};
    for (const key of ["project_id", "session_id", "tape", "kind", "chat_id", "user_id"]) {
      const value = metadata[key];
      if (typeof value === "string" && value) projected[key] = value;
      if (typeof value === "number" && Number.isFinite(value)) projected[key] = value;
      if (typeof value === "boolean") projected[key] = value;
    }
    return Object.keys(projected).length > 0 ? projected : undefined;
  } catch {
    return undefined;
  }
}

async function restoreActiveSegmentVector(env: Env, projectId: string, resourceId: string): Promise<void> {
  const row = await env.DB.prepare(
    "SELECT text, metadata_json FROM memory_segments WHERE project_id = ? AND id = ? AND deletion_state = 'active'",
  ).bind(projectId, resourceId).first<{ text: string; metadata_json: string }>();
  if (!row || typeof row.text !== "string" || !row.text) return;
  const [vector] = await embedTexts(env, [row.text]);
  if (!vector) throw new Error("Missing embedding vector while restoring a reindexed segment");
  await env.SEGMENTS_INDEX.upsert([{
    id: resourceId,
    namespace: `project:${projectId}`,
    values: vector,
    metadata: restoreVectorMetadata(row.metadata_json),
  }]);
}

async function completeSegmentDeletion(env: Env, job: DeletionJob): Promise<void> {
  if (!env.SEGMENTS_INDEX.deleteByIds) throw new Error("SEGMENTS_INDEX deletion is unavailable");
  await env.SEGMENTS_INDEX.deleteByIds([job.resource_id]);
  const deleted = await env.DB.prepare(
    "DELETE FROM memory_segments WHERE project_id = ? AND id = ? AND deletion_state = 'pending_delete'",
  ).bind(job.project_id, job.resource_id).run();
  if (!deleted.meta.changes) {
    await restoreActiveSegmentVector(env, job.project_id, job.resource_id);
    await env.DB.prepare("DELETE FROM memory_deletion_jobs WHERE id = ?").bind(job.id).run();
    return;
  }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM memory_evidence WHERE project_id = ? AND segment_id = ?").bind(job.project_id, job.resource_id),
    env.DB.prepare("DELETE FROM memory_deletion_jobs WHERE id = ?").bind(job.id),
  ]);
}

async function completeDeletionJobs(env: Env, jobs: DeletionJob[]): Promise<void> {
  if (jobs.length === 0) return;
  const resourceType = jobs[0].resource_type;
  const projectId = jobs[0].project_id;

  if (resourceType === "segment") {
    for (const job of jobs) await completeSegmentDeletion(env, job);
    return;
  } else {
    if (env.CLAIMS_INDEX?.deleteByIds) {
      await env.CLAIMS_INDEX.deleteByIds(jobs.map((job) => job.resource_id));
    }
  }

  const statements: D1PreparedStatement[] = [];
  for (const job of jobs) {
    statements.push(
      env.DB.prepare("DELETE FROM memory_evidence WHERE project_id = ? AND claim_id = ?").bind(projectId, job.resource_id),
      env.DB.prepare("DELETE FROM memory_claims WHERE project_id = ? AND id = ?").bind(projectId, job.resource_id),
    );
    statements.push(env.DB.prepare("DELETE FROM memory_deletion_jobs WHERE id = ?").bind(job.id));
  }
  for (const batch of chunkArray(statements, 50)) await env.DB.batch(batch);
}

export async function processDeletionJobs(env: Env, options: { projectId?: string; limit?: number } = {}): Promise<{ deleted: number; failed: number }> {
  const limit = Math.min(Math.max(options.limit ?? DELETE_BATCH_SIZE, 1), 500);
  const where = options.projectId ? "AND project_id = ?" : "";
  const result = await env.DB
    .prepare(
      `SELECT id, project_id, resource_type, resource_id
       FROM memory_deletion_jobs
       WHERE status IN ('pending', 'failed') ${where}
       ORDER BY CASE resource_type WHEN 'claim' THEN 0 ELSE 1 END, created_at ASC
       LIMIT ?`,
    )
    .bind(...(options.projectId ? [options.projectId, limit] : [limit]))
    .all<DeletionJob>();
  const jobs = result.results;
  let deleted = 0;
  let failed = 0;
  const now = Date.now();
  const groups = new Map<string, DeletionJob[]>();
  for (const job of jobs) {
    const key = `${job.project_id}:${job.resource_type}`;
    const group = groups.get(key) ?? [];
    group.push(job);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    try {
      for (const batch of chunkArray(group, DELETE_BATCH_SIZE)) {
        await completeDeletionJobs(env, batch);
        deleted += batch.length;
      }
    } catch (error) {
      failed += group.length;
      console.error(`[retention] failed to delete ${group.length} ${group[0].resource_type}(s) in project ${group[0].project_id}: ${error instanceof Error ? error.message : String(error)}`);
      await failDeletionJobs(env.DB, group.map((job) => job.id), error, now);
    }
  }
  return { deleted, failed };
}

export async function scheduleProjectRetention(env: Env, projectId: string): Promise<number> {
  return await queueQuotaSegments(env, projectId, Date.now());
}

export async function runRetentionSweep(env: Env): Promise<{ queued: number; deleted: number; failed: number }> {
  const now = Date.now();
  const expired = await queueExpiredSegments(env, now);
  const projects = await env.DB.prepare("SELECT DISTINCT project_id FROM memory_segments WHERE deletion_state = 'active'").all<{ project_id: string }>();
  let quota = 0;
  for (const project of projects.results) quota += await queueQuotaSegments(env, project.project_id, now);
  const processed = await processDeletionJobs(env);
  return { queued: expired + quota, ...processed };
}

export async function forgetScopedMemory(
  env: Env,
  projectScope: ProjectScope,
  options: { scopeKind: "user" | "session"; scopeId: string },
): Promise<{ queued: number; deleted: number; failed: number }> {
  const now = Date.now();
  const claims = await env.DB
    .prepare("SELECT id FROM memory_claims WHERE project_id = ? AND scope_kind = ? AND scope_id = ?")
    .bind(projectScope.projectId, options.scopeKind, options.scopeId)
    .all<{ id: string }>();
  const segmentSql = options.scopeKind === "session"
    ? "SELECT id FROM memory_segments WHERE project_id = ? AND session_id = ? AND deletion_state = 'active'"
    // The CAST is load-bearing: json_extract returns the native JSON type, and
    // SQLite compares INTEGER 123 to TEXT '123' as unequal, so a numeric
    // metadata user_id would silently survive a forget request without it.
    // idx_memory_segments_metadata_user_id indexes the same CAST expression.
    : "SELECT id FROM memory_segments WHERE project_id = ? AND CAST(json_extract(metadata_json, '$.user_id') AS TEXT) = ? AND deletion_state = 'active'";
  const segments = await env.DB.prepare(segmentSql).bind(projectScope.projectId, options.scopeId).all<{ id: string }>();
  const queued = await queueDeletionJobs(
    env.DB,
    [
      ...claims.results.map((row) => ({ projectId: projectScope.projectId, resourceType: "claim" as const, resourceId: row.id })),
      ...segments.results.map((row) => ({ projectId: projectScope.projectId, resourceType: "segment" as const, resourceId: row.id })),
    ],
    "user_forget",
    now,
  );
  const processed = await processDeletionJobs(env, { projectId: projectScope.projectId, limit: 500 });
  return { queued, ...processed };
}

export function rawMemoryExpiresAt(env: Env, now: number): number {
  return now + retentionMillis(env);
}
