import type { D1Database } from "@cloudflare/workers-types";
import { describe, expect, it, vi } from "vitest";
import { ClaimDedupLockBusyError, withClaimDedupLock } from "../src/memory/claim-dedup";

interface RecordedStatement {
  sql: string;
  values: unknown[];
}

function createDatabase(changes: number[]): { db: D1Database; statements: RecordedStatement[] } {
  const statements: RecordedStatement[] = [];
  const db = {
    prepare(sql: string) {
      const statement: RecordedStatement = { sql, values: [] };
      statements.push(statement);
      return {
        bind(...values: unknown[]) {
          statement.values = values;
          return {
            async run() {
              return { meta: { changes: changes.shift() ?? 0 } };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  return { db, statements };
}

const claim = {
  scopeKind: "user" as const,
  scopeId: "user-1",
  category: "domain_fact" as const,
  type: "decision" as const,
  workspaceId: "workspace-1",
};

describe("withClaimDedupLock", () => {
  it("acquires once, runs the callback, and releases the lease", async () => {
    const { db, statements } = createDatabase([1, 0]);
    const callback = vi.fn(async () => "completed");

    await expect(withClaimDedupLock(db, "project-1", claim, callback)).resolves.toBe("completed");

    expect(callback).toHaveBeenCalledOnce();
    expect(statements).toHaveLength(2);
    expect(statements[0]?.sql).toContain("INSERT OR IGNORE");
    expect(statements[0]?.sql).toContain("category");
    expect(statements[0]?.values.slice(0, 6)).toEqual([
      "project-1",
      "user",
      "user-1",
      "domain_fact",
      "decision",
      "workspace-1",
    ]);
    expect(statements[1]?.sql).toContain("DELETE FROM memory_claim_dedup_locks");
  });

  it("fails fast when another lease is active", async () => {
    const { db, statements } = createDatabase([0, 0]);
    const callback = vi.fn(async () => "unreachable");

    await expect(withClaimDedupLock(db, "project-1", claim, callback)).rejects.toBeInstanceOf(ClaimDedupLockBusyError);

    expect(callback).not.toHaveBeenCalled();
    expect(statements).toHaveLength(2);
    expect(statements[0]?.sql).toContain("INSERT OR IGNORE");
    expect(statements[1]?.sql).toContain("lock_until <= ?");
  });

  it("keeps categories in separate lock identities", async () => {
    const { db, statements } = createDatabase([1, 0, 1, 0]);
    const ruleClaim = { ...claim, category: "rule" as const };

    await withClaimDedupLock(db, "project-1", claim, async () => undefined);
    await withClaimDedupLock(db, "project-1", ruleClaim, async () => undefined);

    expect(statements[0]?.values[3]).toBe("domain_fact");
    expect(statements[2]?.values[3]).toBe("rule");
  });
});
