import type { D1Database } from "@cloudflare/workers-types";
import { describe, expect, it } from "vitest";
import { fetchOwnerClaims } from "../src/db/d1";

interface RecordedStatement {
  sql: string;
  values: unknown[];
}

function createDatabase(statements: RecordedStatement[]): D1Database {
  return {
    prepare(sql: string) {
      const statement = { sql, values: [] as unknown[] };
      statements.push(statement);
      return {
        bind(...values: unknown[]) {
          statement.values = values;
          return {
            async all() {
              return { results: [] };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

describe("fetchOwnerClaims", () => {
  it("exposes project facts and decisions without exposing other users", async () => {
    const statements: RecordedStatement[] = [];

    await fetchOwnerClaims(createDatabase(statements), "project-1", "owner-1", 20, 10, "workspace-1");

    expect(statements).toHaveLength(2);
    for (const statement of statements) {
      expect(statement.sql).toContain("scope_kind = 'user' AND scope_id = ?");
      expect(statement.sql).toContain("scope_kind = 'project' AND scope_id = ?");
      expect(statement.sql).toContain("category IN ('rule', 'domain_fact') OR type = 'decision'");
      expect(statement.sql).toContain("category != 'tool_insight'");
      expect(statement.sql).not.toContain("scope_kind = 'user' AND scope_id != ?");
      expect(statement.values).toContain("owner-1");
      expect(statement.values).toContain("project-1");
      expect(statement.values).toContain("workspace-1");
    }
  });
});
