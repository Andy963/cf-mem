import type { Primitive } from "../env";
import { normalizeClaimCategoryList, type ClaimCategory } from "./claims";
import {
  availableSegmentIdBytes,
  MAX_VECTOR_ID_BYTES,
  normalizeProjectId,
  scopeSegmentId,
  vectorIdByteLength,
  type ProjectScope,
} from "../project";
import { clampInt } from "../utils";

export class MemorySchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemorySchemaError";
  }
}

export interface IndexItemInput {
  id?: string;
  text: string;
  metadata?: Record<string, unknown>;
}

export interface SearchRequestInput {
  projectId: string;
  namespace: string;
  query: string;
  topK?: number;
  filter?: Record<string, Primitive>;
  categories?: ClaimCategory[];
}

export interface PreparedIndexItem {
  item: IndexItemInput;
  id: string;
  text: string;
  contentHash: string;
  metadataJson: string;
  projectId: string;
  namespace: string;
  sessionId: string | null;
  tape: string | null;
  vectorMetadata?: Record<string, Primitive>;
}

export interface StoredMemoryRow extends Record<string, unknown> {
  id: string;
}

export interface MemoryShapeAdapter {
  normalizeIndexRequest(body: unknown): IndexItemInput[];
  normalizeSearchRequest(body: unknown, projectScope: ProjectScope): SearchRequestInput | null;
  prepareIndexItems(items: IndexItemInput[], projectScope: ProjectScope): Promise<PreparedIndexItem[]>;
  getQueryText(request: SearchRequestInput): string;
  getRequestedTopK(request: SearchRequestInput): number;
  getCandidateTopK(request: SearchRequestInput): number;
  getFilter(request: SearchRequestInput): Record<string, Primitive> | undefined;
  matchesFilter(row: StoredMemoryRow | undefined, metadata: unknown, request: SearchRequestInput): boolean;
  toSearchMatch(row: StoredMemoryRow, score: number | null, metadata: unknown): Record<string, unknown>;
}

function isIndexItemInput(value: unknown): value is IndexItemInput {
  if (!value || typeof value !== "object") return false;

  const record = value as Record<string, unknown>;
  if (typeof record.text !== "string") return false;
  if (record.id !== undefined && typeof record.id !== "string") return false;
  if (record.metadata !== undefined && (typeof record.metadata !== "object" || record.metadata === null || Array.isArray(record.metadata))) {
    return false;
  }

  return true;
}

/**
 * Index requests used to silently drop malformed entries, so a caller sending 10
 * items could get back "8 indexed" with no indication that 2 were discarded.
 */
function requireIndexItemInput(value: unknown, index: number): IndexItemInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MemorySchemaError(`items[${index}] must be an object`);
  }

  const record = value as Record<string, unknown>;
  if (typeof record.text !== "string") throw new MemorySchemaError(`items[${index}].text must be a string`);
  if (record.id !== undefined && typeof record.id !== "string") {
    throw new MemorySchemaError(`items[${index}].id must be a string`);
  }
  if (record.metadata !== undefined && (typeof record.metadata !== "object" || record.metadata === null || Array.isArray(record.metadata))) {
    throw new MemorySchemaError(`items[${index}].metadata must be an object`);
  }

  return value as IndexItemInput;
}

function safeString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

const FILTERED_CANDIDATE_MULTIPLIER = 10;
const MAX_VECTOR_QUERY_TOP_K = 100;

const DERIVED_ID_PREFIX = "seg_";
const DERIVED_ID_HASH_CHARS = 32;
// 64 bits of digest is still collision-safe within a single project namespace.
const MIN_DERIVED_HASH_CHARS = 16;

function sanitizeFilter(filter: Record<string, Primitive> | undefined, projectId: string): Record<string, Primitive> | undefined {
  if (!filter) return undefined;

  const sanitized: Record<string, Primitive> = {};
  for (const [key, value] of Object.entries(filter)) {
    if (key === "project_id") {
      if (normalizeProjectId(value) !== projectId) {
        throw new MemorySchemaError("filter.project_id does not match the authenticated project");
      }
      continue;
    }

    sanitized[key] = value;
  }

  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function buildVectorMetadata(metadata?: Record<string, unknown>): Record<string, Primitive> | undefined {
  if (!metadata) return undefined;

  const projected: Record<string, Primitive> = {};
  for (const key of ["project_id", "session_id", "tape", "kind", "chat_id", "user_id", "category", "workspace_id"]) {
    const value = metadata[key];
    if (typeof value === "string" && value) projected[key] = value;
    if (typeof value === "number" && Number.isFinite(value)) projected[key] = value;
    if (typeof value === "boolean") projected[key] = value;
  }

  return Object.keys(projected).length > 0 ? projected : undefined;
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function mergeProjectMetadata(metadata: Record<string, unknown> | undefined, projectId: string): Record<string, unknown> {
  const merged = { ...(metadata ?? {}) };
  if (Object.prototype.hasOwnProperty.call(merged, "project_id") && normalizeProjectId(merged.project_id) !== projectId) {
    throw new MemorySchemaError("metadata.project_id does not match the authenticated project");
  }

  merged.project_id = projectId;
  return merged;
}

/**
 * Narrows a hex digest to whatever MAX_VECTOR_ID_BYTES leaves after the
 * `project:<id>:<prefix>` header. Project ids up to the 32-char cap always leave
 * at least MIN_DERIVED_HASH_CHARS, so this only ever narrows below the requested
 * width for ids that could not be indexed at all before. Returns the unscoped
 * suffix — callers that need a vector id still go through scopeSegmentId.
 */
export function deriveSegmentIdSuffix(
  projectScope: ProjectScope,
  prefix: string,
  hash: string,
  preferredHashChars: number,
): string {
  const available = availableSegmentIdBytes(projectScope, prefix);
  const hashChars = Math.min(preferredHashChars, hash.length, available);
  if (hashChars < MIN_DERIVED_HASH_CHARS) {
    throw new MemorySchemaError(
      `project_id "${projectScope.projectId}" is too long to derive a segment id within the ${MAX_VECTOR_ID_BYTES}-byte vector id limit`,
    );
  }

  return `${prefix}${hash.slice(0, hashChars)}`;
}

async function resolveItemId(item: IndexItemInput, metadata: Record<string, unknown>, projectScope: ProjectScope): Promise<string> {
  const explicitId = item.id?.trim();
  if (explicitId) {
    const scopedId = scopeSegmentId(projectScope, explicitId);
    const byteLength = vectorIdByteLength(scopedId);
    if (byteLength > MAX_VECTOR_ID_BYTES) {
      throw new MemorySchemaError(
        `id is too long: "${scopedId}" is ${byteLength} bytes once scoped to the project, exceeding the ${MAX_VECTOR_ID_BYTES}-byte vector id limit`,
      );
    }
    return scopedId;
  }

  const sessionId = safeString(metadata.session_id) ?? "";
  const tape = safeString(metadata.tape) ?? "";
  const basis = `${projectScope.projectId}\n${sessionId}\n${tape}\n${item.text}`;
  const hash = await sha256Hex(basis);
  return scopeSegmentId(projectScope, deriveSegmentIdSuffix(projectScope, DERIVED_ID_PREFIX, hash, DERIVED_ID_HASH_CHARS));
}

function getByPath(source: unknown, path: string): unknown {
  if (!source || typeof source !== "object") return undefined;

  const parts = path.split(".").filter((part) => part);
  let current: unknown = source;
  for (const part of parts) {
    if (!current || typeof current !== "object") return undefined;
    const record = current as Record<string, unknown>;
    if (!(part in record)) return undefined;
    current = record[part];
  }

  return current;
}

function matchesPrimitive(actual: unknown, expected: Primitive): boolean {
  if (typeof expected === "string") return typeof actual === "string" && actual === expected;
  if (typeof expected === "number") return typeof actual === "number" && actual === expected;
  if (typeof expected === "boolean") return typeof actual === "boolean" && actual === expected;
  return false;
}

export const defaultMemorySchema: MemoryShapeAdapter = {
  normalizeIndexRequest(body: unknown): IndexItemInput[] {
    if (Array.isArray(body)) {
      return body.map(requireIndexItemInput);
    }

    if (body && typeof body === "object") {
      const record = body as Record<string, unknown>;
      if (Array.isArray(record.items)) {
        return record.items.map(requireIndexItemInput);
      }
    }

    if (isIndexItemInput(body)) return [body];
    return [];
  },

  normalizeSearchRequest(body: unknown, projectScope: ProjectScope): SearchRequestInput | null {
    if (!body || typeof body !== "object") return null;

    const record = body as Record<string, unknown>;
    if (typeof record.query !== "string") return null;

    const rawTopK = record.topK ?? record.top_k;
    const topK = typeof rawTopK === "number" ? rawTopK : undefined;
    const rawFilter: Record<string, Primitive> = record.filter && typeof record.filter === "object" && !Array.isArray(record.filter)
      ? { ...(record.filter as Record<string, Primitive>) }
      : {};

    if (record.workspace_id !== undefined && record.workspace_id !== null) {
      if (typeof record.workspace_id !== "string" || !record.workspace_id.trim()) {
        throw new MemorySchemaError("workspace_id must be a non-empty string");
      }
      const workspaceId = record.workspace_id.trim();
      if (rawFilter.workspace_id !== undefined && rawFilter.workspace_id !== workspaceId) {
        throw new MemorySchemaError("workspace_id conflicts with filter.workspace_id");
      }
      rawFilter.workspace_id = workspaceId;
    }
    let categories: ClaimCategory[] | undefined;
    try {
      const requestedCategories = record.categories !== undefined
        ? record.categories
        : record.category !== undefined
          ? record.category
          : rawFilter.category;
      categories = normalizeClaimCategoryList(requestedCategories) ?? ["domain_fact"];
    } catch (error) {
      throw new MemorySchemaError(error instanceof Error ? error.message : "categories are invalid");
    }
    if (categories.length === 1) {
      rawFilter.category = categories[0];
    } else {
      delete rawFilter.category;
    }

    return {
      projectId: projectScope.projectId,
      namespace: projectScope.namespace,
      query: record.query,
      topK,
      filter: sanitizeFilter(Object.keys(rawFilter).length > 0 ? rawFilter : undefined, projectScope.projectId),
      categories,
    };
  },

  async prepareIndexItems(items: IndexItemInput[], projectScope: ProjectScope): Promise<PreparedIndexItem[]> {
    return await Promise.all(
      items.map(async (item) => {
        const metadata = mergeProjectMetadata(item.metadata, projectScope.projectId);
        const id = await resolveItemId(item, metadata, projectScope);
        const contentHash = await sha256Hex(item.text);
        const metadataJson = JSON.stringify(metadata);
        const sessionId = safeString(metadata.session_id);
        const tape = safeString(metadata.tape);

        return {
          item,
          id,
          text: item.text,
          contentHash,
          metadataJson,
          projectId: projectScope.projectId,
          namespace: projectScope.namespace,
          sessionId,
          tape,
          vectorMetadata: buildVectorMetadata(metadata),
        };
      }),
    );
  },

  getQueryText(request: SearchRequestInput): string {
    return request.query;
  },

  getRequestedTopK(request: SearchRequestInput): number {
    return clampInt(request.topK ?? 5, 1, 50);
  },

  getCandidateTopK(request: SearchRequestInput): number {
    const requestedTopK = clampInt(request.topK ?? 5, 1, 50);
    return request.filter || (request.categories && request.categories.length > 0)
      ? clampInt(requestedTopK * FILTERED_CANDIDATE_MULTIPLIER, requestedTopK, MAX_VECTOR_QUERY_TOP_K)
      : requestedTopK;
  },

  getFilter(request: SearchRequestInput): Record<string, Primitive> | undefined {
    return request.filter;
  },

  matchesFilter(row: StoredMemoryRow | undefined, metadata: unknown, request: SearchRequestInput): boolean {
    if (row?.project_id !== request.projectId) return false;

    const metadataProjectId = getByPath(metadata, "project_id");
    if (metadataProjectId !== undefined && normalizeProjectId(metadataProjectId) !== request.projectId) {
      return false;
    }

    if (request.categories && request.categories.length > 0) {
      const rawCategory = getByPath(metadata, "category");
      const category = typeof rawCategory === "string" && rawCategory.trim() ? rawCategory : "domain_fact";
      if (!request.categories.includes(category as ClaimCategory)) return false;
    }

    if (!request.filter) return true;

    for (const [key, expected] of Object.entries(request.filter)) {
      let actual: unknown;
      if (key === "session_id") actual = row?.session_id;
      else if (key === "tape") actual = row?.tape;
      else if (key === "project_id") actual = row?.project_id;
      else if (key === "category") {
        const rawCategory = getByPath(metadata, key);
        actual = typeof rawCategory === "string" && rawCategory.trim() ? rawCategory : "domain_fact";
      }
      else actual = getByPath(metadata, key);

      if (!matchesPrimitive(actual, expected)) return false;
    }

    return true;
  },

  toSearchMatch(row: StoredMemoryRow, score: number | null, metadata: unknown): Record<string, unknown> {
    return {
      id: row.id,
      score,
      text: row.text ?? null,
      metadata,
      project_id: row.project_id ?? null,
      session_id: row.session_id ?? null,
      tape: row.tape ?? null,
      created_at: row.created_at ?? null,
      updated_at: row.updated_at ?? null,
    };
  },
};
