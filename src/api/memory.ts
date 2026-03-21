import type { Env } from "../env";
import { indexMemoryItems } from "../memory/indexer";
import { defaultMemorySchema, MemorySchemaError, type SearchRequestInput } from "../memory/schema";
import { searchMemoryItems } from "../memory/searcher";
import type { ProjectScope } from "../project";
import { jsonResponse, parseJson, textResponse } from "./http";

function invalidRequestResponse(env: Env, error: Error): Response {
  return jsonResponse(env, { error: { message: error.message } }, { status: 400 });
}

export async function handleMemoryRequest(request: Request, env: Env, projectScope: ProjectScope): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();

  if (method === "GET" && url.pathname === "/memory/health") {
    return jsonResponse(env, { ok: true, project_id: projectScope.projectId, namespace: projectScope.namespace });
  }

  if (method === "POST" && url.pathname === "/memory/index") {
    let body: unknown;
    try {
      body = await parseJson(request);
    } catch (error) {
      return invalidRequestResponse(env, error as Error);
    }

    const items = defaultMemorySchema.normalizeIndexRequest(body);
    if (items.length === 0) {
      return jsonResponse(env, { error: { message: "Missing items. Use {\"text\":\"...\"} or {\"items\":[...]}" } }, { status: 400 });
    }

    try {
      const preparedItems = await defaultMemorySchema.prepareIndexItems(items, projectScope);
      const result = await indexMemoryItems(env, preparedItems);
      return jsonResponse(env, result);
    } catch (error) {
      if (error instanceof MemorySchemaError) {
        return invalidRequestResponse(env, error);
      }

      return jsonResponse(env, { error: { message: (error as Error).message } }, { status: 502 });
    }
  }

  if (method === "POST" && url.pathname === "/memory/search") {
    let body: unknown;
    try {
      body = await parseJson(request);
    } catch (error) {
      return invalidRequestResponse(env, error as Error);
    }

    let requestInput: SearchRequestInput | null;
    try {
      requestInput = defaultMemorySchema.normalizeSearchRequest(body, projectScope);
    } catch (error) {
      if (error instanceof MemorySchemaError) {
        return invalidRequestResponse(env, error);
      }

      return jsonResponse(env, { error: { message: (error as Error).message } }, { status: 502 });
    }

    if (!requestInput) {
      return jsonResponse(env, { error: { message: "Missing query. Use {\"query\":\"...\"}" } }, { status: 400 });
    }

    try {
      const result = await searchMemoryItems(env, requestInput, body);
      return jsonResponse(env, result);
    } catch (error) {
      if (error instanceof MemorySchemaError) {
        return invalidRequestResponse(env, error);
      }

      return jsonResponse(env, { error: { message: (error as Error).message } }, { status: 502 });
    }
  }

  if (method !== "GET" && method !== "POST") {
    return textResponse(env, "Method Not Allowed", { status: 405 });
  }

  return textResponse(env, "Not Found", { status: 404 });
}
