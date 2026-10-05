import type { D1Database } from "@cloudflare/workers-types";
import { describe, expect, it, vi } from "vitest";
import { fetchOwnerClaims, type StoredClaimRow } from "../src/db/d1";

interface RecordedStatement {
  sql: string;
  values: unknown[];
}

function createClaim(overrides: Partial<StoredClaimRow>): StoredClaimRow {
  return {
    id: "claim",
    project_id: "project-1",
    scope_kind: "project",
    scope_id: "project-1",
    category: "domain_fact",
    type: "decision",
    subject: "subject",
    memory_key: "memory-key",
    value_json: JSON.stringify({ value: "claim" }),
    canonical_text: "A durable claim.",
    status: "active",
    provenance: "user_confirmed",
    confidence: 0.8,
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

function createDatabase(statements: RecordedStatement[], rows: StoredClaimRow[]): D1Database {
  return {
    prepare(sql: string) {
      const statement = { sql, values: [] as unknown[] };
      statements.push(statement);
      return {
        bind(...values: unknown[]) {
          statement.values = values;
          return {
            async all() {
              const activeOnly = sql.includes("status = 'active'");
              const workspaceId = values.find((value) => typeof value === "string" && value.startsWith("workspace-"));
              return {
                results: rows.filter((row) => {
                  if ((row.status === "active") !== activeOnly) return false;
                  if (row.project_id !== values[0]) return false;
                  if (row.workspace_id !== null && row.workspace_id !== workspaceId) return false;
                  if (row.category === "tool_insight") return row.scope_kind === "user";
                  if (row.scope_kind === "user") return row.scope_id === values[1];
                  return row.scope_kind === "project" && row.scope_id === values[2 + (workspaceId ? 2 : 0)];
                }),
              };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

describe("fetchOwnerClaims", () => {
  it("returns visible tool insights and binds workspace scopes in order", async () => {
    const statements: RecordedStatement[] = [];
    const now = 1_700_000_000_000;
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(now);
    const rows = [
      createClaim({ id: "tool-global", scope_kind: "user", scope_id: "wrangler", category: "tool_insight" }),
      createClaim({ id: "tool-workspace", scope_kind: "user", scope_id: "alipan", category: "tool_insight", workspace_id: "workspace-1" }),
      createClaim({ id: "tool-other-workspace", scope_kind: "user", scope_id: "quark", category: "tool_insight", workspace_id: "workspace-2" }),
      createClaim({ id: "owner-claim", scope_kind: "user", scope_id: "owner-1", category: "rule", workspace_id: "workspace-1" }),
      createClaim({ id: "other-user-claim", scope_kind: "user", scope_id: "owner-2", category: "domain_fact" }),
      createClaim({ id: "project-claim", scope_kind: "project", scope_id: "project-1" }),
    ];

    try {
      const claims = await fetchOwnerClaims(
        createDatabase(statements, rows),
        "project-1",
        "owner-1",
        20,
        10,
        "workspace-1",
      );

      expect(claims.map((claim) => claim.id)).toEqual([
        "tool-global",
        "tool-workspace",
        "owner-claim",
        "project-claim",
      ]);
      expect(claims.some((claim) => claim.id === "tool-other-workspace")).toBe(false);
      expect(claims.some((claim) => claim.id === "other-user-claim")).toBe(false);
      expect(statements).toHaveLength(2);
      for (const statement of statements) {
        expect(statement.sql).toContain("category = 'tool_insight'");
        expect(statement.sql).toContain("COALESCE(workspace_id, '') = '' OR workspace_id = ?");
      }
      expect(statements[0]?.values).toEqual([
        "project-1",
        "owner-1",
        "workspace-1",
        "workspace-1",
        "project-1",
        "workspace-1",
        now,
        now,
        20,
      ]);
      expect(statements[1]?.values).toEqual([
        "project-1",
        "owner-1",
        "workspace-1",
        "workspace-1",
        "project-1",
        "workspace-1",
        10,
      ]);
    } finally {
      dateNow.mockRestore();
    }
  });
});
