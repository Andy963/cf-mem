import { fetchClaimById } from "../db/d1";
import type { Env } from "../env";
import { deleteClaimVector, syncClaimVector } from "./claim-index";

const JOB_LEASE_MS = 60_000;
const DEFAULT_JOB_LIMIT = 100;
const MAX_RETRY_DELAY_MS = 60 * 60 * 1000;

interface ClaimVectorJob {
  project_id: string;
  claim_id: string;
  revision: number;
  operation: "upsert" | "delete";
  claim_updated_at: number;
  status: "pending" | "processing" | "failed";
  attempt_count: number;
  last_error: string | null;
  next_attempt_at: number;
  lease_token: string | null;
  lease_expires_at: number | null;
  created_at: number;
  updated_at: number;
}

function errorLabel(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1000);
}

function retryDelayMs(attemptCount: number): number {
  const exponent = Math.min(Math.max(attemptCount - 1, 0), 10);
  return Math.min(MAX_RETRY_DELAY_MS, 1_000 * 2 ** exponent);
}

async function listReadyJobs(env: Env, now: number, limit: number): Promise<ClaimVectorJob[]> {
  const result = await env.DB.prepare(
    `SELECT project_id, claim_id, revision, operation, claim_updated_at, status,
            attempt_count, last_error, next_attempt_at, lease_token,
            lease_expires_at, created_at, updated_at
     FROM memory_claim_vector_jobs
     WHERE (status IN ('pending', 'failed') AND next_attempt_at <= ?)
        OR (status = 'processing' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
     ORDER BY updated_at ASC
     LIMIT ?`,
  ).bind(now, now, limit).all<ClaimVectorJob>();
  return result.results;
}

async function leaseJob(env: Env, candidate: ClaimVectorJob, now: number): Promise<ClaimVectorJob | null> {
  const leaseToken = crypto.randomUUID();
  const result = await env.DB.prepare(
    `UPDATE memory_claim_vector_jobs
     SET status = 'processing', lease_token = ?, lease_expires_at = ?, updated_at = ?
     WHERE project_id = ? AND claim_id = ? AND (
       (status IN ('pending', 'failed') AND next_attempt_at <= ?)
       OR (status = 'processing' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
     )`,
  ).bind(
    leaseToken,
    now + JOB_LEASE_MS,
    now,
    candidate.project_id,
    candidate.claim_id,
    now,
    now,
  ).run();
  if (!result.meta.changes) return null;

  return await env.DB.prepare(
    `SELECT project_id, claim_id, revision, operation, claim_updated_at, status,
            attempt_count, last_error, next_attempt_at, lease_token,
            lease_expires_at, created_at, updated_at
     FROM memory_claim_vector_jobs
     WHERE project_id = ? AND claim_id = ? AND lease_token = ?`,
  ).bind(candidate.project_id, candidate.claim_id, leaseToken).first<ClaimVectorJob>();
}

async function releaseSupersededLease(env: Env, job: ClaimVectorJob, revision: number, now: number): Promise<void> {
  await env.DB.prepare(
    `UPDATE memory_claim_vector_jobs
     SET status = 'pending', lease_token = NULL, lease_expires_at = NULL,
         next_attempt_at = ?, updated_at = ?
     WHERE project_id = ? AND claim_id = ? AND status = 'processing'
       AND lease_token = ? AND revision != ?`,
  ).bind(now, now, job.project_id, job.claim_id, job.lease_token, revision).run();
}

async function reconcileJob(env: Env, job: ClaimVectorJob): Promise<void> {
  const revision = job.revision;
  const claim = await fetchClaimById(env.DB, job.project_id, job.claim_id);
  if (claim) {
    await syncClaimVector(env, claim);
  } else {
    await deleteClaimVector(env, job.project_id, job.claim_id);
  }

  const now = Date.now();
  const completed = await env.DB.prepare(
    `DELETE FROM memory_claim_vector_jobs
     WHERE project_id = ? AND claim_id = ? AND status = 'processing'
       AND lease_token = ? AND revision = ?`,
  ).bind(job.project_id, job.claim_id, job.lease_token, revision).run();
  if (!completed.meta.changes) await releaseSupersededLease(env, job, revision, now);
}

async function recordFailure(env: Env, job: ClaimVectorJob, error: unknown): Promise<void> {
  const revision = job.revision;
  const now = Date.now();
  const message = errorLabel(error);
  const nextAttemptAt = now + retryDelayMs(job.attempt_count + 1);
  try {
    await env.DB.prepare(
      `UPDATE memory_claim_vector_jobs
       SET status = CASE WHEN revision = ? THEN 'failed' ELSE 'pending' END,
           attempt_count = CASE WHEN revision = ? THEN attempt_count + 1 ELSE attempt_count END,
           last_error = CASE WHEN revision = ? THEN ? ELSE last_error END,
           next_attempt_at = CASE WHEN revision = ? THEN ? ELSE next_attempt_at END,
           lease_token = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE project_id = ? AND claim_id = ? AND status = 'processing' AND lease_token = ?`,
    ).bind(
      revision,
      revision,
      revision,
      message,
      revision,
      nextAttemptAt,
      now,
      job.project_id,
      job.claim_id,
      job.lease_token,
    ).run();
  } catch (recordError) {
    console.error(`[claim-reconcile] failed to record ${job.project_id}/${job.claim_id}: ${errorLabel(recordError)}`);
  }
}

export async function runClaimVectorReconciliation(
  env: Env,
  requestedLimit: number = DEFAULT_JOB_LIMIT,
): Promise<{ processed: number; repaired: number; failed: number }> {
  const limit = Math.min(Math.max(Math.trunc(requestedLimit), 1), DEFAULT_JOB_LIMIT);
  const candidates = await listReadyJobs(env, Date.now(), limit);
  let repaired = 0;
  let failed = 0;

  for (const candidate of candidates) {
    const job = await leaseJob(env, candidate, Date.now());
    if (!job) continue;
    try {
      await reconcileJob(env, job);
      repaired += 1;
    } catch (error) {
      failed += 1;
      console.error(`[claim-reconcile] ${job.project_id}/${job.claim_id} attempt=${job.attempt_count + 1} failed: ${errorLabel(error)}`);
      await recordFailure(env, job, error);
    }
  }

  return { processed: repaired + failed, repaired, failed };
}
