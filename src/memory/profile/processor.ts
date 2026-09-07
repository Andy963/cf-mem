import { fetchByIds } from "../../db/d1";
import type { Env } from "../../env";
import type { ProjectScope } from "../../project";
import { chunkArray } from "../../utils";
import { ClaimDedupLockBusyError } from "../claim-dedup";
import { getBreakerOpenUntilAt, isBreakerOpenError } from "../llm-breaker";
import { markSegmentExtractionFailed } from "../nudge";
import { buildWebReferenceSegments } from "../web-reference";
import {
  callExtractor,
  callReconciliation,
  verifyCandidates,
} from "./client";
import {
  assistantOnlyEvidenceIds,
  boundedEvidenceText,
  extractWorkspaceNameFromEvidence,
  hasConversationEvidence,
  jobEvidenceIds,
  userOriginatedText,
  webReferenceIdsIn,
} from "./evidence";
import { applyExtractedClaims } from "./mutations";
import {
  candidateAccepted,
  reconcileAcceptedCandidates,
  recordCandidateVerdicts,
} from "./reconciler";
import {
  completeJob,
  createExtractionJob,
  deferJobAfterBreakerOpen,
  failJob,
  leaseJob,
  markSegmentsExtracted,
  nextReadyJobIds,
} from "./queue";
import {
  DEFAULT_BATCH_IDLE_MS,
  DEFAULT_BATCH_MAX_CHARS,
  INBOX_DELETE_CHUNK_SIZE,
  MAX_ATTEMPTS,
  MAX_EVIDENCE_CHARS,
  MAX_EVIDENCE_SEGMENTS,
  MAX_FLUSH_BATCHES_PER_GROUP,
  MAX_WEB_REFERENCE_SEGMENTS_PER_JOB,
  errorLabel,
  fetchOwnerClaims,
  retryDelayMs,
  type InboxRow,
  type JobStatus,
} from "./shared";

export async function processProfileJob(env: Env, id: string): Promise<void> {
  const job = await leaseJob(env, id, Date.now());
  if (!job) return;
  try {
    const scope: ProjectScope = { projectId: job.project_id, namespace: `project:${job.project_id}` };
    const evidenceIds = jobEvidenceIds(job);
    const evidence = await fetchByIds(env.DB, job.project_id, evidenceIds);
    if (evidence.size === 0) {
      await completeJob(env, job, "evidence_pruned");
      return;
    }
    const survivingEvidenceIds = evidenceIds.filter((eid) => evidence.has(eid));
    const webReferenceIds = webReferenceIdsIn(evidence, survivingEvidenceIds);
    const evidenceText = boundedEvidenceText(evidence, survivingEvidenceIds);
    if (!evidenceText) {
      await completeJob(env, job, "evidence_empty");
      return;
    }
    if (!hasConversationEvidence(evidence, survivingEvidenceIds)) {
      await completeJob(env, job, "conversation_evidence_empty");
      return;
    }
    const workspaceName = extractWorkspaceNameFromEvidence(evidence);
    const activeClaims = await fetchOwnerClaims(env, job.project_id, job.owner_id, job.workspace_id);
    const candidates = await callExtractor(env, evidenceText, activeClaims, job.workspace_id, workspaceName);
    const verdicts = await verifyCandidates(env, candidates, evidenceText);
    const assistantOnlyIds = assistantOnlyEvidenceIds(evidence, survivingEvidenceIds);
    const survivingIdSet = new Set(survivingEvidenceIds);
    await recordCandidateVerdicts(env, job, candidates, verdicts, activeClaims, webReferenceIds, assistantOnlyIds, survivingIdSet);
    const verdictByIndex = new Map(verdicts.map((verdict) => [verdict.candidate_index, verdict]));
    const accepted = candidates.filter((candidate, index) => candidateAccepted(candidate, index, verdictByIndex, job, activeClaims, webReferenceIds, assistantOnlyIds, survivingIdSet));
    const hasActiveClaims = activeClaims.some((claim) => claim.status === "active");
    const decisions = hasActiveClaims
      ? await callReconciliation(env, accepted, activeClaims, job.workspace_id)
      : accepted.map((_, candidate_index) => ({
        candidate_index,
        action: "keep" as const,
        reason: "no_active_claims",
      }));
    const reconciled = reconcileAcceptedCandidates(accepted, decisions, activeClaims);
    const { applied, failures } = await applyExtractedClaims(env, scope, job, reconciled, activeClaims, survivingIdSet);
    // Per-candidate failures are model-output problems: retrying re-runs the
    // same prompt and hits the same bad candidate, so the job is completed with
    // the failures recorded rather than retried into 'dead'.
    const note = failures.length > 0 ? `applied_${applied}_failed:${failures.join("; ")}`.slice(0, 500) : null;
    try {
      await completeJob(env, job, note);
    } catch (completionError) {
      console.error(`[profile] job=${job.id} claims applied but completion failed: ${errorLabel(completionError)}`);
      // Claims were applied; don't let a D1 hiccup strand the job in 'processing'.
      await env.DB.prepare(
        "UPDATE profile_extraction_jobs SET status = 'completed', lease_token = NULL, lease_expires_at = NULL, last_error = ?, updated_at = ? WHERE id = ?",
      ).bind(note, Date.now(), job.id).run();
    }
  } catch (error) {
    if (isBreakerOpenError(error)) {
      console.warn(`[profile] job=${job.id} postponed: circuit breaker open until ${error.openUntilAt}`);
      try {
        await deferJobAfterBreakerOpen(env, job, error);
      } catch {
        // Last-resort cleanup without the lease guard; do not count this as a
        // failed extraction because the provider was not called.
        await env.DB.prepare(
          "UPDATE profile_extraction_jobs SET status = 'pending', attempt_count = CASE WHEN attempt_count > 0 THEN attempt_count - 1 ELSE 0 END, lease_token = NULL, lease_expires_at = NULL, last_error = ?, next_attempt_at = ?, updated_at = ? WHERE id = ?",
        ).bind(errorLabel(error), error.openUntilAt, Date.now(), job.id).run().catch(() => {});
      }
      return;
    }
    const isLockBusy = error instanceof ClaimDedupLockBusyError;
    if (isLockBusy) {
      console.warn(`[profile] job=${job.id} postponed: claim dedup lock is busy`);
    } else {
      console.error(`[profile] job=${job.id} attempt=${job.attempt_count} failed: ${errorLabel(error)}`);
    }
    // Nudge-enqueued evidence must not retry forever: bump each segment's
    // failure counter so the scan drops them after MAX_FAILED_ATTEMPTS.
    if (!isLockBusy) {
      const evidenceIds = jobEvidenceIds(job);
      for (const segmentId of evidenceIds) {
        await markSegmentExtractionFailed(env, job.project_id, segmentId).catch(() => {});
      }
    }
    try {
      await failJob(env, job, error);
    } catch {
      // Last-resort: clear lease and set status without the lease_token guard
      // so a transient D1 error cannot permanently strand the job.
      const status: JobStatus = job.attempt_count >= MAX_ATTEMPTS ? "dead" : "failed";
      await env.DB.prepare(
        "UPDATE profile_extraction_jobs SET status = ?, lease_token = NULL, lease_expires_at = NULL, next_attempt_at = ?, updated_at = ? WHERE id = ?",
      ).bind(status, Date.now() + retryDelayMs(job.attempt_count), Date.now(), job.id).run();
    }
  }
}

function batchLimits(env: Env): { maxChars: number; maxSegments: number; idleMs: number } {
  const maxChars = positiveIntEnv(env.PROFILE_BATCH_MAX_CHARS, DEFAULT_BATCH_MAX_CHARS);
  return {
    // A batch must still fit MAX_EVIDENCE_CHARS or boundedEvidenceText would
    // silently drop its tail.
    maxChars: Math.min(maxChars, MAX_EVIDENCE_CHARS),
    maxSegments: Math.min(positiveIntEnv(env.PROFILE_BATCH_MAX_SEGMENTS, MAX_EVIDENCE_SEGMENTS), MAX_EVIDENCE_SEGMENTS),
    idleMs: positiveIntEnv(env.PROFILE_BATCH_IDLE_MS, DEFAULT_BATCH_IDLE_MS),
  };
}

function positiveIntEnv(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Takes the longest prefix that fits both limits. The first row is always taken
 * so an oversized single entry can never wedge the queue. Look-ahead (rather
 * than "add then check") keeps every batch under maxChars instead of
 * overshooting by up to one full message.
 */
function takeBatch(rows: InboxRow[], maxChars: number, maxSegments: number): InboxRow[] {
  const batch: InboxRow[] = [];
  let chars = 0;
  for (const row of rows) {
    if (batch.length >= maxSegments) break;
    if (batch.length > 0 && chars + row.char_count > maxChars) break;
    batch.push(row);
    chars += row.char_count;
  }
  return batch;
}

/**
 * Fetches the links mentioned in a batch, once per batch rather than once per
 * message, and returns the resulting reference segment ids. Runs at flush time
 * (not ingest) so client latency is untouched and a job retry never refetches.
 */
async function collectWebReferences(
  env: Env,
  projectId: string,
  batch: InboxRow[],
): Promise<string[]> {
  const head = batch[0];
  const scope: ProjectScope = { projectId, namespace: `project:${projectId}` };
  try {
    const rows = await fetchByIds(env.DB, projectId, batch.map((row) => row.id));
    const texts = batch
      .map((row) => rows.get(row.id) as { text?: unknown } | undefined)
      .map((row) => (typeof row?.text === "string" ? userOriginatedText(row.text) : ""))
      .filter(Boolean);
    if (texts.length === 0) return [];
    const ids = await buildWebReferenceSegments(env, scope, texts, {
      sourceApp: head.source_app,
      externalSessionId: head.external_session_id,
      ownerId: head.owner_id,
      workspaceId: head.workspace_id,
    });
    return ids.slice(0, MAX_WEB_REFERENCE_SEGMENTS_PER_JOB);
  } catch (error) {
    // A dead link or an indexing hiccup must not hold up extraction of the
    // conversation the links were mentioned in.
    console.error(`[profile] web reference collection failed for project ${projectId}: ${errorLabel(error)}`);
    return [];
  }
}

async function flushEvidenceGroup(
  env: Env,
  projectId: string,
  groupKey: string,
  now: number,
  limits: { maxChars: number; maxSegments: number; idleMs: number },
): Promise<number> {
  const result = await env.DB.prepare(
    "SELECT id, owner_id, source_app, external_session_id, workspace_id, char_count, created_at FROM profile_evidence_inbox WHERE project_id = ? AND group_key = ? ORDER BY created_at ASC LIMIT ?",
  ).bind(projectId, groupKey, limits.maxSegments * MAX_FLUSH_BATCHES_PER_GROUP).all<InboxRow>();

  let pending = result.results;
  let flushed = 0;
  while (pending.length > 0 && flushed < MAX_FLUSH_BATCHES_PER_GROUP) {
    const batch = takeBatch(pending, limits.maxChars, limits.maxSegments);
    if (batch.length === 0) break;
    const remaining = pending.slice(batch.length);
    const batchChars = batch.reduce((sum, row) => sum + row.char_count, 0);
    // Full means "hit a limit", which includes landing exactly on one. Testing
    // only `remaining.length > 0` would leave a group whose total is exactly
    // maxChars sitting until the idle timeout, even though the group-level
    // HAVING clause already selected it as ready.
    const isFull = remaining.length > 0
      || batchChars >= limits.maxChars
      || batch.length >= limits.maxSegments;
    // The trailing partial batch waits for the idle timeout, which is what stops
    // a quiet tail of a conversation from never being extracted at all.
    const isIdle = now - batch[0].created_at >= limits.idleMs;
    if (!isFull && !isIdle) break;

    const head = batch[0];
    const webReferenceIds = await collectWebReferences(env, projectId, batch);
    await createExtractionJob(env, projectId, {
      evidenceSegmentIds: [...batch.map((row) => row.id), ...webReferenceIds],
      ownerId: head.owner_id,
      sourceApp: head.source_app,
      externalSessionId: head.external_session_id,
      workspaceId: head.workspace_id,
    });
    await markSegmentsExtracted(env, projectId, batch.map((row) => row.id), now);
    for (const idChunk of chunkArray(batch.map((row) => row.id), INBOX_DELETE_CHUNK_SIZE)) {
      const placeholders = idChunk.map(() => "?").join(",");
      await env.DB
        .prepare(`DELETE FROM profile_evidence_inbox WHERE project_id = ? AND id IN (${placeholders})`)
        .bind(projectId, ...idChunk)
        .run();
    }
    pending = remaining;
    flushed += 1;
  }
  return flushed;
}

/**
 * Groups buffered evidence by (owner, source app, session, workspace) and turns
 * each ready group into extraction jobs. Grouping by session keeps a batch from
 * straddling two unrelated topics, which would otherwise let the extractor
 * attach a subject to the wrong conversation.
 */
export async function flushReadyEvidenceGroups(env: Env, limit = 20): Promise<{ groups: number; jobs: number }> {
  const now = Date.now();
  const limits = batchLimits(env);
  const groups = await env.DB.prepare(
    `SELECT project_id, group_key
     FROM profile_evidence_inbox
     GROUP BY project_id, group_key
     HAVING SUM(char_count) >= ? OR COUNT(*) >= ? OR MIN(created_at) <= ?
     ORDER BY MIN(created_at) ASC
     LIMIT ?`,
  ).bind(limits.maxChars, limits.maxSegments, now - limits.idleMs, Math.min(Math.max(limit, 1), 100))
    .all<{ project_id: string; group_key: string }>();

  let jobs = 0;
  for (const group of groups.results) {
    try {
      jobs += await flushEvidenceGroup(env, group.project_id, group.group_key, now, limits);
    } catch (error) {
      console.error(`[profile] flush failed for project ${group.project_id}: ${errorLabel(error)}`);
    }
  }
  return { groups: groups.results.length, jobs };
}

export async function processProfileJobs(env: Env, limit = 20): Promise<void> {
  const breakerOpenUntilAt = await getBreakerOpenUntilAt(env);
  if (breakerOpenUntilAt !== null) {
    console.info(`[profile] extraction skipped: circuit breaker open until ${breakerOpenUntilAt}`);
    return;
  }
  const ids = await nextReadyJobIds(env, Date.now(), Math.min(Math.max(limit, 1), 100));
  for (const id of ids) await processProfileJob(env, id);
}
