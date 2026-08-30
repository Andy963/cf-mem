import type { Env } from "../env";
import { indexMemoryItems } from "../memory/indexer";
import { listDurableMemoryClaims, loadMemoryContext, mutateClaim } from "../memory/claim-store";
import { CLAIM_STATUSES, ClaimSchemaError, normalizeClaimMutationRequest, normalizeContextRequest, SCOPE_KINDS } from "../memory/claims";
import { defaultMemorySchema, MemorySchemaError, type SearchRequestInput } from "../memory/schema";
import { searchMemoryItems } from "../memory/searcher";
import { forgetScopedMemory } from "../memory/retention";
import { enqueueEvidenceExtraction, enqueueProfileIngest } from "../memory/profile";
import type { ProjectScope } from "../project";
import { jsonResponse, parseJson, textResponse } from "./http";

function invalidRequestResponse(env: Env, error: Error): Response {
  return jsonResponse(env, { error: { message: error.message } }, { status: 400 });
}

function parseClaimListOptions(url: URL): {
  scopeKind: "project" | "user" | "session" | null;
  scopeId: string | null;
  status: "active" | "superseded" | "retracted" | "proposed" | null;
  limit: number;
} {
  const rawScopeKind = url.searchParams.get("scope_kind");
  const rawScopeId = url.searchParams.get("scope_id");
  const rawStatus = url.searchParams.get("status");
  const rawLimit = url.searchParams.get("limit");
  if (rawScopeKind && !SCOPE_KINDS.includes(rawScopeKind as (typeof SCOPE_KINDS)[number])) {
    throw new ClaimSchemaError("scope_kind must be one of: project, user, session");
  }
  if (rawScopeId !== null && !rawScopeId.trim()) throw new ClaimSchemaError("scope_id must not be empty");
  if (rawStatus && !CLAIM_STATUSES.includes(rawStatus as (typeof CLAIM_STATUSES)[number])) {
    throw new ClaimSchemaError("status must be one of: active, superseded, retracted, proposed");
  }
  const limit = rawLimit === null ? 100 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new ClaimSchemaError("limit must be an integer from 1 to 500");
  }
  return {
    scopeKind: (rawScopeKind as "project" | "user" | "session" | null) || null,
    scopeId: rawScopeId?.trim() || null,
    status: (rawStatus as "active" | "superseded" | "retracted" | "proposed" | null) || null,
    limit,
  };
}

export async function handleMemoryRequest(request: Request, env: Env, projectScope: ProjectScope): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();

  if (method === "POST" && url.pathname === "/memory/profile/ingest") {
    let body: unknown;
    try {
      body = await parseJson(request);
    } catch (error) {
      return invalidRequestResponse(env, error as Error);
    }
    try {
      const result = await enqueueProfileIngest(env, projectScope, body);
      // Evidence is buffered and batched by the cron flush, so there is no job
      // id to hand back at ingest time. job_id stays in the payload as an
      // explicit null to keep the shape stable for existing callers.
      return jsonResponse(
        env,
        { ok: true, evidence_id: result.evidenceId, buffered: result.buffered, job_id: null },
        { status: 202 },
      );
    } catch (error) {
      if (error instanceof ClaimSchemaError || error instanceof MemorySchemaError) {
        return invalidRequestResponse(env, error);
      }
      return jsonResponse(env, { error: { message: (error as Error).message } }, { status: 502 });
    }
  }

  if (method === "POST" && url.pathname === "/memory/extraction/ingest") {
    let body: unknown;
    try {
      body = await parseJson(request);
    } catch (error) {
      return invalidRequestResponse(env, error as Error);
    }
    try {
      const result = await enqueueEvidenceExtraction(env, projectScope, body);
      return jsonResponse(env, { ok: true, job_id: result.jobId }, { status: 202 });
    } catch (error) {
      if (error instanceof ClaimSchemaError || error instanceof MemorySchemaError) {
        return invalidRequestResponse(env, error);
      }
      return jsonResponse(env, { error: { message: (error as Error).message } }, { status: 502 });
    }
  }

  if (method === "GET" && url.pathname === "/memory/health") {
    return jsonResponse(env, { ok: true, project_id: projectScope.projectId, namespace: projectScope.namespace });
  }

  if (method === "GET" && url.pathname === "/memory/context") {
    try {
      const context = normalizeContextRequest({
        user_id: url.searchParams.get("user_id"),
        session_id: url.searchParams.get("session_id"),
        query: url.searchParams.get("query"),
        types: url.searchParams.get("types"),
        categories: url.searchParams.get("categories"),
        scope_id: url.searchParams.get("scope_id"),
        workspace_id: url.searchParams.get("workspace_id"),
        limit: url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : undefined,
        profile_only: url.searchParams.get("profile_only") === "true",
      });
      const result = await loadMemoryContext(env, projectScope, context);
      return jsonResponse(env, { ok: true, ...result });
    } catch (error) {
      if (error instanceof ClaimSchemaError || error instanceof MemorySchemaError) {
        return invalidRequestResponse(env, error);
      }
      return jsonResponse(env, { error: { message: (error as Error).message } }, { status: 502 });
    }
  }

  if (method === "GET" && url.pathname === "/memory/claims") {
    try {
      const result = await listDurableMemoryClaims(env.DB, projectScope, parseClaimListOptions(url));
      return jsonResponse(env, { ok: true, ...result });
    } catch (error) {
      if (error instanceof ClaimSchemaError) {
        return invalidRequestResponse(env, error);
      }
      return jsonResponse(env, { error: { message: (error as Error).message } }, { status: 502 });
    }
  }

  if (method === "POST" && url.pathname === "/memory/index") {
    let body: unknown;
    try {
      body = await parseJson(request);
    } catch (error) {
      return invalidRequestResponse(env, error as Error);
    }

    try {
      const items = defaultMemorySchema.normalizeIndexRequest(body);
      if (items.length === 0) {
        return jsonResponse(env, { error: { message: "Missing items. Use {\"text\":\"...\"} or {\"items\":[...]}" } }, { status: 400 });
      }

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

  if (method === "POST" && url.pathname === "/memory/claims") {
    let body: unknown;
    try {
      body = await parseJson(request);
      const mutation = normalizeClaimMutationRequest(body, projectScope);
      const claim = await mutateClaim(env, projectScope, mutation);
      return jsonResponse(env, { ok: true, project_id: projectScope.projectId, claim });
    } catch (error) {
      if (error instanceof ClaimSchemaError || error instanceof MemorySchemaError) {
        return invalidRequestResponse(env, error);
      }
      return jsonResponse(env, { error: { message: (error as Error).message } }, { status: 502 });
    }
  }

  if (method === "POST" && url.pathname === "/memory/forget") {
    try {
      const body = await parseJson(request);
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new ClaimSchemaError("Request body must be an object");
      const scopeKind = (body as Record<string, unknown>).scope_kind;
      const scopeId = (body as Record<string, unknown>).scope_id;
      if ((scopeKind !== "user" && scopeKind !== "session") || typeof scopeId !== "string" || !scopeId.trim()) {
        throw new ClaimSchemaError("scope_kind must be user or session and scope_id must not be empty");
      }
      const result = await forgetScopedMemory(env, projectScope, {
        scopeKind,
        scopeId: scopeId.trim(),
      });
      return jsonResponse(env, { ok: true, project_id: projectScope.projectId, ...result });
    } catch (error) {
      if (error instanceof ClaimSchemaError || error instanceof MemorySchemaError) {
        return invalidRequestResponse(env, error);
      }
      return jsonResponse(env, { error: { message: (error as Error).message } }, { status: 502 });
    }
  }

  if (method === "POST" && url.pathname === "/memory/context") {
    let body: unknown;
    try {
      body = await parseJson(request);
      const context = normalizeContextRequest(body);
      const result = await loadMemoryContext(env, projectScope, context);
      return jsonResponse(env, { ok: true, ...result });
    } catch (error) {
      if (error instanceof ClaimSchemaError || error instanceof MemorySchemaError) {
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
