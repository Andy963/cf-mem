import {
  fetchActiveClaimByIdentity,
  fetchActiveRuleClaims,
  fetchClaimById,
  fetchClaimsByIds,
  fetchContextClaims,
  fetchEvidenceByClaimIds,
  fetchGlobalProfileClaims,
  fetchToolInsightClaims,
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
import { embedTexts } from "../ai/embedding";
import type { Env, Primitive } from "../env";
import type { ProjectScope } from "../project";
import {
  type ClaimCategory,
  type ClaimInput,
  type ClaimMutationRequest,
  ClaimSchemaError,
  type ContextRequest,
  isTrivialPrompt,
} from "./claims";
import { cosineSimilarity, findVectorizedClaimMatches, syncClaimVector } from "./claim-index";
import { readDedupConfig, resolveSemanticDuplicate, withClaimDedupLock } from "./claim-dedup";
import { chunkArray } from "../utils";

function newClaimId(): string {
  // UUIDs are globally unique while remaining within Vectorize's 64-byte ID limit.
  return `claim_${crypto.randomUUID()}`;
}

// Usage feedback: last usage timestamp recorded per claim id within this
// isolate's lifetime. Workers are ephemeral, so this is a soft dedup — it
// collapses bursts within a minute but a cold isolate records again. That is
// the right trade-off: exact counting is not needed, only the ability to tell
// “never used” from “used recently”, and collapsing bursts keeps the write
// volume proportional to distinct turns rather than every chunk injection.
const USAGE_RECORD_DEDUP_MS = 60_000;
const lastUsageRecordedAt = new Map<string, number>();

function usageKey(projectId: string, claimId: string): string {
  return `${projectId}\n${claimId}`;
}

/**
 * Records that the given claims were just injected into an agent turn.
 * Awaited by the caller: the chunked UPDATEs must complete before the Worker
 * response ends — a fire-and-forget promise gets killed when the fetch handler
 * returns, silently losing usage data.
 */
export async function recordClaimUsage(env: Env, projectId: string, claimIds: string[]): Promise<void> {
  if (claimIds.length === 0) return;
  const now = Date.now();
  // Keep the soft-dedup map bounded; entries older than the dedup window are
  // dead weight once their row is written.
  for (const [key, ts] of lastUsageRecordedAt) {
    if (now - ts >= USAGE_RECORD_DEDUP_MS) lastUsageRecordedAt.delete(key);
  }
  const fresh = [...new Set(claimIds)].filter((id) => {
    const last = lastUsageRecordedAt.get(usageKey(projectId, id));
    return last === undefined || now - last >= USAGE_RECORD_DEDUP_MS;
  });
  if (fresh.length === 0) return;
  for (const chunk of chunkArray(fresh, 50)) {
    try {
      const placeholders = chunk.map(() => "?").join(",");
      await env.DB.prepare(
        `UPDATE memory_claims SET use_count = use_count + 1, last_used_at = ? WHERE project_id = ? AND id IN (${placeholders})`,
      ).bind(now, projectId, ...chunk).run();
      // Only suppress a duplicate after the corresponding D1 write succeeds.
      for (const id of chunk) lastUsageRecordedAt.set(usageKey(projectId, id), now);
    } catch {
      // Usage stats must never break recall. A failed chunk remains eligible for
      // a later request instead of being lost behind the soft-dedup map.
    }
  }
}

function parseValue(row: StoredClaimRow): unknown {
  try {
    return JSON.parse(row.value_json);
  } catch {
    return null;
  }
}

function toClaimResponse(row: StoredClaimRow, evidence: Array<{ segmentId: string; relation: string }> = []): Record<string, unknown> {
  const category = row.category ?? "domain_fact";
  return {
    id: row.id,
    project_id: row.project_id,
    scope_kind: row.scope_kind,
    scope_id: row.scope_id,
    category,
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
    use_count: row.use_count ?? 0,
    last_used_at: row.last_used_at ?? null,
    active_score: category === "domain_fact" || category === "user_profile" ? calculateActiveScore(row) : null,
    evidence: evidence.map(({ segmentId, relation }) => ({ segment_id: segmentId, relation })),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Calculates dynamic decay score (ActiveScore) for domain facts and user profile.
 * ActiveScore = confidence * exp(-0.023 * deltaDays) * (1 + ln(1 + use_count))
 */
export function calculateActiveScore(
  claim: Pick<StoredClaimRow, "confidence" | "use_count" | "last_used_at" | "created_at">,
  now: number = Date.now(),
): number {
  const lastUsed = claim.last_used_at ?? claim.created_at;
  const deltaDays = Math.max(0, (now - lastUsed) / (24 * 60 * 60 * 1000));
  const useCount = claim.use_count ?? 0;
  const confidence = Number.isFinite(claim.confidence) ? claim.confidence : 1.0;
  return confidence * Math.exp(-0.023 * deltaDays) * (1 + Math.log(1 + useCount));
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
    const now = Date.now();
    const claimId = newClaimId();
    const current = await fetchActiveClaimByIdentity(db, projectScope.projectId, claim);
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
        if (claim.provenance !== "model_inferred" && (claim.category === "rule" || claim.category === "tool_insight")) {
          await replaceActiveClaim(db, projectScope.projectId, current.id, claimId, claim, now);
          await syncClaimVector(env, { ...current, status: "superseded" });
          return await requireClaim(db, projectScope.projectId, claimId);
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
  // task_state was removed from the taxonomy. Migration 0019 retracts the
  // historical rows; this guard keeps any survivor out of the context entirely
  // instead of letting it fall through to generic routing.
  if ((claim.category as string) === "task_state" || (claim.type as string) === "task_state") return false;
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
  // The category-aware route is the only supported path for tool insights.
  // Keep legacy context callers compatible without broadcasting tool-specific
  // operational details into every session.
  if (!request.categories && claim.category === "tool_insight") return false;
  if (!request.profileOnly) return true;
  if (claim.scope_kind !== "user" || claim.scope_id !== request.userId) return false;
  if (claim.applicability === "workspace") return Boolean(request.workspaceId && claim.workspace_id === request.workspaceId);
  return claim.applicability === "semantic";
}

function profileMinimumScore(env: Env): number {
  const score = Number(env.PROFILE_CONTEXT_MIN_SCORE ?? "0.55");
  return Number.isFinite(score) && score >= 0 && score <= 1 ? score : 0.55;
}

const MAX_D1_SEMANTIC_FALLBACK_CLAIMS = 500;
const SEMANTIC_FALLBACK_BATCH_SIZE = 32;
const LEGACY_CONTEXT_CATEGORIES: ClaimCategory[] = ["rule", "user_profile", "domain_fact"];

interface SemanticContextMatch {
  claim: StoredClaimRow;
  score: number;
}

function selectRoutedClaims(
  deterministicClaims: StoredClaimRow[],
  semanticClaims: StoredClaimRow[],
  categories: ClaimCategory[],
  limit: number,
): StoredClaimRow[] {
  const allClaims = [...deterministicClaims, ...semanticClaims];
  const buckets = categories.map((category) => allClaims.filter((claim) => (claim.category ?? "domain_fact") === category));
  const positions = buckets.map(() => 0);
  const selected: StoredClaimRow[] = [];
  const seen = new Set<string>();

  while (selected.length < limit) {
    let added = false;
    for (let bucketIndex = 0; bucketIndex < buckets.length && selected.length < limit; bucketIndex += 1) {
      const bucket = buckets[bucketIndex];
      while (positions[bucketIndex] < bucket.length && seen.has(bucket[positions[bucketIndex]].id)) {
        positions[bucketIndex] += 1;
      }
      const claim = bucket[positions[bucketIndex]];
      if (!claim) continue;
      positions[bucketIndex] += 1;
      seen.add(claim.id);
      selected.push(claim);
      added = true;
    }
    if (!added) break;
  }

  return selected;
}

/**
 * Vectorize's topK is applied before D1 validates status, expiry, scope, and
 * category. If stale vectors occupy that window, re-embed the authoritative
 * D1 candidates so valid claims can still satisfy the requested limit.
 */
async function loadSemanticContextClaims(
  env: Env,
  projectScope: ProjectScope,
  request: ContextRequest,
  filter: Record<string, Primitive> | undefined,
  accepts: (claim: StoredClaimRow, score: number) => boolean,
): Promise<SemanticContextMatch[]> {
  if (!env.CLAIMS_INDEX || !request.query || isTrivialPrompt(request.query)) return [];

  let queryVector: number[];
  try {
    const [embeddedQuery] = await embedTexts(env, [request.query]);
    if (!embeddedQuery || embeddedQuery.length === 0) return [];
    queryVector = embeddedQuery;
  } catch {
    return [];
  }

  const initialTopK = Math.min(Math.max(request.limit * 5, 20), 100);
  const queries: Array<{ topK: number; filter?: Record<string, Primitive> }> = [{ topK: initialTopK, filter }];
  if (initialTopK < 100) queries.push({ topK: 100, filter });
  if (filter) queries.push({ topK: 100 });

  const matchesById = new Map<string, SemanticContextMatch>();
  for (const query of queries) {
    const matches = await findVectorizedClaimMatches(env, {
      projectId: projectScope.projectId,
      vector: queryVector,
      topK: query.topK,
      filter: query.filter,
    });
    if (matches.length === 0) continue;

    const claimsById = await fetchClaimsByIds(env.DB, projectScope.projectId, matches.map((match) => match.id));
    for (const match of matches) {
      const claim = claimsById.get(match.id);
      if (!claim || !accepts(claim, match.score)) continue;
      const previous = matchesById.get(claim.id);
      if (!previous || match.score > previous.score) matchesById.set(claim.id, { claim, score: match.score });
    }

    if (matchesById.size >= request.limit) break;
  }

  if (matchesById.size < request.limit) {
    let d1Candidates: StoredClaimRow[];
    try {
      d1Candidates = await fetchContextClaims(env.DB, projectScope.projectId, {
        userId: request.userId,
        sessionId: request.sessionId,
        types: request.types,
        categories: filter?.category === "domain_fact"
          ? ["domain_fact"]
          : request.categories ?? LEGACY_CONTEXT_CATEGORIES,
        workspaceId: request.workspaceId,
        limit: MAX_D1_SEMANTIC_FALLBACK_CLAIMS,
      });
    } catch {
      d1Candidates = [];
    }
    const pending = d1Candidates.filter((claim) => !matchesById.has(claim.id));
    for (let index = 0; index < pending.length; index += SEMANTIC_FALLBACK_BATCH_SIZE) {
      const batch = pending.slice(index, index + SEMANTIC_FALLBACK_BATCH_SIZE);
      let vectors: number[][];
      try {
        vectors = await embedTexts(env, batch.map((claim) => claim.canonical_text));
      } catch {
        break;
      }
      if (vectors.length !== batch.length) break;
      for (const [batchIndex, vector] of vectors.entries()) {
        const score = cosineSimilarity(queryVector, vector);
        const claim = batch[batchIndex];
        if (score === null || !accepts(claim, score)) continue;
        const previous = matchesById.get(claim.id);
        if (!previous || score > previous.score) matchesById.set(claim.id, { claim, score });
      }
      if (matchesById.size >= request.limit) break;
    }
  }

  return [...matchesById.values()].sort((left, right) => right.score - left.score);
}

export async function loadMemoryContext(
  env: Env,
  projectScope: ProjectScope,
  request: ContextRequest,
): Promise<{ project_id: string; claims: Array<Record<string, unknown>> }> {
  const db = env.DB;
  const now = Date.now();

  if (request.categories && request.categories.length > 0) {
    const deterministicClaims: StoredClaimRow[] = [];
    const categoriesSet = new Set(request.categories);

    if (categoriesSet.has("rule")) {
      const rules = await fetchActiveRuleClaims(db, projectScope.projectId, {
        workspaceId: request.workspaceId,
        userId: request.userId,
        types: request.types,
        limit: request.limit,
      });
      deterministicClaims.push(...rules);
    }

    if (categoriesSet.has("tool_insight") && request.scopeId) {
      const toolInsights = await fetchToolInsightClaims(db, projectScope.projectId, request.scopeId, request.limit, {
        workspaceId: request.workspaceId,
        types: request.types,
      });
      deterministicClaims.push(...toolInsights);
    }

    if (categoriesSet.has("user_profile")) {
      if (request.userId) {
        deterministicClaims.push(
          ...await fetchGlobalProfileClaims(db, projectScope.projectId, request.userId, request.limit, "user_profile", request.types),
        );
        if (request.workspaceId) {
          deterministicClaims.push(
            ...await fetchWorkspaceProfileClaims(
              db,
              projectScope.projectId,
              request.userId,
              request.workspaceId,
              request.limit,
              "user_profile",
              request.types,
            ),
          );
        }
      }
    }

    const routedDeterministicClaims = deterministicClaims.filter((claim) =>
      (!request.types || request.types.includes(claim.type))
      && request.categories?.includes(claim.category ?? "domain_fact"),
    );

    let semanticClaims: StoredClaimRow[] = [];
    const semanticScores = new Map<string, number>();

    const minScore = profileMinimumScore(env);
    const domainFactMatches = categoriesSet.has("domain_fact")
      ? await loadSemanticContextClaims(
        env,
        projectScope,
        request,
        { status: "active", category: "domain_fact" },
        (claim, score) => claim.category === "domain_fact"
          && isApplicableContextClaim(claim, projectScope, request, now)
          && score >= minScore,
      )
      : [];
    semanticClaims = domainFactMatches.map((match) => match.claim);
    for (const match of domainFactMatches) semanticScores.set(match.claim.id, match.score);

    const claims = selectRoutedClaims(routedDeterministicClaims, semanticClaims, request.categories, request.limit);

    const evidence = await fetchEvidenceByClaimIds(db, projectScope.projectId, claims.map((claim) => claim.id));
    await recordClaimUsage(env, projectScope.projectId, claims.map((claim) => claim.id));
    return {
      project_id: projectScope.projectId,
      claims: claims.map((claim) => ({
        ...toClaimResponse(claim, evidence.get(claim.id)),
        relevance_score: semanticScores.get(claim.id) ?? null,
      })),
    };
  }

  const deterministicClaims = request.profileOnly
    ? (request.userId
      ? [
        ...await fetchGlobalProfileClaims(db, projectScope.projectId, request.userId, request.limit, undefined, request.types),
        ...(request.workspaceId
          ? await fetchWorkspaceProfileClaims(
            db,
            projectScope.projectId,
            request.userId,
            request.workspaceId,
            request.limit,
            undefined,
            request.types,
          )
          : []),
      ]
      : [])
    : (await fetchContextClaims(db, projectScope.projectId, {
      ...request,
      // Legacy callers did not have a way to request a tool scope. Exclude the
      // new tool-specific category while retaining all categories represented
      // by the pre-taxonomy API.
      categories: LEGACY_CONTEXT_CATEGORIES,
    })).filter(
        (claim) => claim.applicability !== "workspace" || (Boolean(request.workspaceId) && claim.workspace_id === request.workspaceId),
      );
  const semanticMatches = await loadSemanticContextClaims(
    env,
    projectScope,
    request,
    undefined,
    (claim, score) => profileClaimMatches(claim, projectScope, request, score, profileMinimumScore(env), now),
  );
  const semanticClaims = semanticMatches.map((match) => match.claim);
  const semanticScores = new Map(semanticMatches.map((match) => [match.claim.id, match.score]));
  const seen = new Set<string>();
  const claims = [...deterministicClaims, ...semanticClaims]
    .filter((claim) => {
      if (seen.has(claim.id)) return false;
      seen.add(claim.id);
      return true;
    })
    .slice(0, request.limit);
  const evidence = await fetchEvidenceByClaimIds(db, projectScope.projectId, claims.map((claim) => claim.id));
  // Usage feedback: these claims are about to be injected into an agent turn.
  // Awaited (cheap single UPDATE) so it completes before the response ends.
  await recordClaimUsage(env, projectScope.projectId, claims.map((claim) => claim.id));
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
