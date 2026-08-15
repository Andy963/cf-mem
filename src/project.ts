export interface ProjectScope {
  projectId: string;
  namespace: string;
}

// Vectorize rejects vector ids longer than 64 bytes. Every segment id is
// `project:<project_id>:<segment_id>`, so the project id budget and the derived
// hash width both have to be reconciled against this limit.
export const MAX_VECTOR_ID_BYTES = 64;

// 32 keeps `project:<id>:seg_<hash>` within MAX_VECTOR_ID_BYTES for the
// narrowest hash we are willing to derive (see MIN_DERIVED_HASH_CHARS).
const MAX_PROJECT_ID_LENGTH = 32;
const PROJECT_ID_PATTERN = new RegExp(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,${MAX_PROJECT_ID_LENGTH - 1}}$`);

export function normalizeProjectId(value: unknown): string | null {
  if (typeof value !== "string") return null;

  const projectId = value.trim();
  if (!projectId || !PROJECT_ID_PATTERN.test(projectId)) return null;
  return projectId;
}

export function createProjectScope(projectId: string): ProjectScope {
  return {
    projectId,
    namespace: `project:${projectId}`,
  };
}

export function scopeSegmentId(scope: ProjectScope, segmentId: string): string {
  return `${scope.namespace}:${segmentId}`;
}

export function vectorIdByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * Bytes still available for the caller-supplied portion of a scoped segment id,
 * given a fixed prefix such as `seg_` or `pe_`.
 */
export function availableSegmentIdBytes(scope: ProjectScope, prefix: string): number {
  return MAX_VECTOR_ID_BYTES - vectorIdByteLength(scopeSegmentId(scope, prefix));
}
