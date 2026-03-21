import { RequestAuthError, resolveProjectScope } from "./auth";
import { handleEmbeddingRequest, isEmbeddingPath } from "./api/embedding";
import { handleMemoryRequest } from "./api/memory";
import { corsHeaders, isAuthorized, jsonResponse, textResponse, unauthorizedResponse } from "./api/http";
import type { Env } from "./env";

function getRequiredApiToken(env: Pick<Env, "API_TOKEN">): string | null {
  const token = env.API_TOKEN?.trim();
  return token ? token : null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const method = request.method.toUpperCase();
    const url = new URL(request.url);

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }

    if (isEmbeddingPath(url.pathname)) {
      const apiToken = getRequiredApiToken(env);
      if (!apiToken) {
        return jsonResponse(env, { error: { message: "API_TOKEN is required" } }, { status: 500 });
      }

      if (!isAuthorized(request, apiToken)) {
        return unauthorizedResponse(env, "cf-rag");
      }

      return await handleEmbeddingRequest(request, env);
    }

    if (url.pathname.startsWith("/memory/")) {
      try {
        const projectScope = resolveProjectScope(request, env);
        return await handleMemoryRequest(request, env, projectScope);
      } catch (error) {
        if (error instanceof RequestAuthError) {
          if (error.status === 401) {
            return unauthorizedResponse(env, "cf-rag-memory");
          }

          return jsonResponse(env, { error: { message: error.message } }, { status: error.status });
        }

        throw error;
      }
    }

    if (method !== "GET" && method !== "POST") {
      return textResponse(env, "Method Not Allowed", { status: 405 });
    }

    return textResponse(env, "Not Found", { status: 404 });
  },
};
