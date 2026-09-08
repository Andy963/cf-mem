import "./setup-crypto";
import { describe, expect, it } from "vitest";
import { RequestAuthError, resolveProjectScope } from "../src/auth";

function makeRequest(token: string, projectId?: string): Request {
  const headers = new Headers({ Authorization: `Bearer ${token}` });
  if (projectId !== undefined) headers.set("X-Project-Id", projectId);
  return new Request("https://example.com/memory/health", { headers });
}

async function expectAuthError(run: () => Promise<unknown>, status: number): Promise<void> {
  let error: unknown;
  try {
    await run();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(RequestAuthError);
  expect((error as RequestAuthError).status).toBe(status);
}

describe("resolveProjectScope", () => {
  it("routes a shared token to a new project outside the deprecated allowlist", async () => {
    const scope = await resolveProjectScope(
      makeRequest("shared-token", "new-repository"),
      {
        MEMORY_API_TOKEN: "shared-token",
        ALLOWED_MEMORY_PROJECTS: "cf-mem,legacy-project",
      },
    );

    expect(scope).toEqual({ projectId: "new-repository", namespace: "project:new-repository" });
  });

  it("ignores malformed deprecated allowlist configuration for shared-token routing", async () => {
    const scope = await resolveProjectScope(
      makeRequest("shared-token", "new-repository"),
      {
        MEMORY_API_TOKEN: "shared-token",
        ALLOWED_MEMORY_PROJECTS: ", ,",
      },
    );

    expect(scope.projectId).toBe("new-repository");
  });

  it("rejects a missing project header", async () => {
    await expectAuthError(
      () => resolveProjectScope(makeRequest("shared-token"), { MEMORY_API_TOKEN: "shared-token" }),
      400,
    );
  });

  it("rejects a blank project header", async () => {
    await expectAuthError(
      () => resolveProjectScope(makeRequest("shared-token", ""), { MEMORY_API_TOKEN: "shared-token" }),
      400,
    );
  });

  it("rejects a malformed project header", async () => {
    await expectAuthError(
      () => resolveProjectScope(makeRequest("shared-token", "invalid/project"), { MEMORY_API_TOKEN: "shared-token" }),
      400,
    );
  });

  it("rejects an invalid shared token", async () => {
    await expectAuthError(
      () => resolveProjectScope(makeRequest("wrong-token", "new-repository"), { MEMORY_API_TOKEN: "shared-token" }),
      401,
    );
  });

  it("routes a matching personal token to its configured project", async () => {
    await expect(resolveProjectScope(makeRequest("personal-token", "personal"), {
      PERSONAL_MEMORY_TOKEN: "personal-token",
      PERSONAL_MEMORY_PROJECT_ID: "personal",
    })).resolves.toEqual({
      projectId: "personal",
      namespace: "project:personal",
    });
  });

  it("rejects a missing authorization token", async () => {
    await expectAuthError(
      () => resolveProjectScope(
        new Request("https://example.com/memory/health", { headers: { "X-Project-Id": "new-repository" } }),
        { MEMORY_API_TOKEN: "shared-token" },
      ),
      401,
    );
  });

  it("rejects an invalid token before parsing malformed legacy configuration", async () => {
    await expectAuthError(
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

  it("keeps legacy project credentials bound to their configured project", async () => {
    const env = {
      PROJECT_TOKENS_JSON: JSON.stringify({ "legacy-project": "legacy-token" }),
      ALLOWED_MEMORY_PROJECTS: "legacy-project",
    };

    await expect(resolveProjectScope(makeRequest("legacy-token", "legacy-project"), env)).resolves.toEqual({
      projectId: "legacy-project",
      namespace: "project:legacy-project",
    });
    await expectAuthError(
      () => resolveProjectScope(makeRequest("legacy-token", "other-project"), env),
      403,
    );
  });

  it("retains the deprecated allowlist guard for legacy credentials", async () => {
    await expectAuthError(
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
