import type { D1Database } from "@cloudflare/workers-types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env, VectorizeIndex } from "../src/env";
import { indexMemoryItems } from "../src/memory/indexer";
import type { PreparedIndexItem } from "../src/memory/schema";
import { cleanupOrphanSegmentVectors, ensureLatestSegmentVectorJobs, runSegmentVectorReconciliation } from "../src/memory/segment-reconciliation";
import { upsertSegments } from "../src/db/d1";
import { completeSegmentVectorJobs } from "../src/memory/segment-reconciliation";

vi.mock("../src/ai/embedding", () => ({ embedTexts: vi.fn(async () => [[0.1, 0.2]]) }));
vi.mock("../src/db/d1", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/db/d1")>();
  return { ...original, fetchExistingHashes: vi.fn(async () => new Map()), upsertSegments: vi.fn(async () => undefined) };
});
vi.mock("../src/memory/segment-reconciliation", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/memory/segment-reconciliation")>();
  return {
    ...original,
    completeSegmentVectorJobs: vi.fn(async (_db: D1Database, items: PreparedIndexItem[]) =>
      new Map(items.map((item) => [item.id, true]))),
    ensureLatestSegmentVectorJobs: vi.fn(async () => undefined),
  };
});

function createItem(): PreparedIndexItem {
  return {
    item: { id: "project:project-1:seg-1", text: "durable text", metadata: { project_id: "project-1" } },
    id: "project:project-1:seg-1",
    text: "durable text",
    contentHash: "hash-1",
    metadataJson: JSON.stringify({ project_id: "project-1" }),
    projectId: "project-1",
    namespace: "project:project-1",
    sessionId: null,
    tape: null,
    vectorMetadata: { project_id: "project-1" },
  };
}

function createEnv(): Env {
  const upsert = vi.fn(async () => undefined);
  const deleteByIds = vi.fn(async () => undefined);
  return {
    AI: {} as Env["AI"],
    DB: {} as D1Database,
    SEGMENTS_INDEX: { upsert, deleteByIds } as unknown as VectorizeIndex,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("segment index outbox ordering", () => {
  it("writes D1 before Vectorize and completes the matching job", async () => {
    const env = createEnv();
    const upsertMock = vi.mocked(upsertSegments);
    const completeMock = vi.mocked(completeSegmentVectorJobs);
    const result = await indexMemoryItems(env, [createItem()]);

    expect(result.indexed).toEqual(["project:project-1:seg-1"]);
    expect(upsertMock).toHaveBeenCalledOnce();
    expect(env.SEGMENTS_INDEX.upsert).toHaveBeenCalledOnce();
    expect(completeMock).toHaveBeenCalledOnce();
    expect(upsertMock.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(env.SEGMENTS_INDEX.upsert).mock.invocationCallOrder[0]);
    expect(vi.mocked(env.SEGMENTS_INDEX.upsert).mock.invocationCallOrder[0]).toBeLessThan(completeMock.mock.invocationCallOrder[0]);
  });

  it("does not write Vectorize when the D1 segment transaction fails", async () => {
    const env = createEnv();
    vi.mocked(upsertSegments).mockRejectedValueOnce(new Error("d1 unavailable"));

    await expect(indexMemoryItems(env, [createItem()])).rejects.toThrow("d1 unavailable");
    expect(env.SEGMENTS_INDEX.upsert).not.toHaveBeenCalled();
    expect(completeSegmentVectorJobs).not.toHaveBeenCalled();
  });

  it("leaves the durable job for reconciliation when Vectorize fails", async () => {
    const env = createEnv();
    vi.mocked(env.SEGMENTS_INDEX.upsert).mockRejectedValueOnce(new Error("vector unavailable"));

    await expect(indexMemoryItems(env, [createItem()])).rejects.toThrow("vector unavailable");
    expect(upsertSegments).toHaveBeenCalledOnce();
    expect(completeSegmentVectorJobs).not.toHaveBeenCalled();
  });

  it("deletes its vector and requeues latest state when completion is fenced", async () => {
    const env = createEnv();
    vi.mocked(completeSegmentVectorJobs).mockResolvedValueOnce(new Map([["project:project-1:seg-1", false]]));

    await indexMemoryItems(env, [createItem()]);

    expect(env.SEGMENTS_INDEX.deleteByIds).toHaveBeenCalledWith(["project:project-1:seg-1"]);
    expect(ensureLatestSegmentVectorJobs).toHaveBeenCalledOnce();
  });
});

function reconciliationDatabase(options: { row?: Record<string, unknown> | null; jobRevision?: number; completionChanges?: number } = {}) {
  const state = {
    upsertCalls: [] as unknown[][],
    deleteCalls: [] as string[][],
    statements: [] as Array<{ sql: string; values: unknown[] }>,
  };
  const job = {
    project_id: "project-1",
    segment_id: "project:project-1:seg-1",
    revision: options.jobRevision ?? 1,
    operation: "upsert" as const,
    segment_updated_at: 10,
    status: "pending" as const,
    attempt_count: 0,
    next_attempt_at: 0,
    lease_token: null as string | null,
    lease_expires_at: null as number | null,
    updated_at: 1,
  };
  const database = {
    prepare(sql: string) {
      const values: unknown[] = [];
      return {
        bind(...nextValues: unknown[]) {
          values.push(...nextValues);
          return this;
        },
        async all<T>() {
          if (sql.includes("FROM memory_segment_vector_jobs")) return { results: [job] as T[], success: true, meta: {} };
          if (sql.includes("FROM memory_segments")) return { results: options.row ? [options.row as T] : [], success: true, meta: {} };
          return { results: [] as T[], success: true, meta: {} };
        },
        async first<T>() {
          if (sql.includes("WHERE project_id = ? AND segment_id = ? AND lease_token = ?")) {
            return { ...job, status: "processing", lease_token: String(values[2]) } as T;
          }
          return null;
        },
        async run() {
          state.statements.push({ sql, values: [...values] });
          return { success: true, meta: { changes: sql.startsWith("DELETE FROM memory_segment_vector_jobs") ? (options.completionChanges ?? 1) : 1 } };
        },
      };
    },
    async batch() { return []; },
  };
  return { database, state, job };
}

describe("segment vector reconciliation", () => {
  it("retries the latest segment and completes its leased job", async () => {
    const { database } = reconciliationDatabase({
      row: {
        id: "project:project-1:seg-1",
        project_id: "project-1",
        text: "durable text",
        metadata_json: "{}",
        session_id: null,
        tape: null,
        updated_at: 10,
      },
    });
    const env = { ...createEnv(), DB: database as unknown as D1Database };

    await runSegmentVectorReconciliation(env);

    expect(env.SEGMENTS_INDEX.upsert).toHaveBeenCalledOnce();
  });

  it("skips a stale revision without touching Vectorize", async () => {
    const { database } = reconciliationDatabase({
      row: {
        id: "project:project-1:seg-1",
        project_id: "project-1",
        text: "new text",
        metadata_json: "{}",
        session_id: null,
        tape: null,
        updated_at: 11,
      },
    });
    const env = { ...createEnv(), DB: database as unknown as D1Database };

    await runSegmentVectorReconciliation(env);

    expect(env.SEGMENTS_INDEX.upsert).not.toHaveBeenCalled();
    expect(env.SEGMENTS_INDEX.deleteByIds).not.toHaveBeenCalled();
  });

  it("deletes vectors for deletion jobs", async () => {
    const { database, job } = reconciliationDatabase({ row: null });
    job.operation = "delete";
    const env = { ...createEnv(), DB: database as unknown as D1Database };

    await runSegmentVectorReconciliation(env);

    expect(env.SEGMENTS_INDEX.deleteByIds).toHaveBeenCalledWith(["project:project-1:seg-1"]);
  });

  it("removes a stale vector and requeues when the job revision changed", async () => {
    const { database, state } = reconciliationDatabase({
      row: {
        id: "project:project-1:seg-1", project_id: "project-1", text: "durable text",
        metadata_json: "{}", session_id: null, tape: null, updated_at: 10,
      },
      completionChanges: 0,
    });
    const env = { ...createEnv(), DB: database as unknown as D1Database };

    await runSegmentVectorReconciliation(env);

    expect(env.SEGMENTS_INDEX.upsert).toHaveBeenCalledOnce();
    expect(env.SEGMENTS_INDEX.deleteByIds).toHaveBeenCalledWith(["project:project-1:seg-1"]);
    expect(state.statements.some((statement) =>
      statement.sql.includes("INSERT INTO memory_segment_vector_jobs") &&
      statement.sql.includes("excluded.segment_updated_at >= memory_segment_vector_jobs.segment_updated_at"),
    )).toBe(true);
  });
});

describe("atomic segment requeue", () => {
  it("uses one monotonic INSERT SELECT without a prior read", async () => {
    const actual = await vi.importActual<typeof import("../src/memory/segment-reconciliation")>("../src/memory/segment-reconciliation");
    const statements: Array<{ sql: string; values: unknown[] }> = [];
    const database = {
      prepare(sql: string) {
        const statement = {
          sql,
          values: [] as unknown[],
          bind(...values: unknown[]) {
            statement.values.push(...values);
            return statement;
          },
          async run() {
            statements.push(statement);
            return { success: true, meta: { changes: 1 } };
          },
          async first() {
            throw new Error("requeue must not read before writing");
          },
        };
        return statement;
      },
    };
    const env = { ...createEnv(), DB: database as unknown as D1Database };

    await actual.ensureLatestSegmentVectorJobs(env, [createItem()]);

    expect(statements).toHaveLength(1);
    expect(statements[0].sql).toContain("INSERT INTO memory_segment_vector_jobs");
    expect(statements[0].sql).toContain("SELECT");
    expect(statements[0].sql).toContain("excluded.segment_updated_at >= memory_segment_vector_jobs.segment_updated_at");
  });
});

describe("historical orphan cleanup", () => {
  it("reports by default and deletes only bounded orphan ids when applied", async () => {
    const database = {
      prepare() {
        return {
          bind() { return this; },
          async all<T>() { return { results: [{ id: "active" }] as T[], success: true, meta: {} }; },
        };
      },
    };
    const env = { ...createEnv(), DB: database as unknown as D1Database };

    const report = await cleanupOrphanSegmentVectors(env, ["active", "orphan"], false);
    expect(report).toEqual({ checked: 2, orphans: ["orphan"], deleted: 0, dry_run: true });
    expect(env.SEGMENTS_INDEX.deleteByIds).not.toHaveBeenCalled();

    const applied = await cleanupOrphanSegmentVectors(env, ["active", "orphan"], true);
    expect(applied.deleted).toBe(1);
    expect(env.SEGMENTS_INDEX.deleteByIds).toHaveBeenCalledWith(["orphan"]);
  });
});
