import { fetchByIds } from "../db/d1";
import type { StoredMemoryRow } from "./schema";
import type { Env } from "../env";
import type { ProjectScope } from "../project";
import { chunkArray } from "../utils";
import { createExtractionJob, isWebReferenceRow } from "./profile";
import { normalizeExternalSessionId } from "./session";

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
// Keep nudge-created jobs within the same evidence limits used by the profile
// extractor. A cron tick may scan more rows, but one job must never silently
// lose its tail when boundedEvidenceText applies its character budget.
const MAX_EVIDENCE_SEGMENTS_PER_JOB = 24;
const MAX_EVIDENCE_CHARS_PER_JOB = 12_000;

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

function segmentCharCount(row: StoredMemoryRow | undefined): number {
  return typeof row?.text === "string" ? row.text.length : 0;
}

function takeEvidenceBatch(ids: string[], resolved: ReadonlyMap<string, StoredMemoryRow>): string[] {
  const batch: string[] = [];
  let chars = 0;
  for (const id of ids) {
    if (batch.length >= MAX_EVIDENCE_SEGMENTS_PER_JOB) break;
    const nextChars = segmentCharCount(resolved.get(id));
    if (nextChars > MAX_EVIDENCE_CHARS_PER_JOB) {
      if (batch.length === 0) return [];
      break;
    }
    if (batch.length > 0 && chars + nextChars > MAX_EVIDENCE_CHARS_PER_JOB) break;
    batch.push(id);
    chars += nextChars;
  }
  return batch;
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
       AND json_valid(metadata_json) = 1
       AND json_extract(metadata_json, '$.kind') = 'user'
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
  let markedSegments = 0;
  for (const { key, ids } of groups.values()) {
    // Ingest stores session_id as `${sourceApp}:${externalSessionId}`; keep the
    // same shape so extraction lineage stays comparable across both paths.
    const externalSessionId = normalizeExternalSessionId(key.sourceApp, key.sessionId) || "nudge";
    try {
      let pendingIds = ids;
      while (pendingIds.length > 0) {
        const batchIds = takeEvidenceBatch(pendingIds, resolved);
        if (batchIds.length === 0) {
          const oversizedId = pendingIds[0];
          if (segmentCharCount(resolved.get(oversizedId)) > MAX_EVIDENCE_CHARS_PER_JOB) {
            await markSegmentExtractionFailed(env, key.projectId, oversizedId);
            console.warn(`[nudge] skipped oversized segment ${oversizedId} for project ${key.projectId}`);
            pendingIds = pendingIds.slice(1);
            continue;
          }
          break;
        }
        await createExtractionJob(env, key.projectId, {
          evidenceSegmentIds: batchIds,
          ownerId: key.ownerId,
          sourceApp: key.sourceApp || "unknown",
          externalSessionId: externalSessionId || "nudge",
          workspaceId: key.workspaceId || null,
        });
        jobs += 1;
        for (const idChunk of chunkArray(batchIds, 50)) {
          const placeholders = idChunk.map(() => "?").join(",");
          await env.DB.prepare(
            `UPDATE memory_segments SET extracted_at = COALESCE(extracted_at, ?) WHERE project_id = ? AND deletion_state = 'active' AND id IN (${placeholders})`,
          ).bind(now, key.projectId, ...idChunk).run();
        }
        markedSegments += batchIds.length;
        pendingIds = pendingIds.slice(batchIds.length);
      }
    } catch (error) {
      console.error(`[nudge] job creation or segment marking failed for project ${key.projectId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { scanned: candidates.results.length, jobs, segments: markedSegments };
}

/**
 * Failure accounting for a nudge-enqueued segment whose extraction job died.
 * The job failure path calls this so these segments are retried a bounded
 * number of times instead of every tick forever.
 */
export async function markSegmentExtractionFailed(env: Env, projectId: string, segmentId: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE memory_segments SET extract_failed_count = extract_failed_count + 1 WHERE project_id = ? AND id = ?",
  ).bind(projectId, segmentId).run();
}
