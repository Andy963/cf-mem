import type { Env } from "../env";
import type { ProjectScope } from "../project";
import { sha256Hex, truncateText } from "../utils";
import { extractUrlsFromText, fetchPages, isFetchFailure } from "../web/fetch";
import { indexMemoryItems } from "./indexer";
import { defaultMemorySchema, deriveSegmentIdSuffix } from "./schema";

export const WEB_REFERENCE_KIND = "web_reference";

const MAX_URLS_PER_BATCH = 3;
const MAX_REFERENCE_CHARS = 5_000;
const REFERENCE_HASH_CHARS = 40;

// Only line-leading markers matter: `userOriginatedText` splits evidence on
// them, so a page (or a pasted message) containing "\n[user] ..." could
// otherwise smuggle text into the trusted half of the prompt.
const ROLE_MARKER_PATTERN = /^([ \t]*)\[(user|assistant|system|web_reference)\]/gim;
const CLIENT_REFERENCE_BLOCK = /<referenced_web_content\b[^>]*>[\s\S]*?<\/referenced_web_content\s*>/gi;
const CLIENT_REFERENCE_TAG = /<\/?referenced_web_content\b[^>]*>/gi;

export function neutralizeEvidenceMarkers(text: string): string {
  return text.replace(ROLE_MARKER_PATTERN, "$1($2)");
}

/**
 * Page text inlined by a client is dropped rather than trusted. The Worker
 * refetches the link itself, so the trust label on the resulting evidence is
 * one this Worker wrote and can therefore verify.
 */
export function stripClientWebReferenceBlocks(text: string): string {
  return text.replace(CLIENT_REFERENCE_BLOCK, " ").replace(CLIENT_REFERENCE_TAG, " ");
}

export function sanitizeIngestText(text: string): string {
  return neutralizeEvidenceMarkers(stripClientWebReferenceBlocks(text)).trim();
}

function sanitizeReferenceText(text: string): string {
  // Whitespace is collapsed only for fetched pages: user text may be pasted
  // code whose indentation carries meaning.
  const collapsed = sanitizeIngestText(text)
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return truncateText(collapsed, MAX_REFERENCE_CHARS);
}

export interface WebReferenceContext {
  sourceApp: string;
  externalSessionId: string;
  ownerId: string;
  workspaceId: string | null;
}

/**
 * Fetches every link found in a batch of user evidence and stores each page as
 * its own segment. Keeping references out of the user segments is what lets the
 * batching budget count user words only, and what lets the extractor be told
 * exactly which half of the evidence is untrusted.
 *
 * Failures are swallowed on purpose: extraction of the surrounding conversation
 * must not depend on a third-party site being up.
 */
export async function buildWebReferenceSegments(
  env: Env,
  scope: ProjectScope,
  texts: string[],
  context: WebReferenceContext,
): Promise<string[]> {
  const urls: string[] = [];
  for (const text of texts) {
    for (const url of extractUrlsFromText(text, MAX_URLS_PER_BATCH)) {
      if (!urls.includes(url)) urls.push(url);
      if (urls.length >= MAX_URLS_PER_BATCH) break;
    }
    if (urls.length >= MAX_URLS_PER_BATCH) break;
  }
  if (urls.length === 0) return [];

  const pages = await fetchPages(env, urls, { maxChars: MAX_REFERENCE_CHARS });
  const items = [];
  for (const page of pages) {
    if (isFetchFailure(page)) {
      console.warn(`[profile] web reference fetch failed url=${page.url} reason=${page.error}`);
      continue;
    }
    const text = sanitizeReferenceText(page.text);
    if (!text) continue;
    // Hashing content as well as the URL keeps repeated fetches of an unchanged
    // page on one segment, while a changed page becomes a new one instead of
    // silently rewriting evidence an existing claim already cites.
    const contentHash = await sha256Hex(`${page.url}\n${text}`);
    items.push({
      id: deriveSegmentIdSuffix(scope, "wr_", contentHash, REFERENCE_HASH_CHARS),
      text,
      metadata: {
        session_id: `${context.sourceApp}:${context.externalSessionId}`,
        kind: WEB_REFERENCE_KIND,
        source_app: context.sourceApp,
        user_id: context.ownerId,
        workspace_id: context.workspaceId ?? "",
        source_url: page.url,
        final_url: page.final_url,
        title: page.title ?? "",
        fetch_provider: page.provider,
        fetched_at: page.fetched_at,
        content_hash: contentHash,
      },
    });
  }
  if (items.length === 0) return [];

  const prepared = await defaultMemorySchema.prepareIndexItems(items, scope);
  const indexed = await indexMemoryItems(env, prepared);
  return indexed.ids;
}
