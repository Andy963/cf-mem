import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredClaimRow } from "../src/db/d1";
import type { Env } from "../src/env";
import { BreakerOpenError } from "../src/memory/llm-breaker";
import { applyExtractedClaims } from "../src/memory/profile/mutations";
import type { ExtractedClaim, ProfileJob } from "../src/memory/profile/shared";

const mocks = vi.hoisted(() => ({
  mutateClaim: vi.fn(),
  fetchClaimById: vi.fn(),
}));

vi.mock("../src/memory/claim-store", async () => {
  const actual = await vi.importActual<typeof import("../src/memory/claim-store")>("../src/memory/claim-store");
  return { ...actual, mutateClaim: mocks.mutateClaim };
});

vi.mock("../src/db/d1", async () => {
  const actual = await vi.importActual<typeof import("../src/db/d1")>("../src/db/d1");
  return { ...actual, fetchClaimById: mocks.fetchClaimById };
});

const job: ProfileJob = {
  id: "job-1",
  project_id: "project-1",
  evidence_segment_id: "seg-1",
  evidence_segment_ids_json: JSON.stringify(["seg-1"]),
  owner_id: "owner-1",
  source_app: "test",
  workspace_id: "workspace-1",
  status: "processing",
  attempt_count: 0,
  lease_token: null,
};

function activeClaim(id: string, overrides: Partial<StoredClaimRow> = {}): StoredClaimRow {
  return {
    id,
    project_id: "project-1",
    scope_kind: "user",
    scope_id: "owner-1",
    category: "rule",
    type: "instruction",
    subject: id,
    memory_key: id,
    value_json: JSON.stringify({ value: id }),
    canonical_text: `Claim ${id}.`,
    status: "active",
    provenance: "user_confirmed",
    confidence: 0.8,
    valid_from: null,
    valid_until: null,
    superseded_by: null,
    applicability: "workspace",
    workspace_id: "workspace-1",
    use_count: 0,
    last_used_at: null,
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

function createCandidate(memoryKey: string): ExtractedClaim {
  return {
    operation: "create",
    category: "rule",
    category_explicit: true,
    applicability_explicit: true,
    type: "instruction",
    subject: "guidance",
    memory_key: memoryKey,
    value: { value: memoryKey },
    canonical_text: `Guidance ${memoryKey}.`,
    confidence: 0.9,
    applicability: "global",
  };
}

function mutationResponse(id: string, value: unknown, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    project_id: "project-1",
    scope_kind: "user",
    scope_id: "owner-1",
    category: "rule",
    type: "instruction",
    subject: "guidance",
    memory_key: id,
    value,
    canonical_text: `Guidance ${id}.`,
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
    active_score: null,
    evidence: [],
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

function supersedeCandidate(canonicalText: string, value: unknown): ExtractedClaim {
  return {
    operation: "supersede",
    replaces_claim_id: "rule-1",
    category: "rule",
    category_explicit: true,
    type: "instruction",
    subject: "rule-1",
    memory_key: "rule-1",
    value,
    canonical_text: canonicalText,
    confidence: 0.9,
  };
}

const activeClaims = [
  activeClaim("tool-1", { category: "tool_insight", type: "decision", scope_id: "wrangler", applicability: "semantic", workspace_id: null }),
  activeClaim("rule-1"),
];

describe("applyExtractedClaims", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mutateClaim.mockResolvedValue(undefined);
    mocks.fetchClaimById.mockResolvedValue(null);
  });

  it("isolates malformed reconciler decisions and still applies valid candidates", async () => {
    const output: ExtractedClaim[] = [
      createCandidate("valid-1"),
      { ...createCandidate("bad-reinforce"), operation: "reinforce", claim_id: "missing" },
      { ...createCandidate("bad-category"), operation: "reinforce", claim_id: "tool-1" },
      { ...createCandidate("bad-operation"), operation: "merge" as ExtractedClaim["operation"] },
      createCandidate("valid-2"),
    ];

    const result = await applyExtractedClaims(
      {} as Env,
      { projectId: "project-1", namespace: "project:project-1" },
      job,
      output,
      activeClaims,
      new Set(["seg-1"]),
    );

    expect(result.applied).toBe(2);
    expect(result.failures).toEqual([
      "candidate_1:extractor_claim_invalid_claim_id",
      "candidate_2:extractor_claim_category_mismatch",
      "candidate_3:extractor_claim_invalid_operation",
    ]);
    expect(mocks.mutateClaim).toHaveBeenCalledTimes(2);
    const createdKeys = mocks.mutateClaim.mock.calls.map((call) => (call[2] as { claim: { memoryKey: string } }).claim.memoryKey);
    expect(createdKeys).toEqual(["valid-1", "valid-2"]);
  });

  it("reinforces an active tool insight claim instead of duplicating it", async () => {
    const output: ExtractedClaim[] = [{
      operation: "reinforce",
      claim_id: "tool-1",
      category: "tool_insight",
      category_explicit: true,
      type: "decision",
      confidence: 0.95,
    }];

    const result = await applyExtractedClaims(
      {} as Env,
      { projectId: "project-1", namespace: "project:project-1" },
      job,
      output,
      activeClaims,
      new Set(["seg-1"]),
    );

    expect(result).toEqual({ applied: 1, failures: [] });
    expect(mocks.mutateClaim).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { operation: "reinforce", claimId: "tool-1", evidenceSegmentIds: ["seg-1"], confidence: 0.95 },
    );
  });

  it("still propagates circuit breaker errors", async () => {
    mocks.mutateClaim.mockRejectedValue(new BreakerOpenError(1_700_000_000_000));

    await expect(applyExtractedClaims(
      {} as Env,
      { projectId: "project-1", namespace: "project:project-1" },
      job,
      [createCandidate("valid-1")],
      activeClaims,
      new Set(["seg-1"]),
    )).rejects.toBeInstanceOf(BreakerOpenError);
  });

  it("lets a later candidate reinforce a claim created earlier in the same batch", async () => {
    mocks.mutateClaim.mockImplementation(async (_env, _scope, request: { operation: string }) => {
      if (request.operation === "create") return mutationResponse("claim-created-1", { value: "batch-a" });
      return mutationResponse("claim-created-1", { value: "batch-a" }, { confidence: 0.95 });
    });
    const output: ExtractedClaim[] = [
      createCandidate("batch-a"),
      { operation: "reinforce", claim_id: "claim-created-1", category: "rule", category_explicit: true, confidence: 0.95 },
    ];

    const result = await applyExtractedClaims(
      {} as Env,
      { projectId: "project-1", namespace: "project:project-1" },
      job,
      output,
      activeClaims,
      new Set(["seg-1"]),
    );

    expect(result).toEqual({ applied: 2, failures: [] });
    expect(mocks.mutateClaim).toHaveBeenCalledTimes(2);
    expect(mocks.mutateClaim.mock.calls[1][2]).toEqual({
      operation: "reinforce",
      claimId: "claim-created-1",
      evidenceSegmentIds: ["seg-1"],
      confidence: 0.95,
    });
  });

  it("tracks a supersession chain across a single batch", async () => {
    mocks.mutateClaim.mockImplementation(async (_env, _scope, request: { operation: string }) => {
      if (request.operation === "create") return mutationResponse("claim-created-1", { value: "batch-b" });
      return mutationResponse("claim-repl-1", { value: "batch-b-v2" }, { canonical_text: "Guidance batch-b v2." });
    });
    const output: ExtractedClaim[] = [
      createCandidate("batch-b"),
      {
        ...createCandidate("batch-b"),
        operation: "supersede",
        replaces_claim_id: "claim-created-1",
        value: { value: "batch-b-v2" },
        canonical_text: "Guidance batch-b v2.",
      },
      { operation: "reinforce", claim_id: "claim-repl-1", category: "rule", category_explicit: true, confidence: 0.9 },
    ];

    const result = await applyExtractedClaims(
      {} as Env,
      { projectId: "project-1", namespace: "project:project-1" },
      job,
      output,
      activeClaims,
      new Set(["seg-1"]),
    );

    expect(result).toEqual({ applied: 3, failures: [] });
    expect(mocks.mutateClaim).toHaveBeenCalledTimes(3);
    const reinforced = mocks.mutateClaim.mock.calls[2][2] as { claimId: string };
    expect(reinforced.claimId).toBe("claim-repl-1");
  });

  it("resolves repeat supersession of one claim within a batch", async () => {
    mocks.fetchClaimById.mockResolvedValue(activeClaim("claim-repl-2", {
      value_json: JSON.stringify({ value: "rule-1-v2" }),
      canonical_text: "Replacement for rule-1.",
    }));
    mocks.mutateClaim.mockResolvedValue(mutationResponse("claim-repl-2", { value: "rule-1-v2" }, {
      canonical_text: "Replacement for rule-1.",
    }));
    const output: ExtractedClaim[] = [
      supersedeCandidate("Replacement for rule-1.", { value: "rule-1-v2" }),
      supersedeCandidate("Replacement for rule-1.", { value: "rule-1-v2" }),
      supersedeCandidate("Different replacement.", { value: "rule-1-v3" }),
    ];

    const result = await applyExtractedClaims(
      {} as Env,
      { projectId: "project-1", namespace: "project:project-1" },
      job,
      output,
      activeClaims,
      new Set(["seg-1"]),
    );

    expect(result.applied).toBe(2);
    expect(result.failures).toEqual(["candidate_2:extractor_claim_conflicting_replacement"]);
    expect(mocks.mutateClaim).toHaveBeenCalledTimes(1);
  });

  it("marks a retracted claim inactive for later candidates in the same batch", async () => {
    mocks.mutateClaim.mockResolvedValue(mutationResponse("rule-1", { value: "rule-1" }, { status: "retracted" }));
    const output: ExtractedClaim[] = [
      { operation: "retract", claim_id: "rule-1" },
      { operation: "retract", claim_id: "rule-1" },
    ];

    const result = await applyExtractedClaims(
      {} as Env,
      { projectId: "project-1", namespace: "project:project-1" },
      job,
      output,
      activeClaims,
      new Set(["seg-1"]),
    );

    expect(result).toEqual({ applied: 2, failures: [] });
    expect(mocks.mutateClaim).toHaveBeenCalledTimes(1);
  });
});
