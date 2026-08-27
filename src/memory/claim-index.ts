import { embedTexts } from "../ai/embedding";
import type { StoredClaimRow } from "../db/d1";
import type { Env, Primitive } from "../env";
import { toQueryMatches } from "../vector/vectorize";

function claimNamespace(projectId: string): string {
  return `project:${projectId}:claims`;
}

export async function syncClaimVector(env: Env, claim: StoredClaimRow): Promise<void> {
  const index = env.CLAIMS_INDEX;
  if (!index) return;
  try {
    if (claim.status !== "active") {
      if (index.deleteByIds) await index.deleteByIds([claim.id]);
      return;
    }
    const [vector] = await embedTexts(env, [claim.canonical_text]);
    if (!vector) throw new Error("Missing embedding vector for durable claim");
    await index.upsert([
      {
        id: claim.id,
        namespace: claimNamespace(claim.project_id),
        values: vector,
        metadata: {
          project_id: claim.project_id,
          scope_kind: claim.scope_kind,
          scope_id: claim.scope_id,
          type: claim.type,
          status: claim.status,
          applicability: claim.applicability,
          workspace_id: claim.workspace_id ?? "",
        },
      },
    ]);
  } catch (error) {
    // The D1 row is already committed by the time this runs, so a vector sync
    // failure leaves the claim durable but not semantically searchable. It is
    // rethrown so the caller still reports failure, but logged here because the
    // caller's error surface does not say which claim drifted.
    console.error(`[claims] vector sync failed for claim ${claim.id} in project ${claim.project_id}: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

export async function findVectorizedClaimMatches(
  env: Env,
  options: {
    projectId: string;
    vector: number[];
    topK: number;
    filter?: Record<string, Primitive>;
  },
): Promise<Array<{ id: string; score: number }>> {
  if (!env.CLAIMS_INDEX) return [];
  const queryOptions: {
    topK: number;
    namespace: string;
    filter?: Record<string, Primitive>;
    returnValues: boolean;
  } = {
    topK: options.topK,
    namespace: claimNamespace(options.projectId),
    // Threshold decisions must use exact scores rather than Vectorize's
    // approximate default scores.
    returnValues: true,
  };
  if (options.filter) queryOptions.filter = options.filter;
  const result = await env.CLAIMS_INDEX.query(options.vector, queryOptions);
  return toQueryMatches(result)
    .filter((match): match is { id: string; score: number } => typeof match.id === "string" && match.id.length > 0 && typeof match.score === "number")
    .map((match) => ({ id: match.id, score: match.score }));
}

export async function searchClaimMatches(
  env: Env,
  options: { projectId: string; query: string; topK: number },
): Promise<Array<{ id: string; score: number }>> {
  if (!env.CLAIMS_INDEX || !options.query.trim()) return [];
  const [vector] = await embedTexts(env, [options.query]);
  if (!vector) return [];
  return findVectorizedClaimMatches(env, {
    projectId: options.projectId,
    vector,
    topK: options.topK,
  });
}
