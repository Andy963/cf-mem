import type { Env } from "../env";
import type { ProjectScope } from "../project";
import { handleEmbeddingRequest, isEmbeddingPath } from "./embedding";
import { handleMemoryRequest } from "./memory";
import { jsonResponse, textResponse } from "./http";

export async function routeRequest(request: Request, env: Env, projectScope?: ProjectScope): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();

  if (isEmbeddingPath(url.pathname)) {
    return await handleEmbeddingRequest(request, env);
  }

  if (url.pathname.startsWith("/memory/")) {
    if (!projectScope) {
      return jsonResponse(env, { error: { message: "Project scope is required for memory routes" } }, { status: 500 });
    }

    return await handleMemoryRequest(request, env, projectScope);
  }

  if (method !== "GET" && method !== "POST") {
    return textResponse(env, "Method Not Allowed", { status: 405 });
  }

  return textResponse(env, "Not Found", { status: 404 });
}
