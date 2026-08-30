import { embedTexts } from "../ai/embedding";
import type { StoredClaimRow } from "../db/d1";
import type { Env, Primitive, VectorizeMatch } from "../env";
import { toQueryMatches } from "../vector/vectorize";

export function cosineSimilarity(left: number[], right: number[]): number | null {
  if (left.length === 0 || left.length !== right.length) return null;

  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index];
    const rightValue = right[index];
    if (!Number.isFinite(leftValue) || !Number.isFinite(rightValue)) return null;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }

  const denominator = Math.sqrt(leftMagnitude * rightMagnitude);
  return denominator > 0 ? dot / denominator : null;
}

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
          category: claim.category,
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
  const topK = Math.min(Math.max(Math.trunc(options.topK), 1), 100);
  const baseOptions = {
    topK,
    namespace: claimNamespace(options.projectId),
    // Threshold decisions must use the score returned for the requested vector
    // rather than relying on an approximate result shape from the binding.
    returnValues: true,
  };
  let rawMatches: VectorizeMatch[] = [];

  if (options.filter) {
    try {
      rawMatches = toQueryMatches(await env.CLAIMS_INDEX.query(options.vector, {
        ...baseOptions,
        filter: options.filter,
      }));
    } catch {
      // A newly-created metadata index may not exist in every environment yet.
      // The D1 scope check below remains authoritative, so an unfiltered query
      // is a safe compatibility fallback for old vectors and old deployments.
      rawMatches = [];
    }
  }

  if (!options.filter || rawMatches.length < topK) {
    const fallbackMatches = toQueryMatches(await env.CLAIMS_INDEX.query(options.vector, baseOptions));
    const seen = new Set(rawMatches.map((match) => match.id));
    for (const match of fallbackMatches) {
      if (seen.has(match.id)) continue;
      seen.add(match.id);
      rawMatches.push(match);
    }
    rawMatches.sort((left, right) => (right.score ?? Number.NEGATIVE_INFINITY) - (left.score ?? Number.NEGATIVE_INFINITY));
  }

  return rawMatches
    .filter((match): match is { id: string; score: number } => typeof match.id === "string" && match.id.length > 0 && typeof match.score === "number")
    .slice(0, topK)
    .map((match) => ({ id: match.id, score: match.score }));
}

export async function searchClaimMatches(
  env: Env,
  options: { projectId: string; query: string; topK: number; filter?: Record<string, Primitive> },
): Promise<Array<{ id: string; score: number }>> {
  if (!env.CLAIMS_INDEX || !options.query.trim()) return [];
  const [vector] = await embedTexts(env, [options.query]);
  if (!vector) return [];
  return findVectorizedClaimMatches(env, {
    projectId: options.projectId,
    vector,
    topK: options.topK,
    filter: options.filter,
  });
}
