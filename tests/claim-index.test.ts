import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { findVectorizedClaimMatches } from "../src/memory/claim-index";

describe("findVectorizedClaimMatches", () => {
  it("caps return-value queries at Vectorize's topK limit", async () => {
    const query = vi.fn(async () => ({
      matches: [{ id: "claim-1", score: 0.9 }],
    }));
    const env = {
      CLAIMS_INDEX: { query },
    } as unknown as Env;

    const matches = await findVectorizedClaimMatches(env, {
      projectId: "project-1",
      vector: [1, 0],
      topK: 100,
    });

    expect(matches).toEqual([{ id: "claim-1", score: 0.9 }]);
    expect(query).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledWith([1, 0], {
      topK: 50,
      namespace: "project:project-1:claims",
      returnValues: true,
    });
  });
});
