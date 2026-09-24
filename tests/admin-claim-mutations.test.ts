import type { D1Database } from "@cloudflare/workers-types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleAdminRequest } from "../src/admin";
import type { StoredClaimRow } from "../src/db/d1";
import type { Env } from "../src/env";

interface BoundStatement {
  sql: string;
  values: unknown[];
}

class RecordingDatabase {
  readonly batches: BoundStatement[][] = [];
  readonly runCalls: BoundStatement[] = [];
  failBatchIndex: number | null = null;
  existingTag: string | null = null;

  constructor(readonly claim: StoredClaimRow | null) {}

  prepare(sql: string) {
    const values: unknown[] = [];
    const statement = {
      sql,
      values,
      bind(...nextValues: unknown[]) {
        values.push(...nextValues);
        return this;
      },
      async first<T>() {
        if (sql.includes("FROM memory_claims")) return (statement as { claim?: T }).claim ?? null;
        if (sql.includes("SELECT tag FROM memory_claim_tags")) {
          return (statement as { existingTag?: string }).existingTag
            ? ({ tag: statement.existingTag } as T)
            : null;
        }
        return null;
      },
      async all<T>() {
        return { results: [] as T[], success: true, meta: {} };
      },
      async run() {
        (statement as { runCalls?: BoundStatement[] }).runCalls?.push(statement);
        return { success: true, meta: { changes: 1 } };
      },
    };
    Object.assign(statement, { claim: this.claim, existingTag: this.existingTag, runCalls: this.runCalls });
    return statement;
  }

  async batch(statements: Array<{ sql: string; values: unknown[] }>) {
    const bound = statements.map((statement) => ({ sql: statement.sql, values: [...statement.values] }));
    this.batches.push(bound);
    if (this.failBatchIndex !== null && this.failBatchIndex < bound.length) {
      throw new Error("injected batch failure");
    }
    return bound.map(() => ({ success: true, meta: { changes: 1 } }));
  }
}

function createClaim(overrides: Partial<StoredClaimRow> = {}): StoredClaimRow {
  return {
    id: "claim-1",
    project_id: "project-1",
    scope_kind: "project",
    scope_id: "project-1",
    category: "domain_fact",
    type: "decision",
    subject: "subject",
    memory_key: "key",
    value_json: JSON.stringify({ value: "before" }),
    canonical_text: "Before",
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
    ...overrides,
  };
}

function createEnvironment(database: RecordingDatabase): Env {
  return {
    DB: database as unknown as D1Database,
    SEGMENTS_INDEX: {} as Env["SEGMENTS_INDEX"],
    ADMIN_ALLOWED_EMAIL: "admin@example.com",
  };
}

function createRequest(method: string, path: string, body?: unknown): Request {
  return new Request(`https://cf-mem.test${path}`, {
    method,
    headers: {
      "Cf-Access-Authenticated-User-Email": "admin@example.com",
      Origin: "https://cf-mem.test",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function send(
  database: RecordingDatabase,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return handleAdminRequest(createRequest(method, path, body), createEnvironment(database));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("admin claim atomic mutations", () => {
  it("batches claim edits with one audit record", async () => {
    const database = new RecordingDatabase(createClaim());
    const response = await send(database, "PUT", "/admin/api/claims/claim-1", {
      canonical_text: "After",
      value: { value: "after" },
      reason: "corrected",
    });

    expect(response.status).toBe(200);
    expect(database.batches).toHaveLength(1);
    expect(database.batches[0].map((statement) => statement.sql)).toEqual([
      expect.stringContaining("UPDATE memory_claims"),
      expect.stringContaining("INSERT INTO memory_claim_audit_log"),
    ]);
    expect(database.batches[0][1].values[3]).toBe("edit");
    expect(database.runCalls).toHaveLength(0);
  });

  it("batches retraction with one audit record", async () => {
    const database = new RecordingDatabase(createClaim());
    const response = await send(database, "POST", "/admin/api/claims/claim-1/retract", { reason: "invalid" });

    expect(response.status).toBe(200);
    expect(database.batches[0]).toHaveLength(2);
    expect(database.batches[0][1].values[3]).toBe("retract");
  });

  it.each([
    { method: "POST", path: "/admin/api/claims/claim-1/tags", body: { tag: "backend" }, existingTag: null, action: "tag_add" },
    { method: "DELETE", path: "/admin/api/claims/claim-1/tags/backend", body: {}, existingTag: "backend", action: "tag_remove" },
  ])("batches $action with one audit record", async ({ method, path, body, existingTag, action }) => {
    const database = new RecordingDatabase(createClaim());
    database.existingTag = existingTag;
    const response = await send(database, method, path, body);

    expect(response.status).toBe(200);
    expect(database.batches[0]).toHaveLength(2);
    expect(database.batches[0][1].values[3]).toBe(action);
  });

  it("preserves audit history and records deletion in the same batch", async () => {
    const database = new RecordingDatabase(createClaim());
    const response = await send(database, "DELETE", "/admin/api/claims/claim-1", { reason: "cleanup" });

    expect(response.status).toBe(200);
    expect(database.batches[0].map((statement) => statement.sql)).toEqual([
      expect.stringContaining("DELETE FROM memory_claim_tags"),
      expect.stringContaining("DELETE FROM memory_evidence"),
      expect.stringContaining("INSERT INTO memory_claim_audit_log"),
      expect.stringContaining("DELETE FROM memory_claims"),
    ]);
    expect(database.batches[0][2].values[3]).toBe("delete");
    expect(JSON.parse(String(database.batches[0][2].values[6])).status).toBe("active");
  });

  it.each([
    { name: "edit", method: "PUT", path: "/admin/api/claims/claim-1", body: { canonical_text: "After", value: { value: "after" } }, length: 2 },
    { name: "retract", method: "POST", path: "/admin/api/claims/claim-1/retract", body: {}, length: 2 },
    { name: "tag add", method: "POST", path: "/admin/api/claims/claim-1/tags", body: { tag: "backend" }, length: 2 },
    { name: "tag remove", method: "DELETE", path: "/admin/api/claims/claim-1/tags/backend", body: {}, length: 2, existingTag: "backend" },
    { name: "delete tags", method: "DELETE", path: "/admin/api/claims/claim-1", body: {}, length: 4 },
    { name: "delete evidence", method: "DELETE", path: "/admin/api/claims/claim-1", body: {}, length: 4, failAt: 1 },
    { name: "delete audit", method: "DELETE", path: "/admin/api/claims/claim-1", body: {}, length: 4, failAt: 2 },
    { name: "delete claim", method: "DELETE", path: "/admin/api/claims/claim-1", body: {}, length: 4, failAt: 3 },
  ])("keeps $name atomic when a batch statement fails", async ({ method, path, body, length, failAt, existingTag }) => {
    const database = new RecordingDatabase(createClaim());
    database.existingTag = existingTag ?? null;
    database.failBatchIndex = failAt ?? length - 1;
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const response = await send(database, method, path, body);

    expect(response.status).toBe(400);
    expect(database.batches).toHaveLength(1);
    expect(database.batches[0]).toHaveLength(length);
    expect(database.runCalls).toHaveLength(0);
  });

  it("treats completed retries as no-op", async () => {
    const editDatabase = new RecordingDatabase(createClaim({ canonical_text: "Same", value_json: JSON.stringify({ value: "same" }) }));
    const tagAddDatabase = new RecordingDatabase(createClaim());
    tagAddDatabase.existingTag = "backend";
    const tagRemoveDatabase = new RecordingDatabase(createClaim());
    const retractDatabase = new RecordingDatabase(createClaim({ status: "retracted" }));
    const deletedDatabase = new RecordingDatabase(null);

    const responses = await Promise.all([
      send(editDatabase, "PUT", "/admin/api/claims/claim-1", { canonical_text: "Same", value: { value: "same" } }),
      send(tagAddDatabase, "POST", "/admin/api/claims/claim-1/tags", { tag: "backend" }),
      send(tagRemoveDatabase, "DELETE", "/admin/api/claims/claim-1/tags/backend", {}),
      send(retractDatabase, "POST", "/admin/api/claims/claim-1/retract", {}),
      send(deletedDatabase, "DELETE", "/admin/api/claims/claim-1", {}),
    ]);

    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200, 200]);
    expect(editDatabase.batches).toHaveLength(0);
    expect(tagAddDatabase.batches).toHaveLength(0);
    expect(tagRemoveDatabase.batches).toHaveLength(0);
    expect(retractDatabase.batches).toHaveLength(0);
    expect(deletedDatabase.batches).toHaveLength(0);
  });
});
