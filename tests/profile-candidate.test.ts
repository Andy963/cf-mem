import { describe, expect, it } from "vitest";
import { normalizedExtractorCandidate } from "../src/memory/profile/shared";

const validCreateCandidate = {
  operation: "create",
  type: "preference",
  candidate_kind: "preference",
  category: "rule",
  applicability: "global",
  subject: "response",
  memory_key: "response.language",
  value: "English",
  canonical_text: "Use concise English responses.",
  confidence: 0.9,
  explicit: true,
  agent_relevance: "global_behavior",
  evidence_segment_ids: ["segment-1"],
};

describe("normalizedExtractorCandidate", () => {
  it("projects a valid create candidate into the typed shape", () => {
    const normalized = normalizedExtractorCandidate({
      ...validCreateCandidate,
      unexpected_field: "discarded",
    });

    expect(normalized).toEqual({
      operation: "create",
      category: "rule",
      category_explicit: true,
      applicability_explicit: true,
      scope_id: undefined,
      type: "preference",
      candidate_kind: "preference",
      applicability: "global",
      explicit: true,
      agent_relevance: "global_behavior",
      evidence_segment_ids: ["segment-1"],
      claim_id: undefined,
      replaces_claim_id: undefined,
      valid_until: undefined,
      confidence: 0.9,
      subject: "response",
      memory_key: "response.language",
      canonical_text: "Use concise English responses.",
      value: "English",
    });
  });

  it.each(["subject", "memory_key", "canonical_text", "value", "confidence"])(
    "rejects a create candidate missing %s",
    (field) => {
      const candidate = { ...validCreateCandidate } as Record<string, unknown>;
      delete candidate[field];

      expect(normalizedExtractorCandidate(candidate)).toBeNull();
    },
  );

  it.each([
    "unknown",
    "delete",
    1,
    null,
  ])("rejects an invalid operation value", (operation) => {
    expect(normalizedExtractorCandidate({ ...validCreateCandidate, operation })).toBeNull();
  });

  it("rejects an incomplete nested operation payload", () => {
    expect(normalizedExtractorCandidate({
      operation: { name: "create" },
    })).toBeNull();
  });

  it("does not reinterpret nested lifecycle fields as a create", () => {
    expect(normalizedExtractorCandidate({
      operation: {
        type: "preference",
        subject: "response",
        memory_key: "response.language",
        value: "English",
        canonical_text: "Use concise English responses.",
        confidence: 0.9,
        claim_id: "claim-1",
      },
    })).toBeNull();
  });

  it.each([NaN, Infinity, -0.1, 1.1, "0.5", null])(
    "rejects invalid create confidence %s",
    (confidence) => {
      expect(normalizedExtractorCandidate({ ...validCreateCandidate, confidence })).toBeNull();
    },
  );

  it("defaults an omitted operation to create", () => {
    const { operation: _operation, ...withoutOperation } = validCreateCandidate;

    expect(normalizedExtractorCandidate(withoutOperation)?.operation).toBe("create");
  });

  it("treats null optional lifecycle ids as absent", () => {
    expect(normalizedExtractorCandidate({
      ...validCreateCandidate,
      claim_id: null,
      replaces_claim_id: null,
    })).toMatchObject({
      operation: "create",
      claim_id: undefined,
      replaces_claim_id: undefined,
    });
  });

  it("requires a target id for lifecycle operations", () => {
    expect(normalizedExtractorCandidate({
      type: "preference",
      candidate_kind: "preference",
      operation: "reinforce",
    })).toBeNull();
    expect(normalizedExtractorCandidate({
      type: "preference",
      candidate_kind: "preference",
      operation: "retract",
    })).toBeNull();
    expect(normalizedExtractorCandidate({
      ...validCreateCandidate,
      operation: "supersede",
    })).toBeNull();
  });

  it("accepts reinforce and retract candidates without create fields", () => {
    const common = {
      type: "preference",
      candidate_kind: "preference",
      category: "rule",
      applicability: "global",
      claim_id: "claim-1",
      explicit: true,
      agent_relevance: "global_behavior",
    };

    expect(normalizedExtractorCandidate({ ...common, operation: "reinforce" })).toMatchObject({
      operation: "reinforce",
      claim_id: "claim-1",
    });
    expect(normalizedExtractorCandidate({ ...common, operation: "retract" })).toMatchObject({
      operation: "retract",
      claim_id: "claim-1",
    });
  });

  it("rejects malformed enum and array fields", () => {
    expect(normalizedExtractorCandidate({ ...validCreateCandidate, candidate_kind: "invalid" })).toBeNull();
    expect(normalizedExtractorCandidate({ ...validCreateCandidate, applicability: "invalid" })).toBeNull();
    expect(normalizedExtractorCandidate({ ...validCreateCandidate, evidence_segment_ids: ["segment-1", 2] })).toBeNull();
  });

  it("rejects malformed required field types", () => {
    expect(normalizedExtractorCandidate({ ...validCreateCandidate, subject: 42 })).toBeNull();
    expect(normalizedExtractorCandidate({ ...validCreateCandidate, memory_key: null })).toBeNull();
    expect(normalizedExtractorCandidate({ ...validCreateCandidate, canonical_text: [] })).toBeNull();
  });
});
