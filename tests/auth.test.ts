import { describe, expect, it } from "vitest";
import { RequestAuthError, resolveProjectScope } from "../src/auth";

function makeRequest(token: string, projectId?: string): Request {
  const headers = new Headers({ Authorization: `Bearer ${token}` });
  if (projectId !== undefined) headers.set("X-Project-Id", projectId);
  return new Request("https://example.com/memory/health", { headers });
}

function expectAuthError(run: () => unknown, status: number): void {
  let error: unknown;
  try {
    run();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(RequestAuthError);
  expect((error as RequestAuthError).status).toBe(status);
}

describe("resolveProjectScope", () => {
  it("routes a shared token to a new project outside the deprecated allowlist", () => {
    const scope = resolveProjectScope(
      makeRequest("shared-token", "new-repository"),
      {
        MEMORY_API_TOKEN: "shared-token",
        ALLOWED_MEMORY_PROJECTS: "cf-mem,legacy-project",
      },
    );

    expect(scope).toEqual({ projectId: "new-repository", namespace: "project:new-repository" });
  });

  it("ignores malformed deprecated allowlist configuration for shared-token routing", () => {
    const scope = resolveProjectScope(
      makeRequest("shared-token", "new-repository"),
      {
        MEMORY_API_TOKEN: "shared-token",
        ALLOWED_MEMORY_PROJECTS: ", ,",
      },
    );

    expect(scope.projectId).toBe("new-repository");
  });

  it("rejects a missing project header", () => {
    expectAuthError(
      () => resolveProjectScope(makeRequest("shared-token"), { MEMORY_API_TOKEN: "shared-token" }),
      400,
    );
  });

  it("rejects a blank project header", () => {
    expectAuthError(
      () => resolveProjectScope(makeRequest("shared-token", ""), { MEMORY_API_TOKEN: "shared-token" }),
      400,
    );
  });

  it("rejects a malformed project header", () => {
    expectAuthError(
      () => resolveProjectScope(makeRequest("shared-token", "invalid/project"), { MEMORY_API_TOKEN: "shared-token" }),
      400,
    );
  });

  it("rejects an invalid shared token", () => {
    expectAuthError(
      () => resolveProjectScope(makeRequest("wrong-token", "new-repository"), { MEMORY_API_TOKEN: "shared-token" }),
      401,
    );
  });

  it("rejects a missing authorization token", () => {
    expectAuthError(
      () => resolveProjectScope(
        new Request("https://example.com/memory/health", { headers: { "X-Project-Id": "new-repository" } }),
        { MEMORY_API_TOKEN: "shared-token" },
      ),
      401,
    );
  });

  it("rejects an invalid token before parsing malformed legacy configuration", () => {
    expectAuthError(
      () => resolveProjectScope(
        makeRequest("wrong-token", "new-repository"),
        {
          MEMORY_API_TOKEN: "shared-token",
          ALLOWED_MEMORY_PROJECTS: ", ,",
        },
      ),
      401,
    );
  });

  it("keeps legacy project credentials bound to their configured project", () => {
    const env = {
      PROJECT_TOKENS_JSON: JSON.stringify({ "legacy-project": "legacy-token" }),
      ALLOWED_MEMORY_PROJECTS: "legacy-project",
    };

    expect(resolveProjectScope(makeRequest("legacy-token", "legacy-project"), env)).toEqual({
      projectId: "legacy-project",
      namespace: "project:legacy-project",
    });
    expectAuthError(
      () => resolveProjectScope(makeRequest("legacy-token", "other-project"), env),
      403,
    );
  });

  it("retains the deprecated allowlist guard for legacy credentials", () => {
    expectAuthError(
      () => resolveProjectScope(
        makeRequest("legacy-token", "legacy-project"),
        {
          PROJECT_TOKENS_JSON: JSON.stringify({ "legacy-project": "legacy-token" }),
          ALLOWED_MEMORY_PROJECTS: "other-project",
        },
      ),
      403,
    );
  });
});
