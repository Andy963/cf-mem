import { embedTexts } from "../ai/embedding";
import { fetchExistingHashes, upsertSegments } from "../db/d1";
import type { Env } from "../env";
import { chunkArray } from "../utils";
import { rawMemoryExpiresAt } from "./retention";
import type { PreparedIndexItem } from "./schema";

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
      const vectors = await embedTexts(
        env,
        batch.map((item) => item.text),
      );

      if (vectors.length !== batch.length) {
        throw new Error(`Embedding count mismatch. expected=${batch.length} actual=${vectors.length}`);
      }

      await env.SEGMENTS_INDEX.upsert(
        batch.map((item, index) => ({
          id: item.id,
          namespace: item.namespace,
          values: vectors[index],
          metadata: item.vectorMetadata,
        })),
      );

      try {
        await upsertSegments(env.DB, batch, now, rawMemoryExpiresAt(env, now));
      } catch (error) {
        // Vectors are written before their rows, so a D1 failure here orphans
        // them. Search still ignores orphans (fetchByIds finds no row), but they
        // keep consuming index quota until the same id is indexed again.
        console.error(`[index] D1 upsert failed after writing ${batch.length} vector(s) in project ${projectId}: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
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
