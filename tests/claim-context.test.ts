import type { D1Database } from "@cloudflare/workers-types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleMemoryRequest } from "../src/api/memory";
import type { StoredClaimRow } from "../src/db/d1";
import type { Env } from "../src/env";
import { loadMemoryContext, recordClaimUsage } from "../src/memory/claim-store";

const mocks = vi.hoisted(() => ({
  fetchClaimsByIds: vi.fn(),
  fetchContextClaims: vi.fn(),
  fetchEvidenceByClaimIds: vi.fn(),
  fetchGlobalProfileClaims: vi.fn(),
  fetchWorkspaceProfileClaims: vi.fn(),
  findVectorizedClaimMatches: vi.fn(),
}));

vi.mock("../src/db/d1", async () => {
  const actual = await vi.importActual<typeof import("../src/db/d1")>("../src/db/d1");
  return {
    ...actual,
    fetchClaimsByIds: mocks.fetchClaimsByIds,
    fetchContextClaims: mocks.fetchContextClaims,
    fetchEvidenceByClaimIds: mocks.fetchEvidenceByClaimIds,
    fetchGlobalProfileClaims: mocks.fetchGlobalProfileClaims,
    fetchWorkspaceProfileClaims: mocks.fetchWorkspaceProfileClaims,
  };
});

vi.mock("../src/memory/claim-index", async () => {
  const actual = await vi.importActual<typeof import("../src/memory/claim-index")>("../src/memory/claim-index");
  return {
    ...actual,
    findVectorizedClaimMatches: mocks.findVectorizedClaimMatches,
  };
});

function createClaim(id: string): StoredClaimRow {
  return {
    id,
    project_id: "project-1",
    scope_kind: "project",
    scope_id: "project-1",
    category: "domain_fact",
    type: "decision",
    subject: id,
    memory_key: id,
    value_json: JSON.stringify({ value: id }),
    canonical_text: `The project has claim ${id}.`,
    status: "active",
    provenance: "user_confirmed",
    confidence: 1,
    valid_from: null,
    valid_until: null,
    superseded_by: null,
    applicability: "semantic",
    workspace_id: null,
    use_count: 0,
    last_used_at: null,
    created_at: 1,
    updated_at: 1,
  };
}

describe("loadMemoryContext semantic retrieval", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findVectorizedClaimMatches.mockResolvedValue([
      { id: "claim-1", score: 0.91 },
      { id: "claim-2", score: 0.85 },
      { id: "claim-3", score: 0.8 },
    ]);
    mocks.fetchClaimsByIds.mockResolvedValue(new Map(
      ["claim-1", "claim-2", "claim-3"].map((id) => [id, createClaim(id)]),
    ));
    mocks.fetchContextClaims.mockResolvedValue([]);
    mocks.fetchEvidenceByClaimIds.mockResolvedValue(new Map());
    mocks.fetchGlobalProfileClaims.mockResolvedValue([]);
    mocks.fetchWorkspaceProfileClaims.mockResolvedValue([]);
  });

  it("does not re-embed D1 candidates when Vectorize returns fewer matches than the limit", async () => {
    const ai = {
      run: vi.fn(async () => ({ data: [[1, 0]] })),
    } as unknown as Ai;
    const db = {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({
          run: vi.fn(async () => ({ meta: { changes: 3 } })),
        })),
      })),
    } as unknown as D1Database;
    const env = {
      AI: ai,
      DB: db,
      SEGMENTS_INDEX: {},
      CLAIMS_INDEX: {},
    } as unknown as Env;
    const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;

    const result = await loadMemoryContext(
      env,
      { projectId: "project-1", namespace: "project:project-1" },
      {
        userId: null,
        sessionId: null,
        query: "What durable claims does this project have?",
        types: null,
        categories: ["domain_fact"],
        scopeId: null,
        limit: 20,
        workspaceId: null,
        profileOnly: false,
      },
      ctx,
    );

    expect(result.claims).toHaveLength(3);
    expect(ai.run).toHaveBeenCalledOnce();
    expect(mocks.fetchContextClaims).not.toHaveBeenCalled();
    expect(mocks.fetchClaimsByIds).toHaveBeenCalled();
  });

  it("returns project facts for a different user identity", async () => {
    const env = {
      AI: { run: vi.fn(async () => ({ data: [[1, 0]] })) } as unknown as Ai,
      DB: {} as D1Database,
      SEGMENTS_INDEX: {},
      CLAIMS_INDEX: {},
    } as unknown as Env;
    const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;

    const result = await loadMemoryContext(
      env,
      { projectId: "project-1", namespace: "project:project-1" },
      {
        userId: "different-user",
        sessionId: null,
        query: "Which architectural decision does this project use?",
        types: ["decision"],
        categories: ["domain_fact"],
        scopeId: null,
        limit: 5,
        workspaceId: null,
        profileOnly: false,
      },
      ctx,
    );

    expect(result.claims).toHaveLength(3);
    expect(result.claims.every((claim) => claim.scope_kind === "project")).toBe(true);
  });

  it("does not return another user's profile claims", async () => {
    const env = {
      DB: {} as D1Database,
      SEGMENTS_INDEX: {},
      CLAIMS_INDEX: {},
    } as unknown as Env;
    const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;

    const result = await loadMemoryContext(
      env,
      { projectId: "project-1", namespace: "project:project-1" },
      {
        userId: "different-user",
        sessionId: null,
        query: null,
        types: null,
        categories: ["user_profile"],
        scopeId: null,
        limit: 5,
        workspaceId: null,
        profileOnly: false,
      },
      ctx,
    );

    expect(result.claims).toEqual([]);
    expect(mocks.fetchGlobalProfileClaims).toHaveBeenCalledWith(
      env.DB,
      "project-1",
      "different-user",
      5,
      "user_profile",
      null,
    );
  });

  it("returns before the usage update completes and keeps the update in waitUntil", async () => {
    const claimIds = ["claim-usage-1", "claim-usage-2", "claim-usage-3"];
    mocks.findVectorizedClaimMatches.mockResolvedValue(claimIds.map((id, index) => ({
      id,
      score: 0.91 - index * 0.05,
    })));
    mocks.fetchClaimsByIds.mockResolvedValue(new Map(claimIds.map((id) => [id, createClaim(id)])));

    let releaseUsageUpdate!: () => void;
    const usageUpdate = new Promise<{ meta: { changes: number } }>((resolve) => {
      releaseUsageUpdate = () => resolve({ meta: { changes: claimIds.length } });
    });
    const run = vi.fn(() => usageUpdate);
    const db = {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({ run })),
      })),
    } as unknown as D1Database;
    const ai = {
      run: vi.fn(async () => ({ data: [[1, 0]] })),
    } as unknown as Ai;
    const env = {
      AI: ai,
      DB: db,
      SEGMENTS_INDEX: {},
      CLAIMS_INDEX: {},
    } as unknown as Env;
    const backgroundPromises: Promise<void>[] = [];
    const waitUntil = vi.fn((promise: Promise<void>) => {
      backgroundPromises.push(promise);
    });
    const ctx = { waitUntil } as unknown as ExecutionContext;
    const request = new Request(
      "https://example.com/memory/context?categories=domain_fact&query=What%20claims%20does%20this%20project%20have%3F&limit=20",
    );
    const responsePromise = handleMemoryRequest(
      request,
      env,
      { projectId: "project-1", namespace: "project:project-1" },
      ctx,
    );
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const responseOrTimeout = await Promise.race([
      responsePromise,
      new Promise<"timed-out">((resolve) => {
        timeoutHandle = setTimeout(() => resolve("timed-out"), 100);
      }),
    ]);
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);

    expect(responseOrTimeout).not.toBe("timed-out");
    expect(responseOrTimeout).toBeInstanceOf(Response);
    const response = responseOrTimeout as Response;
    const body = await response.json() as { claims: unknown[] };
    expect(body.claims).toHaveLength(claimIds.length);
    expect(waitUntil).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledOnce();
    expect(backgroundPromises).toHaveLength(1);

    releaseUsageUpdate();
    await backgroundPromises[0];
  });

  it("uses the durable last-used timestamp to debounce usage across requests", async () => {
    const now = 1_700_000_000_000;
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(now);
    let useCount = 0;
    let lastUsedAt: number | null = null;
    const statements: Array<{ sql: string; values: unknown[] }> = [];
    const db = {
      prepare(sql: string) {
        const statement = { sql, values: [] as unknown[] };
        statements.push(statement);
        return {
          bind(...values: unknown[]) {
            statement.values = values;
            return {
              async run() {
                const timestamp = Number(values[0]);
                const cutoff = Number(values[values.length - 1]);
                if (lastUsedAt === null || lastUsedAt <= cutoff) {
                  useCount += 1;
                  lastUsedAt = timestamp;
                  return { meta: { changes: 1 } };
                }
                return { meta: { changes: 0 } };
              },
            };
          },
        };
      },
    } as unknown as D1Database;
    const env = { DB: db } as unknown as Env;

    try {
      await recordClaimUsage(env, "project-1", ["claim-usage-1", "claim-usage-1"]);
      await recordClaimUsage(env, "project-1", ["claim-usage-1"]);
    } finally {
      dateNow.mockRestore();
    }

    expect(statements).toHaveLength(2);
    expect(statements[0]?.sql).toContain("last_used_at IS NULL OR last_used_at <= ?");
    expect(statements[0]?.values).toEqual([
      now,
      "project-1",
      "claim-usage-1",
      now - 10 * 60 * 1000,
    ]);
    expect(useCount).toBe(1);
    expect(lastUsedAt).toBe(now);
  });
});
