import type { Env } from "../env";
import { truncateText } from "../utils";

export type TavilyEndpoint = "search" | "extract" | "crawl";

const MAX_URL_LENGTH = 2_048;
const TAVILY_TIMEOUT_MS = 25_000;
const MAX_URLS_PER_FETCH = 10;

export interface FetchedPage {
  url: string;
  final_url: string;
  title: string | null;
  text: string;
  provider: "tavily";
  fetched_at: number;
}

export interface FetchFailure {
  url: string;
  error: string;
}

export type PageFetchResult = FetchedPage | FetchFailure;

export function isFetchFailure(result: PageFetchResult): result is FetchFailure {
  return typeof (result as FetchFailure).error === "string";
}

export function tavilyBaseUrl(env: Env): string | null {
  const raw = env.TAVILY_BASE_URL?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return raw.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

export function tavilyConfigured(env: Env): boolean {
  return Boolean(tavilyBaseUrl(env) && env.TAVILY_API_TOKEN?.trim());
}

/**
 * Returns null when the relay is unconfigured or unreachable, so every caller
 * has a single "no upstream answer" case to branch on instead of distinguishing
 * a missing binding from a network error.
 */
export async function callTavily(
  env: Env,
  endpoint: TavilyEndpoint,
  payload: Record<string, unknown>,
  timeoutMs = TAVILY_TIMEOUT_MS,
): Promise<Response | null> {
  const baseUrl = tavilyBaseUrl(env);
  const token = env.TAVILY_API_TOKEN?.trim();
  if (!baseUrl || !token) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(`${baseUrl}/${endpoint}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

const BLOCKED_HOSTNAMES = new Set(["localhost", "broadcasthost", "ip6-localhost", "ip6-loopback"]);
const BLOCKED_HOSTNAME_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa", ".onion"];

function isIpLiteral(hostname: string): boolean {
  return hostname.startsWith("[") || /^(?:\d{1,3}\.){3}\d{1,3}$/.test(hostname);
}

/**
 * Validates URL syntax before submitting a user-provided target to the relay.
 * This is not a network allowlist: DNS and outbound network policy belong to
 * the authenticated relay, which is the only component that fetches the URL.
 */
export function publicHttpUrl(raw: unknown): URL {
  if (typeof raw !== "string" || !raw.trim() || raw.length > MAX_URL_LENGTH) {
    throw new Error(`URL must be a non-empty string no longer than ${MAX_URL_LENGTH} characters`);
  }

  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`Invalid URL: ${raw}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http and https URLs are allowed");
  }
  if (url.username || url.password) {
    throw new Error("URLs must not contain credentials");
  }
  if (url.port && url.port !== "80" && url.port !== "443") {
    throw new Error("Only ports 80 and 443 are allowed");
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!hostname) throw new Error("URL must have a hostname");

  const blocked = isIpLiteral(hostname)
    // A single-label host can only resolve through a local search domain.
    || BLOCKED_HOSTNAMES.has(hostname)
    || !hostname.includes(".")
    || BLOCKED_HOSTNAME_SUFFIXES.some((suffix) => hostname.endsWith(suffix));
  if (blocked) throw new Error("Private, local, or non-public URLs are not allowed");

  return url;
}

const URL_PATTERN = /https?:\/\/[^\s<>"'`\\　-〿＀-￯]+/gi;

/**
 * Pulls candidate links out of free-form user text. Trailing punctuation is
 * trimmed because "see https://example.com/style." would otherwise fetch a URL
 * with the sentence period glued on.
 */
export function extractUrlsFromText(text: string, limit: number): string[] {
  if (!text || limit <= 0) return [];
  const found: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(URL_PATTERN)) {
    const trimmed = match[0].replace(/[.,;:!?'")\]}]+$/, "");
    let normalized: string;
    try {
      normalized = publicHttpUrl(trimmed).toString();
    } catch {
      continue;
    }
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    found.push(normalized);
    if (found.length >= limit) break;
  }
  return found;
}

function normalizedUrlKey(value: string): string {
  return value.replace(/\/+$/, "").toLowerCase();
}

async function tavilyExtractPages(env: Env, urls: string[]): Promise<Map<string, FetchedPage>> {
  const pages = new Map<string, FetchedPage>();
  const response = await callTavily(env, "extract", { urls });
  if (!response?.ok) return pages;

  const payload = await response.json().catch(() => null) as { results?: unknown } | null;
  if (!payload || !Array.isArray(payload.results)) return pages;

  const byKey = new Map(urls.map((url) => [normalizedUrlKey(url), url]));
  const fetchedAt = Date.now();
  for (const entry of payload.results) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const resultUrl = typeof record.url === "string" ? record.url : "";
    const requested = byKey.get(normalizedUrlKey(resultUrl));
    const text = typeof record.raw_content === "string" && record.raw_content.trim()
      ? record.raw_content.trim()
      : typeof record.content === "string" ? record.content.trim() : "";
    if (!requested || !text) continue;
    pages.set(requested, {
      url: requested,
      final_url: resultUrl || requested,
      title: typeof record.title === "string" && record.title.trim() ? record.title.trim() : null,
      text,
      provider: "tavily",
      fetched_at: fetchedAt,
    });
  }
  return pages;
}

/**
 * The single entry point for "give me the readable text behind these links".
 * Every external page is fetched by the authenticated Tavily relay. A relay
 * outage or omitted result is returned as a per-URL failure instead of falling
 * back to a Worker outbound request.
 */
export async function fetchPages(
  env: Env,
  rawUrls: string[],
  options: { maxChars?: number } = {},
): Promise<PageFetchResult[]> {
  const results = new Map<string, PageFetchResult>();
  const valid: string[] = [];
  for (const raw of rawUrls.slice(0, MAX_URLS_PER_FETCH)) {
    try {
      const normalized = publicHttpUrl(raw).toString();
      if (results.has(normalized) || valid.includes(normalized)) continue;
      valid.push(normalized);
    } catch (error) {
      results.set(String(raw), { url: String(raw), error: (error as Error).message });
    }
  }

  if (!tavilyConfigured(env)) {
    for (const url of valid) {
      results.set(url, { url, error: "tavily_relay_required" });
    }
  } else {
    const viaTavily = valid.length > 0 ? await tavilyExtractPages(env, valid) : new Map<string, FetchedPage>();
    for (const url of valid) {
      results.set(url, viaTavily.get(url) ?? { url, error: "url_fetch_unavailable" });
    }
  }

  const maxChars = options.maxChars;
  return [...results.values()].map((result) => {
    if (isFetchFailure(result) || !maxChars) return result;
    return { ...result, text: truncateText(result.text, maxChars) };
  });
}
