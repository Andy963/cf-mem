import { embedTexts } from "../ai/embedding";
import { fetchExistingHashes, upsertSegments } from "../db/d1";
import type { Env } from "../env";
import { chunkArray } from "../utils";
import { rawMemoryExpiresAt } from "./retention";
import type { PreparedIndexItem } from "./schema";
import { completeSegmentVectorJobs, ensureLatestSegmentVectorJobs } from "./segment-reconciliation";

const EMBEDDING_BATCH_SIZE = 32;

export interface MemoryIndexResult {
  ok: true;
  project_id: string;
  namespace: string;
  ids: string[];
  indexed: string[];
  skipped: string[];
  count: {
    total: number;
    indexed: number;
    skipped: number;
  };
}

/**
 * Retention is deliberately not run here. Quota enforcement scans every active
 * segment in the project (SUM over LENGTH plus an evidence join per row), which
 * is far too expensive to sit on the write path — the cron sweep in src/index.ts
 * already covers it, so quota now lags by at most one cron interval.
 */
export async function indexMemoryItems(env: Env, preparedItems: PreparedIndexItem[]): Promise<MemoryIndexResult> {
  if (preparedItems.length === 0) {
    throw new Error("No items to index");
  }
  const { projectId, namespace } = preparedItems[0];
  const now = Date.now();
  const existingHashes = await fetchExistingHashes(env.DB, projectId, preparedItems.map((item) => item.id));

  const itemsToUpsert = preparedItems.filter((item) => existingHashes.get(item.id) !== item.contentHash);
  const skippedItems = preparedItems.filter((item) => existingHashes.get(item.id) === item.contentHash);

  if (itemsToUpsert.length > 0) {
    for (const batch of chunkArray(itemsToUpsert, EMBEDDING_BATCH_SIZE)) {
      const durableBatch = batch.map((item) => ({ ...item, vectorOperationToken: crypto.randomUUID() }));
      const vectors = await embedTexts(
        env,
        durableBatch.map((item) => item.text),
      );

      if (vectors.length !== batch.length) {
        throw new Error(`Embedding count mismatch. expected=${batch.length} actual=${vectors.length}`);
      }

      await upsertSegments(env.DB, durableBatch, now, rawMemoryExpiresAt(env, now));

      await env.SEGMENTS_INDEX.upsert(
        durableBatch.map((item, index) => ({
          id: item.id,
          namespace: item.namespace,
          values: vectors[index],
          metadata: item.vectorMetadata,
        })),
      );
      const completed = await completeSegmentVectorJobs(env.DB, durableBatch, now);
      const staleItems = durableBatch.filter((item) => !completed.get(item.id));
      if (staleItems.length > 0) {
        await ensureLatestSegmentVectorJobs(env, staleItems);
        if (!env.SEGMENTS_INDEX.deleteByIds) throw new Error("SEGMENTS_INDEX deletion is unavailable");
        await env.SEGMENTS_INDEX.deleteByIds(staleItems.map((item) => item.id));
      }
    }
  }

  return {
    ok: true,
    project_id: projectId,
    namespace,
    ids: preparedItems.map((item) => item.id),
    indexed: itemsToUpsert.map((item) => item.id),
    skipped: skippedItems.map((item) => item.id),
    count: {
      total: preparedItems.length,
      indexed: itemsToUpsert.length,
      skipped: skippedItems.length,
    },
  };
}
