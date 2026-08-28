import {
  fetchActiveClaimByIdentity,
  fetchClaimById,
  fetchClaimsByIds,
  fetchContextClaims,
  fetchEvidenceByClaimIds,
  fetchGlobalProfileClaims,
  fetchWorkspaceProfileClaims,
  fetchSegmentsInProject,
  insertClaimEvidence,
  insertClaimWithEvidence,
  listClaims,
  reinforceClaim,
  replaceActiveClaim,
  retractClaim,
  type StoredClaimRow,
} from "../db/d1";
import type { Env } from "../env";
import type { ProjectScope } from "../project";
import {
  type ClaimInput,
  type ClaimMutationRequest,
  ClaimSchemaError,
  type ContextRequest,
  isTrivialPrompt,
} from "./claims";
import { searchClaimMatches, syncClaimVector } from "./claim-index";
import { readDedupConfig, resolveSemanticDuplicate, withClaimDedupLock } from "./claim-dedup";

function newClaimId(): string {
  // UUIDs are globally unique while remaining within Vectorize's 64-byte ID limit.
  return `claim_${crypto.randomUUID()}`;
}

function parseValue(row: StoredClaimRow): unknown {
  try {
    return JSON.parse(row.value_json);
  } catch {
    return null;
  }
}

function toClaimResponse(row: StoredClaimRow, evidence: Array<{ segmentId: string; relation: string }> = []): Record<string, unknown> {
  return {
    id: row.id,
    project_id: row.project_id,
    scope_kind: row.scope_kind,
    scope_id: row.scope_id,
    type: row.type,
    subject: row.subject,
    memory_key: row.memory_key,
    value: parseValue(row),
    canonical_text: row.canonical_text,
    status: row.status,
    provenance: row.provenance,
    confidence: row.confidence,
    valid_from: row.valid_from,
    valid_until: row.valid_until,
    superseded_by: row.superseded_by,
    applicability: row.applicability,
    workspace_id: row.workspace_id,
    evidence: evidence.map(({ segmentId, relation }) => ({ segment_id: segmentId, relation })),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function verifyEvidence(db: D1Database, projectId: string, segmentIds: string[]): Promise<void> {
  if (segmentIds.length === 0) return;

  const existing = await fetchSegmentsInProject(db, projectId, segmentIds);
  const missing = segmentIds.filter((segmentId) => !existing.has(segmentId));
  if (missing.length > 0) {
    throw new ClaimSchemaError("All evidence_segment_ids must reference memory segments in the authenticated project");
  }
}

async function requireClaim(db: D1Database, projectId: string, claimId: string): Promise<StoredClaimRow> {
  const claim = await fetchClaimById(db, projectId, claimId);
  if (!claim) throw new ClaimSchemaError("Claim was not found in the authenticated project");
  return claim;
}

async function createClaim(
  env: Env,
  db: D1Database,
  projectScope: ProjectScope,
  claim: ClaimInput,
  operation: "create" | "supersede",
): Promise<StoredClaimRow> {
  await verifyEvidence(db, projectScope.projectId, claim.evidenceSegmentIds);
  const execute = async (): Promise<StoredClaimRow> => {
    const current = await fetchActiveClaimByIdentity(db, projectScope.projectId, claim);
    const now = Date.now();
    const claimId = newClaimId();
    const isSameValue = (stored: StoredClaimRow) =>
      stored.value_json === JSON.stringify(claim.value) && stored.canonical_text === claim.canonicalText;

    if (operation === "create") {
      if (current) {
        if (isSameValue(current)) {
          // Inferred claims must never mutate an active claim. Keep the
          // existing active row authoritative until explicit confirmation.
          if (claim.provenance === "model_inferred") return current;
          await reinforceClaim(db, projectScope.projectId, current.id, claim.confidence, now);
          await insertClaimEvidence(db, projectScope.projectId, current.id, claim.evidenceSegmentIds, "supports", now);
          return await requireClaim(db, projectScope.projectId, current.id);
        }
        throw new ClaimSchemaError("An active claim already exists for this canonical key; use reinforce, supersede, or retract");
      } else if (claim.provenance === "model_inferred") {
        // Inferred claims must never mutate an active claim or become its
        // replacement. They remain proposed until explicitly confirmed.
        await insertClaimWithEvidence(db, projectScope.projectId, claimId, claim, "proposed", now);
      } else {
        // No identity twin under the canonical key. LLM extractors rephrase the
        // same fact across runs, so check for a semantic twin before inserting.
        const semantic = await resolveSemanticDuplicate(
          env,
          db,
          projectScope.projectId,
          claim,
          readDedupConfig(env),
        );
        if (semantic.kind === "reinforce") {
          await reinforceClaim(db, projectScope.projectId, semantic.match.id, claim.confidence, now);
          await insertClaimEvidence(db, projectScope.projectId, semantic.match.id, claim.evidenceSegmentIds, "supports", now);
          return await requireClaim(db, projectScope.projectId, semantic.match.id);
        }
        if (semantic.kind === "replace") {
          await replaceActiveClaim(db, projectScope.projectId, semantic.match.id, claimId, claim, now);
          // Pass the post-mutation status so syncClaimVector deletes the stale
          // vector instead of upserting the pre-mutation snapshot.
          await syncClaimVector(env, { ...semantic.match, status: "superseded" });
          return await requireClaim(db, projectScope.projectId, claimId);
        }
        await insertClaimWithEvidence(db, projectScope.projectId, claimId, claim, "active", now);
      }
    } else {
      if (!current) {
        throw new ClaimSchemaError("Cannot supersede because no active claim exists for this canonical key");
      }
      if (isSameValue(current)) {
        await reinforceClaim(db, projectScope.projectId, current.id, claim.confidence, now);
        await insertClaimEvidence(db, projectScope.projectId, current.id, claim.evidenceSegmentIds, "supports", now);
        return await requireClaim(db, projectScope.projectId, current.id);
      }
      await replaceActiveClaim(db, projectScope.projectId, current.id, claimId, claim, now);
      await syncClaimVector(env, { ...current, status: "superseded" });
    }

    return await requireClaim(db, projectScope.projectId, claimId);
  };

  // Vector search is only a narrowing hint, so serialize the read/decide/write
  // sequence for each claim scope. The lock has a lease for crash recovery.
  const shouldLock = Boolean(env.CLAIMS_INDEX) && claim.provenance !== "model_inferred";
  return shouldLock
    ? await withClaimDedupLock(db, projectScope.projectId, claim, execute)
    : await execute();
}

export async function mutateClaim(
  env: Env,
  projectScope: ProjectScope,
  request: ClaimMutationRequest,
): Promise<Record<string, unknown>> {
  const db = env.DB;
  if (request.operation === "create" || request.operation === "supersede") {
    const claim = await createClaim(env, db, projectScope, request.claim, request.operation);
    await syncClaimVector(env, claim);
    const evidence = await fetchEvidenceByClaimIds(db, projectScope.projectId, [claim.id]);
    return toClaimResponse(claim, evidence.get(claim.id));
  }

  if (request.operation !== "reinforce" && request.operation !== "retract") {
    throw new ClaimSchemaError("Unsupported claim operation");
  }

  const claim = await requireClaim(db, projectScope.projectId, request.claimId);
  if (request.operation === "retract" && claim.status === "retracted") {
    await syncClaimVector(env, claim);
    const evidence = await fetchEvidenceByClaimIds(db, projectScope.projectId, [claim.id]);
    return toClaimResponse(claim, evidence.get(claim.id));
  }
  if (claim.status !== "active") {
    throw new ClaimSchemaError("Only active claims can be reinforced or retracted");
  }
  const now = Date.now();

  if (request.operation === "reinforce") {
    await verifyEvidence(db, projectScope.projectId, request.evidenceSegmentIds);
    await reinforceClaim(db, projectScope.projectId, claim.id, request.confidence, now);
    await insertClaimEvidence(db, projectScope.projectId, claim.id, request.evidenceSegmentIds, "supports", now);
  } else {
    await retractClaim(db, projectScope.projectId, claim.id, now);
  }

  const updated = await requireClaim(db, projectScope.projectId, claim.id);
  await syncClaimVector(env, updated);
  const evidence = await fetchEvidenceByClaimIds(db, projectScope.projectId, [claim.id]);
  return toClaimResponse(updated, evidence.get(claim.id));
}

function isApplicableContextClaim(
  claim: StoredClaimRow,
  projectScope: ProjectScope,
  request: ContextRequest,
  now: number,
): boolean {
  if (claim.status !== "active") return false;
  if (claim.valid_from !== null && claim.valid_from > now) return false;
  if (claim.valid_until !== null && claim.valid_until <= now) return false;
  if (request.types && !request.types.includes(claim.type)) return false;
  if (claim.applicability === "workspace" && (!request.workspaceId || claim.workspace_id !== request.workspaceId)) return false;
  if (claim.scope_kind === "project") return claim.scope_id === projectScope.projectId;
  if (claim.scope_kind === "user") {
    if (!request.userId || claim.scope_id !== request.userId) return false;
    return true;
  }
  return Boolean(request.sessionId && claim.scope_id === request.sessionId);
}

function profileClaimMatches(
  claim: StoredClaimRow,
  projectScope: ProjectScope,
  request: ContextRequest,
  score: number,
  minimumScore: number,
  now: number,
): boolean {
  if (!isApplicableContextClaim(claim, projectScope, request, now) || score < minimumScore) return false;
  if (!request.profileOnly) return true;
  if (claim.scope_kind !== "user" || claim.scope_id !== request.userId) return false;
  if (claim.applicability === "workspace") return Boolean(request.workspaceId && claim.workspace_id === request.workspaceId);
  return claim.applicability === "semantic";
}

function profileMinimumScore(env: Env): number {
  const score = Number(env.PROFILE_CONTEXT_MIN_SCORE ?? "0.55");
  return Number.isFinite(score) && score >= 0 && score <= 1 ? score : 0.55;
}

export async function loadMemoryContext(
  env: Env,
  projectScope: ProjectScope,
  request: ContextRequest,
): Promise<{ project_id: string; claims: Array<Record<string, unknown>> }> {
  const db = env.DB;
  const deterministicClaims = request.profileOnly
    ? (request.userId
      ? [
        ...await fetchGlobalProfileClaims(db, projectScope.projectId, request.userId, request.limit),
        ...(request.workspaceId
          ? await fetchWorkspaceProfileClaims(db, projectScope.projectId, request.userId, request.workspaceId, request.limit)
          : []),
      ]
      : [])
    : (await fetchContextClaims(db, projectScope.projectId, request)).filter(
        (claim) => claim.applicability !== "workspace" || (Boolean(request.workspaceId) && claim.workspace_id === request.workspaceId),
      );
  const semanticMatches = request.query && !isTrivialPrompt(request.query)
    ? await searchClaimMatches(env, {
      projectId: projectScope.projectId,
      query: request.query,
      topK: Math.min(Math.max(request.limit * 5, 20), 100),
    })
    : [];
  const semanticById = await fetchClaimsByIds(db, projectScope.projectId, semanticMatches.map((match) => match.id));
  const now = Date.now();
  const semanticClaims = semanticMatches
    .map((match) => ({ claim: semanticById.get(match.id), score: match.score }))
    .filter(
      (candidate): candidate is { claim: StoredClaimRow; score: number } =>
        Boolean(candidate.claim && profileClaimMatches(candidate.claim, projectScope, request, candidate.score, profileMinimumScore(env), now)),
    )
    .map((candidate) => candidate.claim);
  const semanticMatchScores = new Map(semanticMatches.map((match) => [match.id, match.score]));
  const semanticScores = new Map(semanticClaims.map((claim) => [claim.id, semanticMatchScores.get(claim.id) ?? 0]));
  const seen = new Set<string>();
  const claims = [...deterministicClaims, ...semanticClaims]
    .filter((claim) => {
      if (seen.has(claim.id)) return false;
      seen.add(claim.id);
      return true;
    })
    .slice(0, request.limit);
  const evidence = await fetchEvidenceByClaimIds(db, projectScope.projectId, claims.map((claim) => claim.id));
  return {
    project_id: projectScope.projectId,
    claims: claims.map((claim) => ({
      ...toClaimResponse(claim, evidence.get(claim.id)),
      relevance_score: semanticScores.get(claim.id) ?? null,
    })),
  };
}

export async function listDurableMemoryClaims(
  db: D1Database,
  projectScope: ProjectScope,
  options: { scopeKind: "project" | "user" | "session" | null; scopeId: string | null; status: "active" | "superseded" | "retracted" | "proposed" | null; limit: number },
): Promise<{ project_id: string; claims: Array<Record<string, unknown>> }> {
  const claims = await listClaims(db, projectScope.projectId, options);
  const evidence = await fetchEvidenceByClaimIds(db, projectScope.projectId, claims.map((claim) => claim.id));
  return {
    project_id: projectScope.projectId,
    claims: claims.map((claim) => toClaimResponse(claim, evidence.get(claim.id))),
  };
}
