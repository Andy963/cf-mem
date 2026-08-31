import { constantTimeEqual, getBearerToken } from "./api/http";
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

function getRequestedProjectId(request: Request): string | null {
  const value = request.headers.get("X-Project-Id");
  return value?.trim() || null;
}

function parseAllowedProjects(raw: string | undefined): Set<string> | null {
  const source = raw?.trim();
  if (!source) return null;

  const values: string[] = [];
  for (const rawValue of source.split(",")) {
    const trimmed = rawValue.trim();
    if (!trimmed) continue;
    const projectId = normalizeProjectId(trimmed);
    if (!projectId) {
      throw new RequestAuthError(500, "ALLOWED_MEMORY_PROJECTS must contain only valid project ids");
    }
    values.push(projectId);
  }
  // A separator-only value is a malformed allowlist, not an absent one. An
  // empty Set would 403 every request; returning null would silently disable
  // the allowlist and let the shared token reach any project. Both are wrong,
  // so fail the same way an invalid entry does.
  if (values.length === 0) {
    throw new RequestAuthError(500, "ALLOWED_MEMORY_PROJECTS must contain at least one project id");
  }
  return new Set(values);
}

function resolveSharedMemoryToken(env: Pick<Env, "API_TOKEN" | "MEMORY_API_TOKEN">): string | null {
  // MEMORY_API_TOKEN is deliberately preferred so memory credentials can be
  // rotated independently from the embedding/web API token. API_TOKEN remains
  // a temporary fallback for the existing deployment during migration.
  const token = env.MEMORY_API_TOKEN?.trim() || env.API_TOKEN?.trim();
  return token || null;
}

/** Parse only the migration credential set; callers must still provide a header. */
function parseLegacyProjectTokenMap(raw: string | undefined): Map<string, string> {
  const source = raw?.trim();
  if (!source) return new Map();

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
  return tokenToProject;
}

export function resolveProjectScope(
  request: Request,
  env: Pick<Env, "API_TOKEN" | "MEMORY_API_TOKEN" | "ALLOWED_MEMORY_PROJECTS" | "PROJECT_TOKENS_JSON" | "PERSONAL_MEMORY_TOKEN" | "PERSONAL_MEMORY_PROJECT_ID">,
): ProjectScope {
  const requestToken = getRequestToken(request);
  if (!requestToken) {
    throw new RequestAuthError(401, "Unauthorized");
  }

  const sharedToken = resolveSharedMemoryToken(env);
  const personalToken = env.PERSONAL_MEMORY_TOKEN?.trim() || null;
  if (!sharedToken && !env.PROJECT_TOKENS_JSON?.trim() && !personalToken) {
    throw new RequestAuthError(500, "MEMORY_API_TOKEN or API_TOKEN is required for /memory/*");
  }

  const requestedProjectId = getRequestedProjectId(request);
  if (!requestedProjectId) {
    throw new RequestAuthError(400, "X-Project-Id is required");
  }

  const projectId = normalizeProjectId(requestedProjectId);
  if (!projectId) {
    throw new RequestAuthError(400, "X-Project-Id is invalid");
  }

  const allowedProjects = parseAllowedProjects(env.ALLOWED_MEMORY_PROJECTS);
  const ensureProjectAllowed = (id: string): void => {
    if (allowedProjects && !allowedProjects.has(id)) {
      throw new RequestAuthError(403, "Project is not allowed for this token");
    }
  };

  if (sharedToken && constantTimeEqual(requestToken, sharedToken)) {
    ensureProjectAllowed(projectId);
    return createProjectScope(projectId);
  }

  // Legacy credentials are accepted only during migration and only when the
  // caller explicitly names the exact project they were issued for. They are
  // never used to infer a scope, and a token for project A cannot be replayed
  // with a project-B header.
  const legacyProjectTokens = env.PROJECT_TOKENS_JSON?.trim()
    ? parseLegacyProjectTokenMap(env.PROJECT_TOKENS_JSON)
    : new Map<string, string>();
  let legacyProjectId = legacyProjectTokens.get(requestToken) ?? null;
  if (personalToken && constantTimeEqual(requestToken, personalToken)) {
    legacyProjectId = normalizeProjectId(env.PERSONAL_MEMORY_PROJECT_ID ?? "personal");
    if (!legacyProjectId) {
      throw new RequestAuthError(500, "PERSONAL_MEMORY_PROJECT_ID is invalid");
    }
  }
  if (!legacyProjectId) {
    throw new RequestAuthError(401, "Unauthorized");
  }
  if (legacyProjectId !== projectId) {
    throw new RequestAuthError(403, "Legacy token is bound to a different project; rotate it to the shared memory token");
  }

  ensureProjectAllowed(projectId);
  console.warn(`[auth] legacy project credential used for explicit project ${projectId}`);

  return createProjectScope(projectId);
}
