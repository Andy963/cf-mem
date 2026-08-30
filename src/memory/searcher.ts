import { embedTexts } from "../ai/embedding";
import { extractRerankResults, resolveRerankConfig } from "../ai/rerank";
import { fetchByIds } from "../db/d1";
import type { Env } from "../env";
import { truncateText } from "../utils";
import { toQueryMatches } from "../vector/vectorize";
import { defaultMemorySchema, type SearchRequestInput, type StoredMemoryRow } from "./schema";

export interface MemorySearchResult {
  ok: true;
  project_id: string;
  namespace: string;
  topK: number;
  matches: Array<Record<string, unknown>>;
  rerank?: {
    enabled: true;
    model: string;
    topN: number;
  };
}

function parseRowMetadata(row: StoredMemoryRow): unknown {
  if (typeof row.metadata_json !== "string") return null;

  try {
    return JSON.parse(row.metadata_json);
  } catch {
    return null;
  }
}

export async function searchMemoryItems(env: Env, requestInput: SearchRequestInput, requestBody: unknown): Promise<MemorySearchResult> {
  const requestedTopK = defaultMemorySchema.getRequestedTopK(requestInput);
  const rerankConfig = resolveRerankConfig(env, requestBody, requestedTopK);
  const baseCandidateTopK = defaultMemorySchema.getCandidateTopK(requestInput);
  const candidateTopK = rerankConfig ? Math.max(baseCandidateTopK, rerankConfig.topN) : baseCandidateTopK;
  const filter = defaultMemorySchema.getFilter(requestInput);
  const hasClientFilter = Boolean(filter || requestInput.categories?.length);
  const [queryVector] = await embedTexts(env, [defaultMemorySchema.getQueryText(requestInput)]);

  let rawMatches: ReturnType<typeof toQueryMatches> = [];
  try {
    const queryResult = await env.SEGMENTS_INDEX.query(queryVector, {
      topK: candidateTopK,
      namespace: requestInput.namespace,
      filter,
    });
    rawMatches = [...toQueryMatches(queryResult)];
  } catch (error) {
    if (!hasClientFilter) throw error;
  }

  // A filtered query only returns hits when Vectorize has a metadata index for
  // those properties. Fall back to an unfiltered query and let the D1-side
  // matchesFilter do the work — but merge, never replace: the filtered hits are
  // exactly the ones most likely to survive filtering, and dropping them made
  // recall worse than not falling back at all.
  const desiredCandidateCount = rerankConfig ? rerankConfig.topN : requestedTopK;
  const collectCandidates = async (vectorMatches: ReturnType<typeof toQueryMatches>): Promise<Array<{
    row: StoredMemoryRow;
    metadata: unknown;
    vectorScore: number | null;
  }>> => {
    const matches = vectorMatches
      .filter((match) => match && typeof match.id === "string")
      .map((match) => ({
        id: match.id,
        score: typeof match.score === "number" ? match.score : null,
        metadata: match.metadata ?? null,
      }));
    const rowsById = await fetchByIds(env.DB, requestInput.projectId, matches.map((match) => match.id));
    const candidates: Array<{
      row: StoredMemoryRow;
      metadata: unknown;
      vectorScore: number | null;
    }> = [];

    for (const match of matches) {
      const row = rowsById.get(match.id);
      if (!row) continue;

      const metadata = parseRowMetadata(row);
      if (!defaultMemorySchema.matchesFilter(row, metadata, requestInput)) continue;

      candidates.push({ row, metadata, vectorScore: match.score });
      if (candidates.length >= desiredCandidateCount) break;
    }
    return candidates;
  };

  let candidates = await collectCandidates(rawMatches);
  if (hasClientFilter && candidates.length < desiredCandidateCount) {
    const unfilteredResult = await env.SEGMENTS_INDEX.query(queryVector, {
      topK: candidateTopK,
      namespace: requestInput.namespace,
    });
    const seenIds = new Set(rawMatches.map((match) => match.id));
    for (const match of toQueryMatches(unfilteredResult)) {
      if (typeof match.id !== "string" || seenIds.has(match.id)) continue;
      seenIds.add(match.id);
      rawMatches.push(match);
    }
    rawMatches.sort((a, b) => (b.score ?? Number.NEGATIVE_INFINITY) - (a.score ?? Number.NEGATIVE_INFINITY));
    candidates = await collectCandidates(rawMatches);
  }

  if (candidates.length === 0) {
    return {
      ok: true,
      project_id: requestInput.projectId,
      namespace: requestInput.namespace,
      topK: requestedTopK,
      matches: [],
    };
  }

  if (!rerankConfig) {
    const enrichedMatches = candidates
      .slice(0, requestedTopK)
      .map(({ row, metadata, vectorScore }) => defaultMemorySchema.toSearchMatch(row, vectorScore, metadata));
    return {
      ok: true,
      project_id: requestInput.projectId,
      namespace: requestInput.namespace,
      topK: requestedTopK,
      matches: enrichedMatches,
    };
  }

  const query = defaultMemorySchema.getQueryText(requestInput);
  const contexts = candidates.map(({ row }) => ({
    text: truncateText(typeof row.text === "string" ? row.text : "", rerankConfig.maxChars),
  }));

  let rerankOutput: unknown;
  try {
    rerankOutput = await env.AI.run(rerankConfig.model as keyof AiModels, {
      query,
      top_k: candidates.length,
      contexts,
    } as never);
  } catch (error) {
    throw new Error(`Rerank failed: ${(error as Error).message}`);
  }

  const scoresByIndex = new Map<number, number>();
  for (const item of extractRerankResults(rerankOutput)) {
    if (item.id < 0 || item.id >= candidates.length) continue;
    scoresByIndex.set(item.id, item.score);
  }

  const reranked = candidates.map((candidate, index) => ({
    candidate,
    index,
    rerankScore: scoresByIndex.get(index) ?? null,
  }));

  reranked.sort((a, b) => {
    const scoreA = a.rerankScore ?? Number.NEGATIVE_INFINITY;
    const scoreB = b.rerankScore ?? Number.NEGATIVE_INFINITY;
    if (scoreA !== scoreB) return scoreB - scoreA;

    const vectorA = a.candidate.vectorScore ?? Number.NEGATIVE_INFINITY;
    const vectorB = b.candidate.vectorScore ?? Number.NEGATIVE_INFINITY;
    if (vectorA !== vectorB) return vectorB - vectorA;

    return a.index - b.index;
  });

  const enrichedMatches = reranked.slice(0, requestedTopK).map(({ candidate, rerankScore }) => {
    const score = rerankScore ?? candidate.vectorScore;
    const base = defaultMemorySchema.toSearchMatch(candidate.row, score, candidate.metadata);
    return {
      ...base,
      vector_score: candidate.vectorScore,
      rerank_score: rerankScore,
    };
  });

  return {
    ok: true,
    project_id: requestInput.projectId,
    namespace: requestInput.namespace,
    topK: requestedTopK,
    matches: enrichedMatches,
    rerank: {
      enabled: true,
      model: rerankConfig.model,
      topN: candidates.length,
    },
  };
}
