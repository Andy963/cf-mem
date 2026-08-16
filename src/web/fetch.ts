import type { Env } from "../env";
import { truncateText } from "../utils";

export type TavilyEndpoint = "search" | "extract" | "crawl";

const MAX_URL_LENGTH = 2_048;
const DIRECT_TIMEOUT_MS = 10_000;
const TAVILY_TIMEOUT_MS = 25_000;
const MAX_DIRECT_CONTENT_BYTES = 512 * 1024;
const MAX_REDIRECTS = 5;
const MAX_URLS_PER_FETCH = 10;

export interface FetchedPage {
  url: string;
  final_url: string;
  title: string | null;
  text: string;
  provider: "tavily" | "direct";
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

function isIpv4Literal(hostname: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname);
}

/**
 * Anything outside the routable public unicast space is refused, including
 * malformed octets — the URL parser already normalizes decimal and octal IPv4
 * forms, so this only has to judge the dotted-quad it produces.
 */
function isBlockedIpv4(hostname: string): boolean {
  const octets = hostname.split(".").map(Number);
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return true;
  const [a, b] = octets;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && (b === 0 || b === 168)) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true;
  return false;
}

/**
 * `URL.hostname` keeps IPv6 literals bracketed and rewrites them to their
 * canonical form (`[::ffff:127.0.0.1]` becomes `[::ffff:7f00:1]`), so the
 * address is expanded to hextets before judging it — and prefix string tests
 * like `startsWith("fc")` are avoided, since those also rejected ordinary
 * domains such as `fc.com`.
 */
function parseIpv6(value: string): number[] | null {
  let text = value;
  const dotted = text.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted && dotted.index !== undefined) {
    const octets = dotted[1].split(".").map(Number);
    if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null;
    const high = ((octets[0] << 8) | octets[1]).toString(16);
    const low = ((octets[2] << 8) | octets[3]).toString(16);
    text = `${text.slice(0, dotted.index)}${high}:${low}`;
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = 8 - head.length - tail.length;
  if (fill < 0 || (halves.length === 1 && fill !== 0)) return null;

  const parts = [...head, ...new Array<string>(halves.length === 2 ? fill : 0).fill("0"), ...tail];
  if (parts.length !== 8) return null;
  const hextets = parts.map((part) => (/^[0-9a-f]{1,4}$/.test(part) ? Number.parseInt(part, 16) : Number.NaN));
  return hextets.some((hextet) => Number.isNaN(hextet)) ? null : hextets;
}

function embeddedIpv4(hextets: number[]): string {
  return [hextets[6] >> 8, hextets[6] & 0xff, hextets[7] >> 8, hextets[7] & 0xff].join(".");
}

function isBlockedIpv6(hostname: string): boolean {
  const hextets = parseIpv6(hostname.slice(1, -1).toLowerCase());
  // An address this parser cannot read is one it cannot vouch for.
  if (!hextets) return true;

  const leading = hextets.slice(0, 7).every((hextet) => hextet === 0);
  if (leading && (hextets[7] === 0 || hextets[7] === 1)) return true;
  if ((hextets[0] & 0xfe00) === 0xfc00) return true;
  if ((hextets[0] & 0xffc0) === 0xfe80) return true;
  // IPv4-mapped (::ffff:0:0/96) and NAT64 (64:ff9b::/96) both tunnel an IPv4
  // address that would otherwise skip the IPv4 rules entirely.
  if (hextets.slice(0, 5).every((hextet) => hextet === 0) && hextets[5] === 0xffff) {
    return isBlockedIpv4(embeddedIpv4(hextets));
  }
  if (hextets[0] === 0x64 && hextets[1] === 0xff9b && hextets.slice(2, 6).every((hextet) => hextet === 0)) {
    return isBlockedIpv4(embeddedIpv4(hextets));
  }
  return false;
}

/**
 * Note the limit: Workers cannot resolve DNS before fetching, so a public name
 * pointing at a private address still passes. Public-internet pages are the
 * declared scope; private and authenticated targets are not.
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

  const blocked = hostname.startsWith("[")
    ? isBlockedIpv6(hostname)
    : isIpv4Literal(hostname)
      ? isBlockedIpv4(hostname)
      // A single-label host can only resolve through a local search domain.
      : BLOCKED_HOSTNAMES.has(hostname)
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

async function readResponseText(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const remaining = maxBytes - total;
      const chunk = value.byteLength > remaining ? value.slice(0, remaining) : value;
      chunks.push(chunk);
      total += chunk.byteLength;
      if (chunk.byteLength < value.byteLength) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return decodeBody(joined, response.headers.get("content-type"));
}

function decodeBody(bytes: Uint8Array, contentType: string | null): string {
  const charset = contentType?.match(/charset\s*=\s*"?([\w-]+)"?/i)?.[1]?.toLowerCase();
  if (charset && charset !== "utf-8" && charset !== "utf8") {
    try {
      return new TextDecoder(charset).decode(bytes);
    } catch {
      // The runtime may not carry that encoding; UTF-8 is the safer default.
    }
  }
  return new TextDecoder().decode(bytes);
}

function decodeHtml(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, value: string) => String.fromCodePoint(Number(value)))
    .replace(/&#x([0-9a-f]+);/gi, (_, value: string) => String.fromCodePoint(Number.parseInt(value, 16)));
}

export function htmlToText(html: string): { title: string | null; content: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeHtml(titleMatch[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()) : null;
  const content = decodeHtml(
    html
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(script|style|noscript|svg|template)[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<(br|hr)\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|section|article|main|h[1-6]|li|tr|blockquote)>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  return { title, content };
}

/**
 * Redirects are followed manually so every hop is re-validated: an allowed
 * public URL that 302s to `http://169.254.169.254/` must not be followed.
 */
export async function fetchPageDirect(url: string): Promise<PageFetchResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DIRECT_TIMEOUT_MS);
  try {
    let currentUrl: URL;
    try {
      currentUrl = publicHttpUrl(url);
    } catch (error) {
      return { url, error: (error as Error).message };
    }

    let response: Response | null = null;
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
      response = await fetch(currentUrl, {
        method: "GET",
        headers: { Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1" },
        redirect: "manual",
        signal: controller.signal,
      });
      if (response.status < 300 || response.status >= 400) break;

      const location = response.headers.get("location");
      if (!location) {
        return { url, error: `Redirect ${response.status} missing Location header` };
      }
      try {
        currentUrl = publicHttpUrl(new URL(location, currentUrl).toString());
      } catch (error) {
        return { url, error: `Blocked redirect target: ${(error as Error).message}` };
      }
      response = null;
    }
    if (!response) return { url, error: "Too many redirects" };

    const finalUrl = currentUrl.toString();
    if (!response.ok) return { url, error: `HTTP ${response.status}` };

    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    const isPlainText = contentType.includes("text/plain");
    if (!isPlainText && !contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) {
      return { url, error: `Unsupported content type: ${contentType || "unknown"}` };
    }

    const raw = await readResponseText(response, MAX_DIRECT_CONTENT_BYTES);
    const parsed = isPlainText ? { title: null, content: raw.trim() } : htmlToText(raw);
    if (!parsed.content) return { url, error: "No readable text found" };

    return {
      url,
      final_url: finalUrl,
      title: parsed.title,
      text: parsed.content,
      provider: "direct",
      fetched_at: Date.now(),
    };
  } catch (error) {
    return { url, error: error instanceof Error && error.name === "AbortError" ? "Request timed out" : "Fetch failed" };
  } finally {
    clearTimeout(timeout);
  }
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
 * Tavily is preferred because it renders and cleans pages far better than a
 * regex; the direct fetcher covers every URL Tavily did not return, so one bad
 * link no longer forces the whole batch onto the weaker path.
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

  const viaTavily = tavilyConfigured(env) && valid.length > 0
    ? await tavilyExtractPages(env, valid)
    : new Map<string, FetchedPage>();

  const missing = valid.filter((url) => !viaTavily.has(url));
  const direct = await Promise.all(missing.map((url) => fetchPageDirect(url)));

  for (const url of valid) {
    const page = viaTavily.get(url);
    results.set(url, page ?? direct[missing.indexOf(url)]);
  }

  const maxChars = options.maxChars;
  return [...results.values()].map((result) => {
    if (isFetchFailure(result) || !maxChars) return result;
    return { ...result, text: truncateText(result.text, maxChars) };
  });
}
