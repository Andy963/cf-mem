import { describe, expect, it } from "vitest";
import { resolveProfileClaimScope } from "../src/memory/profile";

describe("resolveProfileClaimScope", () => {
  it("stores domain facts under the project scope", () => {
    expect(resolveProfileClaimScope(null, "domain_fact", "decision", undefined, "owner-1", "project-1"))
      .toEqual({ scopeKind: "project", scopeId: "project-1" });
  });

  it("stores technical decisions under the project scope", () => {
    expect(resolveProfileClaimScope(null, "rule", "decision", undefined, "owner-1", "project-1"))
      .toEqual({ scopeKind: "project", scopeId: "project-1" });
  });

  it("keeps preferences and profiles under the owner scope", () => {
    expect(resolveProfileClaimScope(null, "rule", "preference", undefined, "owner-1", "project-1"))
      .toEqual({ scopeKind: "user", scopeId: "owner-1" });
    expect(resolveProfileClaimScope(null, "user_profile", "profile", undefined, "owner-1", "project-1"))
      .toEqual({ scopeKind: "user", scopeId: "owner-1" });
  });

  it("keeps tool insights addressable by their tool scope", () => {
    expect(resolveProfileClaimScope(null, "tool_insight", "decision", "wrangler", "owner-1", "project-1"))
      .toEqual({ scopeKind: "user", scopeId: "wrangler" });
    expect(resolveProfileClaimScope(null, "tool_insight", "preference", "wrangler", "owner-1", "project-1"))
      .toEqual({ scopeKind: "user", scopeId: "wrangler" });
  });

  it("preserves the scope of an existing claim during reconciliation", () => {
    expect(resolveProfileClaimScope(
      { scope_kind: "user", scope_id: "legacy-owner" },
      "domain_fact",
      "decision",
      undefined,
      "owner-1",
      "project-1",
    )).toEqual({ scopeKind: "user", scopeId: "legacy-owner" });
  });
});
