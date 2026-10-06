import { describe, expect, it } from "vitest";
import { replaceActiveClaim } from "../src/db/d1";
import type { ClaimInput } from "../src/memory/claims";

function fakeDb(changes: number) {
  const statements: string[] = [];
  let batchCalls = 0;
  const db = {
    prepare(sql: string) {
      statements.push(sql);
      return {
        bind: (..._args: unknown[]) => ({
          run: async () => ({ meta: { changes } }),
        }),
      };
    },
    batch: async (_statements: unknown[]) => {
      batchCalls += 1;
    },
  };
  return {
    db: db as unknown as D1Database,
    statements,
    batchCalls: () => batchCalls,
  };
}

const claim: ClaimInput = {
  scopeKind: "user",
  scopeId: "owner-1",
  category: "rule",
  type: "instruction",
  subject: "guidance",
  memoryKey: "guidance",
  value: { value: "v2" },
  canonicalText: "Guidance v2.",
  provenance: "user_confirmed",
  confidence: 0.9,
  validFrom: null,
  validUntil: null,
  evidenceSegmentIds: ["seg-1"],
  applicability: "global",
  workspaceId: null,
};

describe("replaceActiveClaim", () => {
  it("clamps valid_until to the mutation timestamp when superseding", async () => {
    const { db, statements, batchCalls } = fakeDb(1);

    await replaceActiveClaim(db, "project-1", "claim-prev", "claim-next", claim, 1_700_000_000_000);

    expect(statements[0]).toContain("valid_until = ?");
    expect(statements[0]).not.toContain("COALESCE(valid_until");
    expect(batchCalls()).toBe(1);
  });

  it("does not insert an orphaned replacement when the target is no longer active", async () => {
    const { db, batchCalls } = fakeDb(0);

    await expect(
      replaceActiveClaim(db, "project-1", "claim-prev", "claim-next", claim, 1_700_000_000_000),
    ).rejects.toThrow("Cannot replace claim because it is no longer active");
    expect(batchCalls()).toBe(0);
  });
});
