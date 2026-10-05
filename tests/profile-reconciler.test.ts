import { describe, expect, it, vi } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import type { StoredClaimRow } from "../src/db/d1";
import { callReconciliation } from "../src/memory/profile/client";
import { reconcileAcceptedCandidates } from "../src/memory/profile/reconciler";
import type { ExtractedClaim } from "../src/memory/profile/shared";

function activeClaim(id: string, category: StoredClaimRow["category"] = "tool_insight"): StoredClaimRow {
  return {
    id,
    project_id: "project-1",
    scope_kind: "user",
    scope_id: "wrangler",
    category,
    type: "decision",
    subject: "wrangler",
    memory_key: id,
    value_json: JSON.stringify({ value: id }),
    canonical_text: "Use the repository-local Wrangler for tool calls.",
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
  };
}

function candidate(memoryKey: string): ExtractedClaim {
  return {
    operation: "create",
    category: "tool_insight",
    type: "decision",
    subject: "wrangler",
    memory_key: memoryKey,
    value: { value: memoryKey },
    canonical_text: "Use the repository-local Wrangler for tool calls.",
    confidence: 0.9,
    applicability: "semantic",
    scope_id: "wrangler",
  };
}

describe("reconcileAcceptedCandidates", () => {
  it("keeps candidates whose decision references an invalid claim", () => {
    const input = candidate("new-tool-guidance");

    expect(reconcileAcceptedCandidates(
      [input],
      [{ candidate_index: 0, action: "reinforce", claim_id: "missing", reason: "bad model id" }],
      [activeClaim("existing")],
    )).toEqual([input]);
  });

  it("isolates missing and invalid decisions while applying valid decisions", () => {
    const first = candidate("first");
    const second = candidate("second");

    expect(reconcileAcceptedCandidates(
      [first, second],
      [
        { candidate_index: 0, action: "reinforce", claim_id: "existing", reason: "same insight" },
        { candidate_index: 99, action: "supersede", replaces_claim_id: "missing", reason: "out of range" },
      ],
      [activeClaim("existing")],
    )).toEqual([
      { ...first, operation: "reinforce", claim_id: "existing", replaces_claim_id: undefined },
      second,
    ]);
  });
});

describe("callReconciliation", () => {
  it("retains valid decisions after malformed entries", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            decisions: [
              { candidate_index: 99, action: "keep", reason: "out of range" },
              { candidate_index: 0, action: "reinforce", claim_id: "existing", reason: "same insight" },
            ],
          }),
        },
      }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const env = {
      DB: {
        prepare: vi.fn(() => ({ first: vi.fn(async () => null) })),
      } as unknown as D1Database,
      EXTRACTOR_LLM_API_BASE: "https://example.test/v1",
      EXTRACTOR_LLM_API_KEY: "test-key",
      EXTRACTOR_LLM_MODEL: "test-model",
    } as never;

    try {
      await expect(callReconciliation(env, [candidate("first")], [], null)).resolves.toEqual([
        { candidate_index: 0, action: "reinforce", claim_id: "existing", reason: "same insight" },
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
