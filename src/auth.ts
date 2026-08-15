import { getBearerToken } from "./api/http";
import type { Env } from "./env";
import { createProjectScope, normalizeProjectId, type ProjectScope } from "./project";

export class RequestAuthError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "RequestAuthError";
    this.status = status;
  }
}

function getRequestToken(request: Request): string | null {
  const bearerToken = getBearerToken(request);
  if (bearerToken) return bearerToken;

  const apiKey = request.headers.get("X-Api-Key") ?? request.headers.get("x-api-key");
  return apiKey?.trim() || null;
}

function parseProjectTokenMap(raw: string | undefined): Map<string, string> {
  const source = raw?.trim();
  if (!source) {
    throw new RequestAuthError(500, "PROJECT_TOKENS_JSON is required for /memory/*");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new RequestAuthError(500, "PROJECT_TOKENS_JSON must be valid JSON");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new RequestAuthError(500, "PROJECT_TOKENS_JSON must be a JSON object");
  }

  const tokenToProject = new Map<string, string>();
  for (const [rawProjectId, rawToken] of Object.entries(parsed as Record<string, unknown>)) {
    const projectId = normalizeProjectId(rawProjectId);
    if (!projectId) {
      throw new RequestAuthError(500, `Invalid project id in PROJECT_TOKENS_JSON: ${rawProjectId}`);
    }

    if (typeof rawToken !== "string" || !rawToken.trim()) {
      throw new RequestAuthError(500, `Invalid token for project ${projectId} in PROJECT_TOKENS_JSON`);
    }

    const token = rawToken.trim();
    if (tokenToProject.has(token)) {
      throw new RequestAuthError(500, `Duplicate token detected in PROJECT_TOKENS_JSON for project ${projectId}`);
    }

    tokenToProject.set(token, projectId);
  }

  if (tokenToProject.size === 0) {
    throw new RequestAuthError(500, "PROJECT_TOKENS_JSON must define at least one project token");
  }

  return tokenToProject;
}

export function resolveProjectScope(
  request: Request,
  env: Pick<Env, "PROJECT_TOKENS_JSON" | "PERSONAL_MEMORY_TOKEN" | "PERSONAL_MEMORY_PROJECT_ID">,
): ProjectScope {
  const requestToken = getRequestToken(request);
  if (!requestToken) {
    throw new RequestAuthError(401, "Unauthorized");
  }

  const personalToken = env.PERSONAL_MEMORY_TOKEN?.trim();
  const tokenToProject = env.PROJECT_TOKENS_JSON?.trim()
    ? parseProjectTokenMap(env.PROJECT_TOKENS_JSON)
    : null;
  if (personalToken && tokenToProject?.has(personalToken)) {
    throw new RequestAuthError(500, "PERSONAL_MEMORY_TOKEN must not overlap a project token");
  }
  if (personalToken && requestToken === personalToken) {
    const personalProjectId = normalizeProjectId(env.PERSONAL_MEMORY_PROJECT_ID ?? "personal");
    if (!personalProjectId) {
      throw new RequestAuthError(500, "PERSONAL_MEMORY_PROJECT_ID is invalid");
    }
    return createProjectScope(personalProjectId);
  }

  const projectId = tokenToProject?.get(requestToken);
  if (!projectId) {
    // A personal token on its own is a valid deployment. Re-parsing an absent
    // PROJECT_TOKENS_JSON here used to turn a simple bad token into a 500 that
    // leaked the name of a missing secret to unauthenticated callers.
    if (!tokenToProject && !personalToken) {
      throw new RequestAuthError(500, "PROJECT_TOKENS_JSON is required for /memory/*");
    }
    throw new RequestAuthError(401, "Unauthorized");
  }

  return createProjectScope(projectId);
}
