import { embedTexts } from "../ai/embedding";
import { fetchByIds } from "../db/d1";
import type { Env, Primitive } from "../env";
import type { PreparedIndexItem } from "./schema";

const DEFAULT_LIMIT = 100;
const LEASE_MS = 60_000;
const MAX_RETRY_MS = 60 * 60 * 1000;
const MAX_ORPHAN_CLEANUP_IDS = 100;

interface SegmentVectorJob {
  project_id: string;
  segment_id: string;
  revision: number;
  operation: "upsert" | "delete";
  segment_updated_at: number;
  status: "pending" | "processing" | "failed";
  attempt_count: number;
  next_attempt_at: number;
  lease_token: string | null;
  lease_expires_at: number | null;
  updated_at: number;
}

function retryDelay(attemptCount: number): number {
  return Math.min(MAX_RETRY_MS, 1000 * 2 ** Math.min(Math.max(attemptCount - 1, 0), 10));
}

function errorLabel(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1000);
}

function vectorMetadata(projectId: string, row: Record<string, unknown>): Record<string, Primitive> {
  let metadata: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(typeof row.metadata_json === "string" ? row.metadata_json : "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) metadata = parsed;
  } catch {}
  const projected: Record<string, Primitive> = { project_id: projectId };
  const source: Record<string, unknown> = { ...metadata, session_id: row.session_id, tape: row.tape };
  for (const key of ["session_id", "tape", "kind", "chat_id", "user_id", "category", "workspace_id"]) {
    const value = source[key];
    if (typeof value === "string" && value) projected[key] = value;
    if (typeof value === "number" && Number.isFinite(value)) projected[key] = value;
    if (typeof value === "boolean") projected[key] = value;
  }
  return projected;
}

export async function completeSegmentVectorJobs(
  db: Env["DB"],
  items: PreparedIndexItem[],
  updatedAt: number,
): Promise<Map<string, boolean>> {
  const completed = new Map<string, boolean>();
  if (items.length === 0) return completed;
  const results = await db.batch(items.map((item) => db.prepare(
    "DELETE FROM memory_segment_vector_jobs WHERE project_id = ? AND segment_id = ? AND segment_updated_at = ? AND operation_token = ? AND status = 'pending'",
  ).bind(item.projectId, item.id, updatedAt, item.vectorOperationToken ?? null)));
  results.forEach((result, index) => completed.set(items[index].id, result.meta.changes === 1));
  return completed;
}

export async function ensureLatestSegmentVectorJobs(env: Env, items: PreparedIndexItem[]): Promise<void> {
  for (const item of items) {
    const row = await env.DB.prepare("SELECT project_id, updated_at, deletion_state FROM memory_segments WHERE id = ?")
      .bind(item.id).first<{ project_id: string; updated_at: number; deletion_state: string }>();
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO memory_segment_vector_jobs (
        project_id, segment_id, revision, operation, segment_updated_at, status,
        attempt_count, last_error, next_attempt_at, lease_token, lease_expires_at,
        operation_token, created_at, updated_at
      ) VALUES (?, ?, 1, ?, ?, 'pending', 0, NULL, ?, NULL, NULL, NULL, ?, ?)
      ON CONFLICT (project_id, segment_id) DO UPDATE SET
        revision = memory_segment_vector_jobs.revision + 1,
        operation = excluded.operation,
        segment_updated_at = excluded.segment_updated_at,
        status = CASE WHEN memory_segment_vector_jobs.status = 'processing' THEN 'processing' ELSE 'pending' END,
        last_error = NULL,
        next_attempt_at = excluded.next_attempt_at,
        operation_token = NULL,
        updated_at = excluded.updated_at`,
    ).bind(row?.project_id ?? item.projectId, item.id, row?.deletion_state === "active" ? "upsert" : "delete", row?.updated_at ?? now, now, now, now).run();
  }
}

async function listReadyJobs(env: Env, now: number, limit: number): Promise<SegmentVectorJob[]> {
  const result = await env.DB.prepare(
    `SELECT project_id, segment_id, revision, operation, segment_updated_at, status,
            attempt_count, next_attempt_at, lease_token, lease_expires_at, updated_at
     FROM memory_segment_vector_jobs
     WHERE (status IN ('pending', 'failed') AND next_attempt_at <= ?)
        OR (status = 'processing' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
     ORDER BY updated_at ASC LIMIT ?`,
  ).bind(now, now, limit).all<SegmentVectorJob>();
  return result.results;
}

async function leaseJob(env: Env, candidate: SegmentVectorJob, now: number): Promise<SegmentVectorJob | null> {
  const leaseToken = crypto.randomUUID();
  const result = await env.DB.prepare(
    `UPDATE memory_segment_vector_jobs
     SET status = 'processing', lease_token = ?, lease_expires_at = ?, updated_at = ?
     WHERE project_id = ? AND segment_id = ? AND (
       (status IN ('pending', 'failed') AND next_attempt_at <= ?)
       OR (status = 'processing' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
     )`,
  ).bind(leaseToken, now + LEASE_MS, now, candidate.project_id, candidate.segment_id, now, now).run();
  if (result.meta.changes === 0) return null;
  return await env.DB.prepare(
    `SELECT project_id, segment_id, revision, operation, segment_updated_at, status,
            attempt_count, next_attempt_at, lease_token, lease_expires_at, updated_at
     FROM memory_segment_vector_jobs WHERE project_id = ? AND segment_id = ? AND lease_token = ?`,
  ).bind(candidate.project_id, candidate.segment_id, leaseToken).first<SegmentVectorJob>();
}

async function releaseSuperseded(env: Env, job: SegmentVectorJob): Promise<void> {
  await env.DB.prepare(
    `UPDATE memory_segment_vector_jobs
     SET status = 'pending', lease_token = NULL, lease_expires_at = NULL, next_attempt_at = ?, updated_at = ?
     WHERE project_id = ? AND segment_id = ? AND status = 'processing' AND lease_token = ? AND revision != ?`,
  ).bind(Date.now(), Date.now(), job.project_id, job.segment_id, job.lease_token, job.revision).run();
}

async function reconcileJob(env: Env, job: SegmentVectorJob): Promise<void> {
  const rows = await fetchByIds(env.DB, job.project_id, [job.segment_id]);
  const row = rows.get(job.segment_id);
  if (job.operation === "upsert" && row && row.updated_at === job.segment_updated_at) {
    const vectors = await embedTexts(env, [String(row.text)]);
    await env.SEGMENTS_INDEX.upsert([{
      id: job.segment_id,
      namespace: `project:${job.project_id}`,
      values: vectors[0],
      metadata: vectorMetadata(job.project_id, row),
    }]);
  } else if (job.operation === "delete" || !row) {
    if (!env.SEGMENTS_INDEX.deleteByIds) throw new Error("SEGMENTS_INDEX deletion is unavailable");
    await env.SEGMENTS_INDEX.deleteByIds([job.segment_id]);
  } else {
    await releaseSuperseded(env, job);
    return;
  }

  const completed = await env.DB.prepare(
    `DELETE FROM memory_segment_vector_jobs
     WHERE project_id = ? AND segment_id = ? AND status = 'processing' AND lease_token = ? AND revision = ?`,
  ).bind(job.project_id, job.segment_id, job.lease_token, job.revision).run();
  if (completed.meta.changes === 0) {
    if (!env.SEGMENTS_INDEX.deleteByIds) throw new Error("SEGMENTS_INDEX deletion is unavailable");
    await env.SEGMENTS_INDEX.deleteByIds([job.segment_id]);
    await ensureLatestSegmentVectorJobs(env, [{
      item: { id: job.segment_id, text: "" }, id: job.segment_id, text: "", contentHash: "",
      metadataJson: "{}", projectId: job.project_id, namespace: `project:${job.project_id}`, sessionId: null, tape: null,
    }]);
    await releaseSuperseded(env, job);
  }
}

async function recordFailure(env: Env, job: SegmentVectorJob, error: unknown): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `UPDATE memory_segment_vector_jobs
     SET status = CASE WHEN revision = ? THEN 'failed' ELSE 'pending' END,
         attempt_count = CASE WHEN revision = ? THEN attempt_count + 1 ELSE attempt_count END,
         last_error = CASE WHEN revision = ? THEN ? ELSE last_error END,
         next_attempt_at = CASE WHEN revision = ? THEN ? ELSE next_attempt_at END,
         lease_token = NULL, lease_expires_at = NULL, updated_at = ?
     WHERE project_id = ? AND segment_id = ? AND status = 'processing' AND lease_token = ?`,
  ).bind(job.revision, job.revision, job.revision, errorLabel(error), job.revision, now + retryDelay(job.attempt_count + 1), now, job.project_id, job.segment_id, job.lease_token).run();
}

export async function runSegmentVectorReconciliation(env: Env, limit = DEFAULT_LIMIT): Promise<void> {
  const now = Date.now();
  const jobs = await listReadyJobs(env, now, Math.min(Math.max(limit, 1), DEFAULT_LIMIT));
  for (const candidate of jobs) {
    const job = await leaseJob(env, candidate, Date.now());
    if (!job) continue;
    try {
      await reconcileJob(env, job);
    } catch (error) {
      await recordFailure(env, job, error);
    }
  }
}

export async function cleanupOrphanSegmentVectors(
  env: Env,
  rawIds: unknown,
  apply: boolean,
): Promise<{ checked: number; orphans: string[]; deleted: number; dry_run: boolean }> {
  if (!Array.isArray(rawIds)) throw new Error("ids must be an array");
  const ids = [...new Set(rawIds.filter((value): value is string => typeof value === "string" && value.length > 0))];
  if (ids.length === 0 || ids.length > MAX_ORPHAN_CLEANUP_IDS) throw new Error("ids must contain 1 to 100 values");
  const placeholders = ids.map(() => "?").join(",");
  const active = await env.DB.prepare(
    `SELECT id FROM memory_segments WHERE id IN (${placeholders}) AND deletion_state = 'active'`,
  ).bind(...ids).all<{ id: string }>();
  const activeIds = new Set(active.results.map((row) => row.id));
  const orphans = ids.filter((id) => !activeIds.has(id));
  if (apply && orphans.length > 0) {
    if (!env.SEGMENTS_INDEX.deleteByIds) throw new Error("SEGMENTS_INDEX deletion is unavailable");
    await env.SEGMENTS_INDEX.deleteByIds(orphans);
  }
  return { checked: ids.length, orphans, deleted: apply ? orphans.length : 0, dry_run: !apply };
}
