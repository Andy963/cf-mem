import type { PreparedIndexItem, StoredMemoryRow } from "../memory/schema";
import { chunkArray } from "../utils";

// Keep one bind slot for project_id so D1 IN queries stay under the variable limit.
const D1_IN_QUERY_CHUNK_SIZE = 99;
const D1_BATCH_CHUNK_SIZE = 50;

export async function fetchExistingHashes(db: D1Database, projectId: string, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();

  const hashesById = new Map<string, string>();

  for (const chunk of chunkArray(ids, D1_IN_QUERY_CHUNK_SIZE)) {
    const placeholders = chunk.map(() => "?").join(",");
    const sql = `SELECT id, content_hash FROM memory_segments WHERE project_id = ? AND id IN (${placeholders})`;
    const result = await db.prepare(sql).bind(projectId, ...chunk).all();

    for (const row of result.results as Array<Record<string, unknown>>) {
      const id = row.id;
      const contentHash = row.content_hash;
      if (typeof id === "string" && typeof contentHash === "string") {
        hashesById.set(id, contentHash);
      }
    }
  }

  return hashesById;
}

export async function fetchByIds(db: D1Database, projectId: string, ids: string[]): Promise<Map<string, StoredMemoryRow>> {
  if (ids.length === 0) return new Map();

  const rowsById = new Map<string, StoredMemoryRow>();

  for (const chunk of chunkArray(ids, D1_IN_QUERY_CHUNK_SIZE)) {
    const placeholders = chunk.map(() => "?").join(",");
    const sql = `SELECT id, project_id, text, metadata_json, session_id, tape, created_at, updated_at FROM memory_segments WHERE project_id = ? AND id IN (${placeholders})`;
    const result = await db.prepare(sql).bind(projectId, ...chunk).all();

    for (const row of result.results as Array<Record<string, unknown>>) {
      const id = row.id;
      if (typeof id === "string") {
        rowsById.set(id, row as StoredMemoryRow);
      }
    }
  }

  return rowsById;
}

export async function upsertSegments(db: D1Database, items: PreparedIndexItem[], now: number): Promise<void> {
  if (items.length === 0) return;

  const statements = items.map((item) =>
    db.prepare(
      "INSERT INTO memory_segments (id, project_id, text, content_hash, metadata_json, session_id, tape, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id, text=excluded.text, content_hash=excluded.content_hash, metadata_json=excluded.metadata_json, session_id=excluded.session_id, tape=excluded.tape, updated_at=excluded.updated_at",
    ).bind(item.id, item.projectId, item.text, item.contentHash, item.metadataJson, item.sessionId, item.tape, now, now),
  );

  for (const statementBatch of chunkArray(statements, D1_BATCH_CHUNK_SIZE)) {
    await db.batch(statementBatch);
  }
}
