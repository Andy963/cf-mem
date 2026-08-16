import type { Env } from "../env";
import { jsonResponse, parseJson } from "./http";
import { callTavily, fetchPages, isFetchFailure, tavilyConfigured, type PageFetchResult } from "../web/fetch";

const MAX_EXTRACT_URLS = 10;

type JsonRecord = Record<string, unknown>;

function normalizePath(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}

export function isWebPath(pathname: string): boolean {
  return normalizePath(pathname).startsWith("/web/");
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sanitizePayload(payload: JsonRecord): JsonRecord {
  const result = { ...payload };
  // The relay injects its own upstream credentials; a caller-supplied key would
  // either leak or override that pool.
  delete result.api_key;
  return result;
}

async function readJsonBody(request: Request, env: Env): Promise<JsonRecord | Response> {
  try {
    const body = await parseJson(request);
    if (!isRecord(body)) throw new Error("JSON body must be an object");
    return body;
  } catch (error) {
    return jsonResponse(env, { error: { message: (error as Error).message } }, { status: 400 });
  }
}

function resultProvider(results: PageFetchResult[]): "tavily" | "direct" | "mixed" | "none" {
  const providers = new Set(results.filter((result): result is Exclude<PageFetchResult, { error: string }> => !isFetchFailure(result))
    .map((page) => page.provider));
  if (providers.size === 0) return "none";
  if (providers.size > 1) return "mixed";
  return [...providers][0];
}

/**
 * Returns page text for a list of links regardless of whether the Tavily relay
 * is reachable: every URL the relay does not answer for falls back to a direct
 * fetch individually, so a single failed link no longer downgrades the batch.
 */
async function handleExtract(request: Request, env: Env): Promise<Response> {
  const body = await readJsonBody(request, env);
  if (body instanceof Response) return body;

  const urls = body.urls;
  if (!Array.isArray(urls) || urls.length === 0 || urls.length > MAX_EXTRACT_URLS) {
    return jsonResponse(env, {
      error: { message: `urls must contain between 1 and ${MAX_EXTRACT_URLS} URLs` },
    }, { status: 400 });
  }

  const results = await fetchPages(env, urls.map((url) => String(url)));
  return jsonResponse(env, {
    provider: resultProvider(results),
    tavily_configured: tavilyConfigured(env),
    results: results.filter((result) => !isFetchFailure(result)).map((page) => {
      const fetched = page as Exclude<PageFetchResult, { error: string }>;
      return {
        url: fetched.url,
        final_url: fetched.final_url,
        title: fetched.title,
        raw_content: fetched.text,
        provider: fetched.provider,
        fetched_at: fetched.fetched_at,
      };
    }),
    failed_results: results.filter(isFetchFailure),
  });
}

/**
 * Search and crawl have no local equivalent — there is nothing to fall back to
 * without an index or a crawler, so they stay a straight relay.
 */
async function handleTavilyOnly(request: Request, env: Env, endpoint: "search" | "crawl"): Promise<Response> {
  const body = await readJsonBody(request, env);
  if (body instanceof Response) return body;

  const response = await callTavily(env, endpoint, sanitizePayload(body));
  if (!response) {
    return jsonResponse(env, {
      error: { message: "Tavily relay is not configured or unavailable" },
    }, { status: 503 });
  }
  const payload = await response.json().catch(() => ({ error: { message: "Invalid Tavily response" } }));
  return jsonResponse(
    env,
    { provider: "tavily", ...(isRecord(payload) ? payload : { data: payload }) },
    { status: response.status },
  );
}

export async function handleWebRequest(request: Request, env: Env): Promise<Response> {
  const path = normalizePath(new URL(request.url).pathname);
  if (request.method.toUpperCase() !== "POST") {
    return jsonResponse(env, { error: { message: "Method not allowed" } }, { status: 405, headers: { Allow: "POST" } });
  }
  if (path === "/web/extract") return handleExtract(request, env);
  if (path === "/web/search") return handleTavilyOnly(request, env, "search");
  if (path === "/web/crawl") return handleTavilyOnly(request, env, "crawl");
  return jsonResponse(env, { error: { message: "Not Found" } }, { status: 404 });
}
