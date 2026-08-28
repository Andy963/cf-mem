import { fetchByIds } from "../db/d1";
import type { StoredMemoryRow } from "./schema";
import type { Env } from "../env";
import type { ProjectScope } from "../project";
import { createExtractionJob, isWebReferenceRow } from "./profile";

// Nudge sweep: segments written via POST /memory/index never enter the
// durable-memory extraction pipeline on their own — only /memory/profile/ingest
// evidence does. This scan finds old-enough user-kind segments that have never
// been extracted, groups them the way the ingest buffer would (owner + source
// app + session + workspace), and turns each group into a standard extraction
// job so the same extract → verify → reconcile pipeline can process it.

// Leave a window after creation so an in-flight ingest flush (which creates
// jobs for its own segments) is not raced into a duplicate job.
const DEFAULT_MIN_AGE_MS = 30 * 60_000;
// Every cron tick processes at most this many segments. The pipeline batches
// by MAX_EVIDENCE_SEGMENTS anyway; this keeps a single tick bounded even when
// a backlog of unextracted segments accumulates.
const DEFAULT_MAX_SEGMENTS_PER_TICK = 48;
// After this many failed extraction attempts a segment is abandoned: repeated
// LLM outages must not wedge the same rows into every future tick.
const MAX_FAILED_ATTEMPTS = 3;

export interface NudgeScanResult {
  scanned: number;
  jobs: number;
  segments: number;
}

interface SegmentGroupKey {
  projectId: string;
  ownerId: string;
  sourceApp: string;
  sessionId: string;
  workspaceId: string;
}

interface NudgeCandidateRow {
  id: string;
  project_id: string;
}

function positiveIntEnv(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function metadataField(row: StoredMemoryRow | undefined, key: string): string {
  if (!row) return "";
  const raw = row.metadata_json;
  if (typeof raw !== "string") return "";
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "";
    const value = (parsed as Record<string, unknown>)[key];
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}

function groupKeyOf(row: NudgeCandidateRow, resolved: Map<string, StoredMemoryRow>): SegmentGroupKey {
  const stored = resolved.get(row.id);
  return {
    projectId: row.project_id,
    ownerId: metadataField(stored, "user_id") || "unknown",
    sourceApp: metadataField(stored, "source_app") || "unknown",
    sessionId: metadataField(stored, "session_id") || "unknown",
    workspaceId: metadataField(stored, "workspace_id"),
  };
}

function groupKeyId(key: SegmentGroupKey): string {
  return [key.projectId, key.ownerId, key.sourceApp, key.sessionId, key.workspaceId].join("|");
}

/**
 * One nudge pass over unextracted user segments. Returns how many extraction
 * jobs were created and how many segments were marked. Designed for the cron
 * handler; cheap when there is nothing to do (one indexed SELECT).
 */
export async function runNudgeExtractionScan(env: Env): Promise<NudgeScanResult> {
  const maxSegments = positiveIntEnv(env.MEMORY_NUDGE_MAX_SEGMENTS_PER_TICK, DEFAULT_MAX_SEGMENTS_PER_TICK);
  const minAgeMs = positiveIntEnv(env.MEMORY_NUDGE_MIN_AGE_MS, DEFAULT_MIN_AGE_MS);
  const now = Date.now();

  const candidates = await env.DB.prepare(
    `SELECT id, project_id FROM memory_segments
     WHERE deletion_state = 'active'
       AND extracted_at IS NULL
       AND extract_failed_count < ${MAX_FAILED_ATTEMPTS}
       AND created_at <= ?
       AND metadata_json LIKE '%"kind":"user"%'
     ORDER BY created_at ASC
     LIMIT ?`,
  ).bind(now - minAgeMs, maxSegments).all<NudgeCandidateRow>();
  if (candidates.results.length === 0) return { scanned: 0, jobs: 0, segments: 0 };

  // Segment ids are project-scoped by contract; resolve rows per project so
  // metadata grouping reads the same fields the ingest path groups by.
  const byProject = new Map<string, NudgeCandidateRow[]>();
  for (const row of candidates.results) {
    const list = byProject.get(row.project_id) ?? [];
    list.push(row);
    byProject.set(row.project_id, list);
  }

  const resolved = new Map<string, StoredMemoryRow>();
  for (const [projectId, rows] of byProject) {
    const scope: ProjectScope = { projectId, namespace: `project:${projectId}` };
    const found = await fetchByIds(env.DB, scope.projectId, rows.map((row) => row.id));
    for (const [id, row] of found) resolved.set(id, row);
  }

  const groups = new Map<string, { key: SegmentGroupKey; ids: string[] }>();
  for (const row of candidates.results) {
    const stored = resolved.get(row.id);
    if (!stored) continue;
    // Web-reference and inbox-kind rows are pipeline-managed; nudging them
    // would fight the flush queue's own bookkeeping.
    if (isWebReferenceRow(stored)) continue;
    const key = groupKeyOf(row, resolved);
    const groupId = groupKeyId(key);
    const group = groups.get(groupId) ?? { key, ids: [] };
    group.ids.push(row.id);
    groups.set(groupId, group);
  }

  let jobs = 0;
  const markedIds: string[] = [];
  for (const { key, ids } of groups.values()) {
    // Ingest stores session_id as `${sourceApp}:${externalSessionId}`; keep the
    // same shape so extraction lineage stays comparable across both paths.
    const [sourceApp, externalSessionId] = key.sessionId.includes(":")
      ? [key.sourceApp, key.sessionId.slice(key.sourceApp.length + 1)]
      : [key.sourceApp, key.sessionId];
    try {
      await createExtractionJob(env, key.projectId, {
        evidenceSegmentIds: ids,
        ownerId: key.ownerId,
        sourceApp: sourceApp || "unknown",
        externalSessionId: externalSessionId || "nudge",
        workspaceId: key.workspaceId || null,
      });
      jobs += 1;
      markedIds.push(...ids);
    } catch (error) {
      console.error(`[nudge] job creation failed for project ${key.projectId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Marking happens after job creation: dying between the two means a
  // duplicate job at worst (createExtractionJob is idempotent on the evidence
  // id set), never a lost segment. The reverse order would lose them.
  if (markedIds.length > 0) {
    for (let i = 0; i < markedIds.length; i += 50) {
      const chunk = markedIds.slice(i, i + 50);
      const placeholders = chunk.map(() => "?").join(",");
      await env.DB.prepare(
        `UPDATE memory_segments SET extracted_at = ? WHERE id IN (${placeholders})`,
      ).bind(now, ...chunk).run();
    }
  }

  return { scanned: candidates.results.length, jobs, segments: markedIds.length };
}

/**
 * Failure accounting for a nudge-enqueued segment whose extraction job died.
 * The job failure path calls this so these segments are retried a bounded
 * number of times instead of every tick forever.
 */
export async function markSegmentExtractionFailed(env: Env, segmentId: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE memory_segments SET extract_failed_count = extract_failed_count + 1 WHERE id = ?",
  ).bind(segmentId).run();
}
