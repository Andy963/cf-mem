import type { D1Database } from "@cloudflare/workers-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredClaimRow } from "../src/db/d1";
import type { Env } from "../src/env";
import type { ClaimInput } from "../src/memory/claims";
import { readDedupConfig, resolveSemanticDuplicate } from "../src/memory/claim-dedup";

const mocks = vi.hoisted(() => ({
  embedTexts: vi.fn(),
  findVectorizedClaimMatches: vi.fn(),
}));

vi.mock("../src/ai/embedding", () => ({
  embedTexts: mocks.embedTexts,
}));

vi.mock("../src/memory/claim-index", async () => {
  const actual = await vi.importActual<typeof import("../src/memory/claim-index")>("../src/memory/claim-index");
  return {
    ...actual,
    findVectorizedClaimMatches: mocks.findVectorizedClaimMatches,
  };
});

interface RecordedStatement {
  sql: string;
  values: unknown[];
}

function createDatabase(rows: StoredClaimRow[]): { db: D1Database; statements: RecordedStatement[] } {
  const statements: RecordedStatement[] = [];
  const db = {
    prepare(sql: string) {
      const statement: RecordedStatement = { sql, values: [] };
      statements.push(statement);
      return {
        bind(...values: unknown[]) {
          statement.values = values;
          return {
            async all() {
              return { results: rows };
            },
            async first() {
              return undefined;
            },
            async run() {
              return { meta: { changes: 0 } };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  return { db, statements };
}

function createRuleClaim(overrides: Partial<StoredClaimRow> = {}): StoredClaimRow {
  return {
    id: "claim-rule-1",
    project_id: "project-1",
    scope_kind: "project",
    scope_id: "project-1",
    category: "rule",
    type: "instruction",
    subject: "testing.workflow",
    memory_key: "run_tests_before_commit",
    value_json: JSON.stringify("always"),
    canonical_text: "Run the test suite before every commit.",
    status: "active",
    provenance: "user_confirmed",
    confidence: 0.9,
    valid_from: null,
    valid_until: null,
    superseded_by: null,
    applicability: "global",
    workspace_id: null,
    use_count: 0,
    last_used_at: null,
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

function createIncomingClaim(overrides: Partial<ClaimInput> = {}): ClaimInput {
  return {
    scopeKind: "project",
    scopeId: "project-1",
    category: "rule",
    type: "preference",
    subject: "testing.workflow",
    memoryKey: "run_tests_before_commit",
    value: "always",
    canonicalText: "Run the test suite before every commit.",
    provenance: "user_confirmed",
    confidence: 0.9,
    validFrom: null,
    validUntil: null,
    evidenceSegmentIds: [],
    applicability: "global",
    workspaceId: null,
    ...overrides,
  };
}

function createEnv(db: D1Database): Env {
  return {
    DB: db,
    CLAIMS_INDEX: {},
    EXTRACTOR_LLM_API_BASE: "https://llm.example.com",
    EXTRACTOR_LLM_API_KEY: "key",
    EXTRACTOR_LLM_MODEL: "model",
  } as unknown as Env;
}

describe("resolveSemanticDuplicate cross-type matching", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.embedTexts.mockResolvedValue([[1, 0]]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reinforces an active instruction claim when the incoming rule uses type preference", async () => {
    const existing = createRuleClaim();
    const { db, statements } = createDatabase([existing]);
    const env = createEnv(db);
    mocks.findVectorizedClaimMatches.mockResolvedValue([{ id: existing.id, score: 0.97 }]);

    const action = await resolveSemanticDuplicate(env, db, "project-1", createIncomingClaim(), readDedupConfig(env));

    expect(action.kind).toBe("reinforce");
    if (action.kind !== "reinforce") return;
    expect(action.match.id).toBe(existing.id);
    expect(action.meta).toEqual({
      provider: "vector",
      matched_claim_id: existing.id,
      score: 0.97,
      verdict: "same",
    });

    expect(mocks.findVectorizedClaimMatches).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        filter: {
          status: "active",
          scope_kind: "project",
          scope_id: "project-1",
          category: "rule",
          workspace_id: "",
        },
      }),
    );
    expect(mocks.findVectorizedClaimMatches.mock.calls[0]?.[1].filter).not.toHaveProperty("type");

    const scopeQuery = statements.find((statement) => statement.sql.includes("FROM memory_claims"));
    expect(scopeQuery).toBeDefined();
    expect(scopeQuery?.sql).not.toContain("AND type = ?");
    expect(scopeQuery?.values).toEqual([
      "project-1",
      "project",
      "project-1",
      "rule",
      null,
      expect.any(Number),
      expect.any(Number),
    ]);
  });

  it("supersedes an active instruction claim when the judge returns update", async () => {
    const existing = createRuleClaim();
    const { db } = createDatabase([existing]);
    const env = createEnv(db);
    mocks.findVectorizedClaimMatches.mockResolvedValue([{ id: existing.id, score: 0.9 }]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ choices: [{ message: { content: '{"verdict":"update"}' } }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    )));

    const incoming = createIncomingClaim({
      value: "only_before_pushes",
      canonicalText: "Run the test suite before every push.",
    });
    const action = await resolveSemanticDuplicate(env, db, "project-1", incoming, readDedupConfig(env));

    expect(action.kind).toBe("replace");
    if (action.kind !== "replace") return;
    expect(action.match.id).toBe(existing.id);
    expect(action.meta.provider).toBe("llm");
    expect(action.meta.verdict).toBe("update");
  });
});
