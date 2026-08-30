import type { ClaimApplicability, ClaimCategory, ClaimInput, ClaimProvenance, ClaimStatus, ClaimType, ScopeKind } from "../memory/claims";
import type { PreparedIndexItem, StoredMemoryRow } from "../memory/schema";
import { chunkArray } from "../utils";

// Keep one bind slot for project_id so D1 IN queries stay under the variable limit.
const D1_IN_QUERY_CHUNK_SIZE = 99;
const D1_BATCH_CHUNK_SIZE = 50;

const CLAIM_COLUMNS =
  "id, project_id, scope_kind, scope_id, category, type, subject, memory_key, value_json, canonical_text, status, provenance, confidence, valid_from, valid_until, superseded_by, applicability, workspace_id, use_count, last_used_at, created_at, updated_at";

export interface StoredClaimRow extends Record<string, unknown> {
  id: string;
  project_id: string;
  scope_kind: ScopeKind;
  scope_id: string;
  category: ClaimCategory;
  type: ClaimType;
  subject: string;
  memory_key: string;
  value_json: string;
  canonical_text: string;
  status: ClaimStatus;
  provenance: ClaimProvenance;
  confidence: number;
  valid_from: number | null;
  valid_until: number | null;
  superseded_by: string | null;
  applicability: ClaimApplicability;
  workspace_id: string | null;
  use_count: number;
  last_used_at: number | null;
  created_at: number;
  updated_at: number;
}

export async function fetchExistingHashes(db: D1Database, projectId: string, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();

  const hashesById = new Map<string, string>();

  for (const chunk of chunkArray(ids, D1_IN_QUERY_CHUNK_SIZE)) {
    const placeholders = chunk.map(() => "?").join(",");
    const sql = `SELECT id, content_hash FROM memory_segments WHERE project_id = ? AND deletion_state = 'active' AND id IN (${placeholders})`;
    const result = await db.prepare(sql).bind(projectId, ...chunk).all();

    for (const row of result.results as Array<Record<string, unknown>>) {
      const id = row.id;
      const contentHash = row.content_hash;
      if (typeof id === "string" && typeof contentHash === "string") {
        hashesById.set(id, contentHash);
      }
    }
  }

  return hashesById;
}

export async function fetchByIds(db: D1Database, projectId: string, ids: string[]): Promise<Map<string, StoredMemoryRow>> {
  if (ids.length === 0) return new Map();

  const rowsById = new Map<string, StoredMemoryRow>();

  for (const chunk of chunkArray(ids, D1_IN_QUERY_CHUNK_SIZE)) {
    const placeholders = chunk.map(() => "?").join(",");
    const sql = `SELECT id, project_id, text, metadata_json, session_id, tape, created_at, updated_at FROM memory_segments WHERE project_id = ? AND deletion_state = 'active' AND id IN (${placeholders})`;
    const result = await db.prepare(sql).bind(projectId, ...chunk).all();

    for (const row of result.results as Array<Record<string, unknown>>) {
      const id = row.id;
      if (typeof id === "string") {
        rowsById.set(id, row as StoredMemoryRow);
      }
    }
  }

  return rowsById;
}

export async function upsertSegments(db: D1Database, items: PreparedIndexItem[], now: number, expiresAt: number): Promise<void> {
  if (items.length === 0) return;

  const statements: D1PreparedStatement[] = [];
  for (const item of items) {
    statements.push(
      db.prepare(
        "INSERT INTO memory_segments (id, project_id, text, content_hash, metadata_json, session_id, tape, created_at, updated_at, expires_at, deletion_state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active') " +
          "ON CONFLICT(id) DO UPDATE SET text=excluded.text, content_hash=excluded.content_hash, metadata_json=excluded.metadata_json, session_id=excluded.session_id, tape=excluded.tape, updated_at=excluded.updated_at, expires_at=excluded.expires_at, deletion_state='active' " +
          // Ids already carry a `project:<id>:` prefix so a cross-project collision
          // is not reachable today; the guard keeps that from silently becoming a
          // project takeover if the id scheme ever changes.
          "WHERE memory_segments.project_id = excluded.project_id",
      ).bind(item.id, item.projectId, item.text, item.contentHash, item.metadataJson, item.sessionId, item.tape, now, now, expiresAt),
      // Re-indexing a segment cancels any pending deletion for it. Paired with
      // its insert (rather than issuing one round trip per item afterwards) so
      // the even-sized batch chunks never split a pair.
      db
        .prepare("DELETE FROM memory_deletion_jobs WHERE project_id = ? AND resource_type = 'segment' AND resource_id = ?")
        .bind(item.projectId, item.id),
    );
  }

  for (const statementBatch of chunkArray(statements, D1_BATCH_CHUNK_SIZE)) {
    await db.batch(statementBatch);
  }
}

export async function fetchSegmentsInProject(db: D1Database, projectId: string, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();

  const found = new Set<string>();
  for (const chunk of chunkArray(ids, D1_IN_QUERY_CHUNK_SIZE)) {
    const placeholders = chunk.map(() => "?").join(",");
    const result = await db
      .prepare(`SELECT id FROM memory_segments WHERE project_id = ? AND deletion_state = 'active' AND id IN (${placeholders})`)
      .bind(projectId, ...chunk)
      .all();
    for (const row of result.results as Array<Record<string, unknown>>) {
      if (typeof row.id === "string") found.add(row.id);
    }
  }
  return found;
}

export async function fetchClaimById(db: D1Database, projectId: string, claimId: string): Promise<StoredClaimRow | null> {
  const result = await db
    .prepare(
      `SELECT ${CLAIM_COLUMNS} FROM memory_claims WHERE project_id = ? AND id = ?`,
    )
    .bind(projectId, claimId)
    .first<StoredClaimRow>();
  return result ?? null;
}

export async function fetchClaimsByIds(db: D1Database, projectId: string, ids: string[]): Promise<Map<string, StoredClaimRow>> {
  const claims = new Map<string, StoredClaimRow>();
  for (const chunk of chunkArray(ids, D1_IN_QUERY_CHUNK_SIZE)) {
    const placeholders = chunk.map(() => "?").join(",");
    const result = await db
      .prepare(
        `SELECT ${CLAIM_COLUMNS} FROM memory_claims WHERE project_id = ? AND id IN (${placeholders})`,
      )
      .bind(projectId, ...chunk)
      .all<StoredClaimRow>();
    for (const claim of result.results) claims.set(claim.id, claim);
  }
  return claims;
}

export async function fetchActiveClaimByIdentity(
  db: D1Database,
  projectId: string,
  claim: Pick<ClaimInput, "scopeKind" | "scopeId" | "category" | "type" | "subject" | "memoryKey" | "workspaceId">,
): Promise<StoredClaimRow | null> {
  const now = Date.now();
  const result = await db
    .prepare(
      `SELECT ${CLAIM_COLUMNS} FROM memory_claims WHERE project_id = ? AND scope_kind = ? AND scope_id = ? AND category = ? AND type = ? AND subject = ? AND memory_key = ? AND COALESCE(workspace_id, '') = COALESCE(?, '') AND status = 'active' AND ((category != 'task_state' AND type != 'task_state') OR (category = 'task_state' AND type = 'task_state' AND valid_until > ?))`,
    )
    .bind(projectId, claim.scopeKind, claim.scopeId, claim.category, claim.type, claim.subject, claim.memoryKey, claim.workspaceId, now)
    .first<StoredClaimRow>();
  return result ?? null;
}

/**
 * Finds an expired task-state identity before inserting its next version.
 * SQLite's active-identity index cannot express a time-dependent predicate, so
 * callers must replace the row and insert its next version in one D1 batch.
 */
export async function fetchExpiredTaskStateClaim(
  db: D1Database,
  projectId: string,
  claim: Pick<ClaimInput, "scopeKind" | "scopeId" | "category" | "type" | "subject" | "memoryKey" | "workspaceId">,
  now: number = Date.now(),
): Promise<StoredClaimRow | null> {
  if (claim.category !== "task_state" && claim.type !== "task_state") return null;

  const expired = await db
    .prepare(
      `SELECT ${CLAIM_COLUMNS} FROM memory_claims WHERE project_id = ? AND scope_kind = ? AND scope_id = ? AND category = ? AND type = ? AND subject = ? AND memory_key = ? AND COALESCE(workspace_id, '') = COALESCE(?, '') AND status = 'active' AND valid_until IS NOT NULL AND valid_until <= ?`,
    )
    .bind(projectId, claim.scopeKind, claim.scopeId, claim.category, claim.type, claim.subject, claim.memoryKey, claim.workspaceId, now)
    .first<StoredClaimRow>();
  return expired ?? null;
}

export async function fetchActiveClaimsBySemanticScope(
  db: D1Database,
  projectId: string,
  claim: Pick<ClaimInput, "scopeKind" | "scopeId" | "category" | "type" | "workspaceId">,
  now: number,
): Promise<StoredClaimRow[]> {
  const result = await db
    .prepare(
      `SELECT ${CLAIM_COLUMNS} FROM memory_claims WHERE project_id = ? AND scope_kind = ? AND scope_id = ? AND category = ? AND type = ? AND COALESCE(workspace_id, '') = COALESCE(?, '') AND status = 'active' AND (valid_from IS NULL OR valid_from <= ?) AND (valid_until IS NULL OR valid_until > ?) AND ((category != 'task_state' AND type != 'task_state') OR (category = 'task_state' AND type = 'task_state' AND valid_until IS NOT NULL))`,
    )
    .bind(projectId, claim.scopeKind, claim.scopeId, claim.category, claim.type, claim.workspaceId, now, now)
    .all<StoredClaimRow>();
  return result.results;
}

function insertClaimStatement(
  db: D1Database,
  projectId: string,
  claimId: string,
  claim: ClaimInput,
  status: ClaimStatus,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      "INSERT INTO memory_claims (id, project_id, scope_kind, scope_id, category, type, subject, memory_key, value_json, canonical_text, status, provenance, confidence, valid_from, valid_until, superseded_by, applicability, workspace_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)",
    )
    .bind(
      claimId,
      projectId,
      claim.scopeKind,
      claim.scopeId,
      claim.category,
      claim.type,
      claim.subject,
      claim.memoryKey,
      JSON.stringify(claim.value),
      claim.canonicalText,
      status,
      claim.provenance,
      claim.confidence,
      claim.validFrom,
      claim.validUntil,
      claim.applicability,
      claim.workspaceId,
      now,
      now,
    );
}

function evidenceStatements(
  db: D1Database,
  projectId: string,
  claimId: string,
  segmentIds: string[],
  relation: "supports" | "contradicts",
  now: number,
): D1PreparedStatement[] {
  return segmentIds.map((segmentId) =>
    db
      .prepare(
        "INSERT OR IGNORE INTO memory_evidence (claim_id, project_id, segment_id, relation, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(claimId, projectId, segmentId, relation, now),
  );
}

export async function insertClaimWithEvidence(
  db: D1Database,
  projectId: string,
  claimId: string,
  claim: ClaimInput,
  status: ClaimStatus,
  now: number,
): Promise<void> {
  await db.batch([
    insertClaimStatement(db, projectId, claimId, claim, status, now),
    ...evidenceStatements(db, projectId, claimId, claim.evidenceSegmentIds, "supports", now),
  ]);
}

export async function insertClaimEvidence(
  db: D1Database,
  projectId: string,
  claimId: string,
  segmentIds: string[],
  relation: "supports" | "contradicts",
  now: number,
): Promise<void> {
  if (segmentIds.length === 0) return;

  const statements = evidenceStatements(db, projectId, claimId, segmentIds, relation, now);
  for (const statementBatch of chunkArray(statements, D1_BATCH_CHUNK_SIZE)) {
    await db.batch(statementBatch);
  }
}

export async function supersedeClaim(db: D1Database, projectId: string, claimId: string, replacementId: string, now: number): Promise<void> {
  await db
    .prepare(
      "UPDATE memory_claims SET status = 'superseded', superseded_by = ?, valid_until = COALESCE(valid_until, ?), updated_at = ? WHERE project_id = ? AND id = ? AND status = 'active'",
    )
    .bind(replacementId, now, now, projectId, claimId)
    .run();
}

export async function replaceActiveClaim(
  db: D1Database,
  projectId: string,
  previousClaimId: string,
  replacementClaimId: string,
  claim: ClaimInput,
  now: number,
): Promise<void> {
  await db.batch([
    db
      .prepare(
        "UPDATE memory_claims SET status = 'superseded', superseded_by = ?, valid_until = COALESCE(valid_until, ?), updated_at = ? WHERE project_id = ? AND id = ? AND status = 'active'",
      )
      .bind(replacementClaimId, now, now, projectId, previousClaimId),
    insertClaimStatement(db, projectId, replacementClaimId, claim, "active", now),
    ...evidenceStatements(db, projectId, replacementClaimId, claim.evidenceSegmentIds, "supports", now),
  ]);
}

export async function reinforceClaim(
  db: D1Database,
  projectId: string,
  claimId: string,
  confidence: number | null,
  now: number,
): Promise<void> {
  if (confidence === null) {
    await db
      .prepare("UPDATE memory_claims SET updated_at = ? WHERE project_id = ? AND id = ? AND status = 'active'")
      .bind(now, projectId, claimId)
      .run();
    return;
  }

  await db
    .prepare("UPDATE memory_claims SET confidence = MAX(confidence, ?), updated_at = ? WHERE project_id = ? AND id = ? AND status = 'active'")
    .bind(confidence, now, projectId, claimId)
    .run();
}

export async function retractClaim(db: D1Database, projectId: string, claimId: string, now: number): Promise<void> {
  await db
    .prepare("UPDATE memory_claims SET status = 'retracted', valid_until = COALESCE(valid_until, ?), updated_at = ? WHERE project_id = ? AND id = ? AND status = 'active'")
    .bind(now, now, projectId, claimId)
    .run();
}

export async function fetchContextClaims(
  db: D1Database,
  projectId: string,
  options: {
    userId: string | null;
    sessionId: string | null;
    types: ClaimType[] | null;
    categories?: ClaimCategory[] | null;
    workspaceId?: string | null;
    includeProject?: boolean;
    limit: number;
  },
): Promise<StoredClaimRow[]> {
  const now = Date.now();
  const scopes: Array<[ScopeKind, string, number]> = options.includeProject === false
    ? []
    : [["project", projectId, 1]];
  if (options.userId) scopes.unshift(["user", options.userId, 0]);
  if (options.sessionId) scopes.push(["session", options.sessionId, 2]);
  if (scopes.length === 0) return [];

  const scopeConditions = scopes.map(() => "(scope_kind = ? AND scope_id = ?)").join(" OR ");
  const scopeBindings = scopes.flatMap(([scopeKind, scopeId]) => [scopeKind, scopeId]);
  const typeConditions = options.types?.length ? ` AND type IN (${options.types.map(() => "?").join(",")})` : "";
  const typeBindings = options.types ?? [];
  const categoryConditions = options.categories?.length ? ` AND category IN (${options.categories.map(() => "?").join(",")})` : "";
  const categoryBindings = options.categories ?? [];
  const workspaceBinding = options.workspaceId ?? null;
  const priority = "CASE scope_kind WHEN 'user' THEN 0 WHEN 'project' THEN 1 WHEN 'session' THEN 2 ELSE 3 END";
  const result = await db
    .prepare(
      `SELECT ${CLAIM_COLUMNS} FROM memory_claims WHERE project_id = ? AND status = 'active' AND (valid_from IS NULL OR valid_from <= ?) AND (valid_until IS NULL OR valid_until > ?) AND ((category != 'task_state' AND type != 'task_state') OR (category = 'task_state' AND type = 'task_state' AND valid_until IS NOT NULL)) AND (applicability != 'workspace' OR workspace_id = ?) AND (${scopeConditions})${typeConditions}${categoryConditions} ORDER BY ${priority} ASC, updated_at DESC LIMIT ?`,
    )
    .bind(projectId, now, now, workspaceBinding, ...scopeBindings, ...typeBindings, ...categoryBindings, options.limit)
    .all<StoredClaimRow>();
  return result.results;
}

export async function fetchGlobalProfileClaims(
  db: D1Database,
  projectId: string,
  userId: string,
  limit: number,
  category?: ClaimCategory,
  types?: ClaimType[] | null,
): Promise<StoredClaimRow[]> {
  const now = Date.now();
  // The legacy profile route only returned preference claims. Once a category
  // is requested, category is the authoritative discriminator: profile-type
  // claims are valid user_profile rows too.
  const categoryCondition = category ? " AND category = ?" : " AND type = 'preference'";
  const typeCondition = types?.length ? ` AND type IN (${types.map(() => "?").join(",")})` : "";
  const bindings = category
    ? [projectId, userId, category, now, now, ...(types ?? []), limit]
    : [projectId, userId, now, now, ...(types ?? []), limit];
  const result = await db.prepare(
    `SELECT ${CLAIM_COLUMNS} FROM memory_claims WHERE project_id = ? AND scope_kind = 'user' AND scope_id = ?${categoryCondition} AND applicability = 'global' AND status = 'active' AND (valid_from IS NULL OR valid_from <= ?) AND (valid_until IS NULL OR valid_until > ?)`
      + `${typeCondition} ORDER BY updated_at DESC LIMIT ?`,
  ).bind(...bindings).all<StoredClaimRow>();
  return result.results;
}

export async function fetchWorkspaceProfileClaims(
  db: D1Database,
  projectId: string,
  userId: string,
  workspaceId: string,
  limit: number,
  category?: ClaimCategory,
  types?: ClaimType[] | null,
): Promise<StoredClaimRow[]> {
  const now = Date.now();
  const categoryCondition = category ? " AND category = ?" : "";
  const typeCondition = types?.length ? ` AND type IN (${types.map(() => "?").join(",")})` : "";
  const bindings = category
    ? [projectId, userId, workspaceId, category, now, now, ...(types ?? []), limit]
    : [projectId, userId, workspaceId, now, now, ...(types ?? []), limit];
  const result = await db.prepare(
    `SELECT ${CLAIM_COLUMNS} FROM memory_claims WHERE project_id = ? AND scope_kind = 'user' AND scope_id = ? AND applicability = 'workspace' AND workspace_id = ?${categoryCondition} AND status = 'active' AND (valid_from IS NULL OR valid_from <= ?) AND (valid_until IS NULL OR valid_until > ?)`
      + `${typeCondition} ORDER BY updated_at DESC LIMIT ?`,
  ).bind(...bindings).all<StoredClaimRow>();
  return result.results;
}

export async function fetchActiveRuleClaims(
  db: D1Database,
  projectId: string,
  options: { workspaceId: string | null; userId?: string | null; types?: ClaimType[] | null; limit: number },
): Promise<StoredClaimRow[]> {
  const now = Date.now();
  const scopeCondition = options.userId
    ? "((scope_kind = 'project' AND scope_id = ?) OR (scope_kind = 'user' AND scope_id = ?))"
    : "(scope_kind = 'project' AND scope_id = ?)";
  const scopeBindings = options.userId
    ? [projectId, options.userId]
    : [projectId];
  const applicabilityCondition = options.workspaceId
    ? "(applicability = 'global' OR (applicability = 'workspace' AND workspace_id = ?))"
    : "applicability = 'global'";
  const applicabilityBindings = options.workspaceId ? [options.workspaceId] : [];
  const typeCondition = options.types?.length ? `AND type IN (${options.types.map(() => "?").join(",")})` : "";
  const typeBindings = options.types ?? [];
  const result = await db.prepare(
    `SELECT ${CLAIM_COLUMNS} FROM memory_claims
     WHERE project_id = ? AND category = 'rule' AND status = 'active'
       AND (valid_from IS NULL OR valid_from <= ?) AND (valid_until IS NULL OR valid_until > ?)
       AND ${scopeCondition}
       AND ${applicabilityCondition}
       ${typeCondition}
     ORDER BY CASE applicability WHEN 'global' THEN 0 ELSE 1 END, updated_at DESC
     LIMIT ?`,
  ).bind(projectId, now, now, ...scopeBindings, ...applicabilityBindings, ...typeBindings, options.limit).all<StoredClaimRow>();
  return result.results;
}

export async function fetchToolInsightClaims(
  db: D1Database,
  projectId: string,
  toolName: string,
  limit: number,
  options: { workspaceId?: string | null; types?: ClaimType[] | null } = {},
): Promise<StoredClaimRow[]> {
  const now = Date.now();
  const workspaceCondition = options.workspaceId
    ? "(applicability != 'workspace' OR workspace_id = ?)"
    : "applicability != 'workspace'";
  const workspaceBindings = options.workspaceId ? [options.workspaceId] : [];
  const typeCondition = options.types?.length ? `AND type IN (${options.types.map(() => "?").join(",")})` : "";
  const typeBindings = options.types ?? [];
  const result = await db.prepare(
    `SELECT ${CLAIM_COLUMNS} FROM memory_claims
     WHERE project_id = ? AND category = 'tool_insight' AND scope_id = ? AND status = 'active'
       AND ${workspaceCondition}
       AND (valid_from IS NULL OR valid_from <= ?) AND (valid_until IS NULL OR valid_until > ?)
       ${typeCondition}
     ORDER BY updated_at DESC
     LIMIT ?`,
  ).bind(projectId, toolName, ...workspaceBindings, now, now, ...typeBindings, limit).all<StoredClaimRow>();
  return result.results;
}

/**
 * Owner claims feed the extractor's dedupe context and the reconciler. Active
 * rows are fetched separately so a long tail of superseded history can never
 * crowd them out of a single LIMIT — that silently blinded the reconciler and
 * caused duplicate claims. The non-active tail is still needed because a stale
 * supersede target is resolved through its superseded_by pointer.
 */
export async function fetchOwnerClaims(
  db: D1Database,
  projectId: string,
  ownerId: string,
  activeLimit: number,
  inactiveLimit: number,
  workspaceId: string | null,
): Promise<StoredClaimRow[]> {
  const workspaceCondition = workspaceId
    ? "(COALESCE(workspace_id, '') = '' OR workspace_id = ?)"
    : "COALESCE(workspace_id, '') = ''";
  const workspaceBindings = workspaceId ? [workspaceId] : [];
  const ownerScope = `(scope_kind = 'user' AND scope_id = ? AND category != 'tool_insight' AND ${workspaceCondition})`;
  const projectRuleScope = `(scope_kind = 'project' AND scope_id = ? AND category = 'rule' AND ${workspaceCondition})`;
  const visibleScope = `(${ownerScope} OR ${projectRuleScope})`;
  const active = await db
    .prepare(
      `SELECT ${CLAIM_COLUMNS} FROM memory_claims WHERE project_id = ? AND ${visibleScope} AND status = 'active' AND (valid_from IS NULL OR valid_from <= ?) AND (valid_until IS NULL OR valid_until > ?) AND ((category != 'task_state' AND type != 'task_state') OR (category = 'task_state' AND type = 'task_state' AND valid_until IS NOT NULL)) ORDER BY updated_at DESC LIMIT ?`,
    )
    .bind(projectId, ownerId, ...workspaceBindings, projectId, ...workspaceBindings, Date.now(), Date.now(), activeLimit)
    .all<StoredClaimRow>();
  const inactive = await db
    .prepare(
      `SELECT ${CLAIM_COLUMNS} FROM memory_claims WHERE project_id = ? AND ${visibleScope} AND status != 'active' ORDER BY updated_at DESC LIMIT ?`,
    )
    .bind(projectId, ownerId, ...workspaceBindings, projectId, ...workspaceBindings, inactiveLimit)
    .all<StoredClaimRow>();
  return [...active.results, ...inactive.results];
}

export async function fetchEvidenceByClaimIds(
  db: D1Database,
  projectId: string,
  claimIds: string[],
): Promise<Map<string, Array<{ segmentId: string; relation: string }>>> {
  const evidenceByClaimId = new Map<string, Array<{ segmentId: string; relation: string }>>();
  if (claimIds.length === 0) return evidenceByClaimId;

  for (const chunk of chunkArray(claimIds, D1_IN_QUERY_CHUNK_SIZE)) {
    const placeholders = chunk.map(() => "?").join(",");
    const result = await db
      .prepare(`SELECT claim_id, segment_id, relation FROM memory_evidence WHERE project_id = ? AND claim_id IN (${placeholders})`)
      .bind(projectId, ...chunk)
      .all();
    for (const row of result.results as Array<Record<string, unknown>>) {
      if (typeof row.claim_id !== "string" || typeof row.segment_id !== "string" || typeof row.relation !== "string") continue;
      const entries = evidenceByClaimId.get(row.claim_id) ?? [];
      entries.push({ segmentId: row.segment_id, relation: row.relation });
      evidenceByClaimId.set(row.claim_id, entries);
    }
  }
  return evidenceByClaimId;
}

export async function listClaims(
  db: D1Database,
  projectId: string,
  options: { scopeKind: ScopeKind | null; scopeId: string | null; status: ClaimStatus | null; limit: number },
): Promise<StoredClaimRow[]> {
  const where = ["project_id = ?"];
  const bindings: Array<string | number> = [projectId];
  if (options.scopeKind) {
    where.push("scope_kind = ?");
    bindings.push(options.scopeKind);
  }
  if (options.scopeId) {
    where.push("scope_id = ?");
    bindings.push(options.scopeId);
  }
  if (options.status) {
    where.push("status = ?");
    bindings.push(options.status);
  }
  const result = await db
    .prepare(
      `SELECT ${CLAIM_COLUMNS} FROM memory_claims WHERE ${where.join(" AND ")} ORDER BY updated_at DESC LIMIT ?`,
    )
    .bind(...bindings, options.limit)
    .all<StoredClaimRow>();
  return result.results;
}
