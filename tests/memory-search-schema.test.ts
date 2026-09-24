import { describe, expect, it } from "vitest";
import { handleMemoryRequest } from "../src/api/memory";
import type { Env } from "../src/env";
import { createProjectScope } from "../src/project";
import { defaultMemorySchema, MemorySchemaError } from "../src/memory/schema";

const projectScope = createProjectScope("project-1");

describe("memory search filter validation", () => {
  it("preserves valid primitive filter values", () => {
    const request = defaultMemorySchema.normalizeSearchRequest({
      query: "test",
      filter: {
        session_id: "session-1",
        attempt: 0,
        archived: false,
      },
    }, projectScope);

    expect(request?.filter).toEqual({
      session_id: "session-1",
      attempt: 0,
      archived: false,
      category: "domain_fact",
    });
  });

  it.each([null, [], "session-1", 1, true])("rejects a non-object filter container: %j", (filter) => {
    expect(() => defaultMemorySchema.normalizeSearchRequest({ query: "test", filter }, projectScope))
      .toThrowError(new MemorySchemaError("filter must be an object"));
  });

  it.each([
    ["nested object", { $eq: "session-1" }],
    ["array", ["session-1"]],
    ["null", null],
    ["NaN", Number.NaN],
    ["infinity", Number.POSITIVE_INFINITY],
  ])("rejects an unsupported filter value: %s", (_label, value) => {
    expect(() => defaultMemorySchema.normalizeSearchRequest({
      query: "test",
      filter: { session_id: value },
    }, projectScope)).toThrowError(
      new MemorySchemaError("filter.session_id must be a string, finite number, or boolean"),
    );
  });

  it("keeps project isolation and workspace conflict checks", () => {
    expect(() => defaultMemorySchema.normalizeSearchRequest({
      query: "test",
      filter: { project_id: "project-2" },
    }, projectScope)).toThrowError("filter.project_id does not match the authenticated project");

    expect(() => defaultMemorySchema.normalizeSearchRequest({
      query: "test",
      workspace_id: "workspace-1",
      filter: { workspace_id: "workspace-2" },
    }, projectScope)).toThrowError("workspace_id conflicts with filter.workspace_id");
  });
});

describe("memory search HTTP validation", () => {
  it.each([
    null,
    [],
    { session_id: { $eq: "session-1" } },
    { session_id: ["session-1"] },
    { session_id: null },
    { session_id: Number.NaN },
  ])("returns 400 for invalid filter payload %#", async (filter) => {
    const request = new Request("https://example.com/memory/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "test", filter }),
    });

    const response = await handleMemoryRequest(
      request,
      {} as Env,
      projectScope,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: { message: expect.stringMatching(/^filter(?:\.session_id)? must be/) },
    });
  });
});
