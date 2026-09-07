import type { Env } from "./env";
import type { StoredClaimRow } from "./db/d1";
import { jsonResponse, parseJson, textResponse } from "./api/http";
import { CLAIM_CATEGORIES, type ClaimCategory } from "./memory/claims";
import {
  DEFAULT_EXTRACTOR_INSTRUCTIONS,
  DEFAULT_VERIFIER_INSTRUCTIONS,
  loadPromptConfig,
  savePromptConfig,
  runExtractionTest,
} from "./memory/profile";
import { DASHBOARD_HTML } from "./admin/ui";

interface OverviewRow {
  claims_total: number;
  claims_active: number;
  segments_total: number;
  segments_pending_deletion: number;
  storage_bytes: number;
  projects_total: number;
  newest_update_at: number | null;
}

interface ProjectRow {
  project_id: string;
  claims_total: number;
  segments_total: number;
  storage_bytes: number;
  newest_update_at: number | null;
}

const CLAIM_STATUSES = ["active", "superseded", "retracted", "proposed"] as const;
const CLAIM_TYPES = ["preference", "instruction", "decision", "profile"] as const;
const CLAIM_PAGE_SIZE = 25;

interface AdminClaimRow {
  id: string;
  project_id: string;
  scope_kind: string;
  scope_id: string;
  category: string;
  type: string;
  subject: string;
  memory_key: string;
  value_json: string;
  canonical_text: string;
  status: string;
  provenance: string;
  confidence: number;
  applicability: string;
  workspace_id: string | null;
  use_count: number;
  last_used_at: number | null;
  created_at: number;
  updated_at: number;
  sources: string;
  tags: string;
}

interface ClaimEvidenceRow {
  segment_id: string;
  relation: string;
  created_at: number;
  text: string | null;
  metadata_json: string | null;
  deletion_state: string | null;
  source_app: string | null;
}

interface ClaimAuditRow {
  action: string;
  actor_email: string;
  reason: string | null;
  created_at: number;
}

interface ClaimListFilters {
  page: number;
  projectId: string | null;
  category: ClaimCategory | null;
  status: (typeof CLAIM_STATUSES)[number] | null;
  type: (typeof CLAIM_TYPES)[number] | null;
  search: string | null;
}

function configuredAdminEmail(env: Env): string | null {
  const email = env.ADMIN_ALLOWED_EMAIL?.trim().toLowerCase();
  return email || null;
}

function isAllowedAdmin(request: Request, env: Env): boolean {
  const allowedEmail = configuredAdminEmail(env);
  const accessEmail = request.headers.get("Cf-Access-Authenticated-User-Email")?.trim().toLowerCase();
  return Boolean(allowedEmail && accessEmail && accessEmail === allowedEmail);
}

function adminAccessError(request: Request, env: Env): Response | null {
  if (!configuredAdminEmail(env)) {
    return jsonResponse(env, { error: { message: "Admin dashboard is not configured" } }, { status: 503 });
  }
  if (!isAllowedAdmin(request, env)) {
    return jsonResponse(env, { error: { message: "Forbidden" } }, { status: 403 });
  }
  return null;
}

function adminActorEmail(request: Request): string {
  return request.headers.get("Cf-Access-Authenticated-User-Email")!.trim().toLowerCase();
}

function requireSameOrigin(request: Request): void {
  const origin = request.headers.get("Origin");
  if (!origin || origin !== new URL(request.url).origin) throw new Error("Cross-origin admin writes are not allowed");
}

function optionalReason(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.trim().length > 1_000) throw new Error("reason must be at most 1000 characters");
  return value.trim() || null;
}

function claimAuditSnapshot(claim: StoredClaimRow): Record<string, unknown> {
  return {
    canonical_text: claim.canonical_text,
    value_json: claim.value_json,
    status: claim.status,
    valid_until: claim.valid_until,
    updated_at: claim.updated_at,
  };
}

async function appendClaimAudit(
  env: Env,
  claim: Pick<StoredClaimRow, "id" | "project_id">,
  request: Request,
  action: "edit" | "retract" | "tag_add" | "tag_remove",
  reason: string | null,
  before: unknown,
  after: unknown,
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO memory_claim_audit_log (id, project_id, claim_id, action, actor_email, reason, before_json, after_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(
    `claim_audit_${crypto.randomUUID()}`,
    claim.project_id,
    claim.id,
    action,
    adminActorEmail(request),
    reason,
    JSON.stringify(before),
    JSON.stringify(after),
    Date.now(),
  ).run();
}

async function requireAdminClaim(env: Env, claimId: string): Promise<StoredClaimRow> {
  const claim = await env.DB.prepare(
    `SELECT id, project_id, scope_kind, scope_id, category, type, subject, memory_key, value_json, canonical_text, status, provenance, confidence, valid_from, valid_until, superseded_by, applicability, workspace_id, use_count, last_used_at, created_at, updated_at
     FROM memory_claims WHERE id = ?`,
  ).bind(claimId).first<StoredClaimRow>();
  if (!claim) throw new Error("Claim not found");
  return claim;
}

async function updateAdminClaim(env: Env, request: Request, claimId: string, body: unknown): Promise<void> {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Request body must be an object");
  const input = body as Record<string, unknown>;
  const canonicalText = input.canonical_text;
  if (typeof canonicalText !== "string" || !canonicalText.trim() || canonicalText.trim().length > 4_000) {
    throw new Error("canonical_text must be 1 to 4000 characters");
  }
  if (input.value === undefined) throw new Error("value is required");
  let valueJson: string;
  try {
    valueJson = JSON.stringify(input.value);
    if (valueJson === undefined) throw new Error();
    JSON.parse(valueJson);
  } catch {
    throw new Error("value must be JSON-serializable");
  }
  const reason = optionalReason(input.reason);
  const claim = await requireAdminClaim(env, claimId);
  const before = claimAuditSnapshot(claim);
  const now = Date.now();
  await env.DB.prepare("UPDATE memory_claims SET canonical_text = ?, value_json = ?, updated_at = ? WHERE id = ? AND project_id = ?")
    .bind(canonicalText.trim(), valueJson, now, claim.id, claim.project_id).run();
  const updated = await requireAdminClaim(env, claimId);
  await appendClaimAudit(env, updated, request, "edit", reason, before, claimAuditSnapshot(updated));
}

async function retractAdminClaim(env: Env, request: Request, claimId: string, body: unknown): Promise<void> {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Request body must be an object");
  const reason = optionalReason((body as Record<string, unknown>).reason);
  const claim = await requireAdminClaim(env, claimId);
  if (claim.status === "retracted") throw new Error("Claim is already retracted");
  const before = claimAuditSnapshot(claim);
  const now = Date.now();
  await env.DB.prepare("UPDATE memory_claims SET status = 'retracted', valid_until = COALESCE(valid_until, ?), updated_at = ? WHERE id = ? AND project_id = ?")
    .bind(now, now, claim.id, claim.project_id).run();
  const updated = await requireAdminClaim(env, claimId);
  await appendClaimAudit(env, updated, request, "retract", reason, before, claimAuditSnapshot(updated));
}

async function deleteAdminClaim(env: Env, request: Request, claimId: string, _body: unknown): Promise<void> {
  const claim = await requireAdminClaim(env, claimId);
  await env.DB.prepare("DELETE FROM memory_claim_tags WHERE project_id = ? AND claim_id = ?").bind(claim.project_id, claim.id).run();
  await env.DB.prepare("DELETE FROM memory_evidence WHERE project_id = ? AND claim_id = ?").bind(claim.project_id, claim.id).run();
  await env.DB.prepare("DELETE FROM memory_claim_audit_log WHERE project_id = ? AND claim_id = ?").bind(claim.project_id, claim.id).run();
  await env.DB.prepare("DELETE FROM memory_claims WHERE project_id = ? AND id = ?").bind(claim.project_id, claim.id).run();
}

async function mutateAdminTag(env: Env, request: Request, claimId: string, tag: string, add: boolean, body: unknown): Promise<void> {
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(tag)) throw new Error("tag must use lowercase letters, numbers, hyphens, or underscores");
  const reason = body && typeof body === "object" && !Array.isArray(body) ? optionalReason((body as Record<string, unknown>).reason) : null;
  const claim = await requireAdminClaim(env, claimId);
  const existing = await env.DB.prepare("SELECT tag FROM memory_claim_tags WHERE project_id = ? AND claim_id = ? AND tag = ?")
    .bind(claim.project_id, claim.id, tag).first<{ tag: string }>();
  if (add && !existing) {
    await env.DB.prepare("INSERT INTO memory_claim_tags (project_id, claim_id, tag, created_at) VALUES (?, ?, ?, ?)")
      .bind(claim.project_id, claim.id, tag, Date.now()).run();
    await appendClaimAudit(env, claim, request, "tag_add", reason, null, { tag });
  }
  if (!add && existing) {
    await env.DB.prepare("DELETE FROM memory_claim_tags WHERE project_id = ? AND claim_id = ? AND tag = ?")
      .bind(claim.project_id, claim.id, tag).run();
    await appendClaimAudit(env, claim, request, "tag_remove", reason, { tag }, null);
  }
}

async function getOverview(env: Env): Promise<{ summary: OverviewRow; projects: ProjectRow[] }> {
  const [summary, projects] = await Promise.all([
    env.DB.prepare(
      `WITH project_ids AS (
         SELECT project_id FROM memory_claims
         UNION
         SELECT project_id FROM memory_segments
       )
       SELECT
         (SELECT COUNT(*) FROM memory_claims) AS claims_total,
         (SELECT COUNT(*) FROM memory_claims WHERE status = 'active') AS claims_active,
         (SELECT COUNT(*) FROM memory_segments WHERE deletion_state = 'active') AS segments_total,
         (SELECT COUNT(*) FROM memory_segments WHERE deletion_state = 'pending_delete') AS segments_pending_deletion,
         (SELECT COALESCE(SUM(LENGTH(CAST(text AS BLOB)) + LENGTH(CAST(metadata_json AS BLOB))), 0) FROM memory_segments WHERE deletion_state = 'active') AS storage_bytes,
         (SELECT COUNT(*) FROM project_ids) AS projects_total,
         (SELECT MAX(updated_at) FROM (
           SELECT updated_at FROM memory_claims
           UNION ALL
           SELECT updated_at FROM memory_segments
         )) AS newest_update_at`,
    ).first<OverviewRow>(),
    env.DB.prepare(
      `WITH project_ids AS (
         SELECT project_id FROM memory_claims
         UNION
         SELECT project_id FROM memory_segments
       )
       SELECT
         project_id,
         (SELECT COUNT(*) FROM memory_claims WHERE project_id = project_ids.project_id) AS claims_total,
         (SELECT COUNT(*) FROM memory_segments WHERE project_id = project_ids.project_id AND deletion_state = 'active') AS segments_total,
         (SELECT COALESCE(SUM(LENGTH(CAST(text AS BLOB)) + LENGTH(CAST(metadata_json AS BLOB))), 0) FROM memory_segments WHERE project_id = project_ids.project_id AND deletion_state = 'active') AS storage_bytes,
         (SELECT MAX(updated_at) FROM (
           SELECT updated_at FROM memory_claims WHERE project_id = project_ids.project_id
           UNION ALL
           SELECT updated_at FROM memory_segments WHERE project_id = project_ids.project_id
         )) AS newest_update_at
       FROM project_ids
       ORDER BY newest_update_at DESC
       LIMIT 50`,
    ).all<ProjectRow>(),
  ]);

  return {
    summary: summary ?? {
      claims_total: 0,
      claims_active: 0,
      segments_total: 0,
      segments_pending_deletion: 0,
      storage_bytes: 0,
      projects_total: 0,
      newest_update_at: null,
    },
    projects: projects.results,
  };
}

function parseClaimListFilters(url: URL): ClaimListFilters {
  const parseChoice = <T extends readonly string[]>(name: string, choices: T): T[number] | null => {
    const value = url.searchParams.get(name)?.trim();
    if (!value) return null;
    if (!choices.includes(value)) throw new Error(`${name} is invalid`);
    return value as T[number];
  };
  const rawPage = url.searchParams.get("page");
  const page = rawPage === null ? 1 : Number(rawPage);
  if (!Number.isInteger(page) || page < 1 || page > 10_000) throw new Error("page must be a positive integer");

  const projectId = url.searchParams.get("project_id")?.trim() || null;
  if (projectId && projectId.length > 128) throw new Error("project_id is too long");
  const search = url.searchParams.get("q")?.trim() || null;
  if (search && search.length > 200) throw new Error("q is too long");

  return {
    page,
    projectId,
    category: parseChoice("category", CLAIM_CATEGORIES),
    status: parseChoice("status", CLAIM_STATUSES),
    type: parseChoice("type", CLAIM_TYPES),
    search,
  };
}

function claimWhere(filters: ClaimListFilters): { where: string; bindings: Array<string | number> } {
  const where = ["1 = 1"];
  const bindings: Array<string | number> = [];
  if (filters.projectId) {
    where.push("project_id = ?");
    bindings.push(filters.projectId);
  }
  if (filters.category) {
    where.push("category = ?");
    bindings.push(filters.category);
  }
  if (filters.status) {
    where.push("status = ?");
    bindings.push(filters.status);
  }
  if (filters.type) {
    where.push("type = ?");
    bindings.push(filters.type);
  }
  if (filters.search) {
    where.push("(canonical_text LIKE ? COLLATE NOCASE OR subject LIKE ? COLLATE NOCASE OR memory_key LIKE ? COLLATE NOCASE)");
    const query = `%${filters.search}%`;
    bindings.push(query, query, query);
  }
  return { where: where.join(" AND "), bindings };
}

async function listAdminClaims(env: Env, filters: ClaimListFilters): Promise<{ page: number; page_size: number; total: number; claims: AdminClaimRow[] }> {
  const { where, bindings } = claimWhere(filters);
  const [count, claims] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS total FROM memory_claims WHERE ${where}`).bind(...bindings).first<{ total: number }>(),
    env.DB.prepare(
      `SELECT id, project_id, scope_kind, scope_id, category, type, subject, memory_key, value_json, canonical_text, status, provenance, confidence, applicability, workspace_id, use_count, last_used_at, created_at, updated_at,
       COALESCE((SELECT GROUP_CONCAT(DISTINCT json_extract(s.metadata_json, '$.source_app')) FROM memory_evidence AS e JOIN memory_segments AS s ON s.id = e.segment_id AND s.project_id = e.project_id WHERE e.claim_id = memory_claims.id AND json_extract(s.metadata_json, '$.source_app') IS NOT NULL), '') AS sources,
       COALESCE((SELECT GROUP_CONCAT(tag) FROM memory_claim_tags WHERE claim_id = memory_claims.id), '') AS tags
       FROM memory_claims
       WHERE ${where}
       ORDER BY updated_at DESC
       LIMIT ? OFFSET ?`,
    ).bind(...bindings, CLAIM_PAGE_SIZE, (filters.page - 1) * CLAIM_PAGE_SIZE).all<AdminClaimRow>(),
  ]);
  return { page: filters.page, page_size: CLAIM_PAGE_SIZE, total: count?.total ?? 0, claims: claims.results };
}

async function getAdminClaimDetail(env: Env, claimId: string): Promise<{ claim: AdminClaimRow; evidence: ClaimEvidenceRow[]; tags: string[]; audit: ClaimAuditRow[] } | null> {
  const claim = await env.DB.prepare(
    `SELECT id, project_id, scope_kind, scope_id, category, type, subject, memory_key, value_json, canonical_text, status, provenance, confidence, applicability, workspace_id, use_count, last_used_at, created_at, updated_at,
     COALESCE((SELECT GROUP_CONCAT(DISTINCT json_extract(s.metadata_json, '$.source_app')) FROM memory_evidence AS e JOIN memory_segments AS s ON s.id = e.segment_id AND s.project_id = e.project_id WHERE e.claim_id = memory_claims.id AND json_extract(s.metadata_json, '$.source_app') IS NOT NULL), '') AS sources,
     COALESCE((SELECT GROUP_CONCAT(tag) FROM memory_claim_tags WHERE claim_id = memory_claims.id), '') AS tags
     FROM memory_claims WHERE id = ?`,
  ).bind(claimId).first<AdminClaimRow>();
  if (!claim) return null;

  const [evidence, tags, audit] = await Promise.all([
    env.DB.prepare(
    `SELECT e.segment_id, e.relation, e.created_at, s.text, s.metadata_json, s.deletion_state, json_extract(s.metadata_json, '$.source_app') AS source_app
     FROM memory_evidence AS e
     LEFT JOIN memory_segments AS s ON s.id = e.segment_id AND s.project_id = e.project_id
     WHERE e.claim_id = ? AND e.project_id = ?
     ORDER BY e.created_at DESC`,
    ).bind(claimId, claim.project_id).all<ClaimEvidenceRow>(),
    env.DB.prepare("SELECT tag FROM memory_claim_tags WHERE project_id = ? AND claim_id = ? ORDER BY tag ASC").bind(claim.project_id, claimId).all<{ tag: string }>(),
    env.DB.prepare("SELECT action, actor_email, reason, created_at FROM memory_claim_audit_log WHERE project_id = ? AND claim_id = ? ORDER BY created_at DESC LIMIT 50").bind(claim.project_id, claimId).all<ClaimAuditRow>(),
  ]);
  return { claim, evidence: evidence.results, tags: tags.results.map((row) => row.tag), audit: audit.results };
}

function dashboardResponse(): Response {
  return new Response(DASHBOARD_HTML, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'self'; connect-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function handleAdminRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const accessError = adminAccessError(request, env);
  if (accessError) return accessError;

  if (method === "GET" && (url.pathname === "/admin" || url.pathname === "/admin/")) {
    return dashboardResponse();
  }
  if (method === "GET" && url.pathname === "/admin/api/overview") {
    try {
      return jsonResponse(env, { ok: true, ...(await getOverview(env)) }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      console.error(`[admin] overview failed: ${error instanceof Error ? error.message : String(error)}`);
      return jsonResponse(env, { error: { message: "Unable to load dashboard data" } }, { status: 502 });
    }
  }
  if (method === "GET" && url.pathname === "/admin/api/claims") {
    try {
      return jsonResponse(env, { ok: true, ...(await listAdminClaims(env, parseClaimListFilters(url))) }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to load claims";
      const status = ["page must be a positive integer", "project_id is too long", "q is too long", "category is invalid", "status is invalid", "type is invalid"].includes(message) ? 400 : 502;
      if (status === 502) console.error(`[admin] claims failed: ${message}`);
      return jsonResponse(env, { error: { message } }, { status });
    }
  }
  const detailMatch = url.pathname.match(/^\/admin\/api\/claims\/([^/]+)(?:\/(retract|tags)(?:\/([^/]+))?)?$/);
  if (detailMatch && method !== "GET") {
    let claimId: string;
    try {
      claimId = decodeURIComponent(detailMatch[1]);
    } catch {
      return jsonResponse(env, { error: { message: "Invalid claim id" } }, { status: 400 });
    }
    if (!claimId) return jsonResponse(env, { error: { message: "Invalid claim id" } }, { status: 400 });
    try {
      requireSameOrigin(request);
      const body = await parseJson(request);
      if (method === "PUT" && !detailMatch[2]) await updateAdminClaim(env, request, claimId, body);
      else if (method === "DELETE" && !detailMatch[2]) {
        await deleteAdminClaim(env, request, claimId, body);
        return jsonResponse(env, { ok: true, deleted: true }, { headers: { "Cache-Control": "no-store" } });
      }
      else if (method === "POST" && detailMatch[2] === "retract") await retractAdminClaim(env, request, claimId, body);
      else if (method === "POST" && detailMatch[2] === "tags") {
        const tag = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>).tag : null;
        if (typeof tag !== "string") {
          throw new Error("tag is required");
        }
        await mutateAdminTag(env, request, claimId, tag, true, body);
      } else if (method === "DELETE" && detailMatch[2] === "tags" && detailMatch[3]) {
        await mutateAdminTag(env, request, claimId, decodeURIComponent(detailMatch[3]), false, body);
      } else return textResponse(env, "Method Not Allowed", { status: 405 });
      const detail = await getAdminClaimDetail(env, claimId);
      return detail ? jsonResponse(env, { ok: true, ...detail }) : jsonResponse(env, { error: { message: "Claim not found" } }, { status: 404 });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to update claim";
      const status = message === "Claim not found" ? 404 : 400;
      if (status === 400) console.warn(`[admin] claim update rejected: ${message}`);
      return jsonResponse(env, { error: { message } }, { status });
    }
  }
  if (method === "GET" && url.pathname.startsWith("/admin/api/claims/")) {
    const claimId = decodeURIComponent(url.pathname.slice("/admin/api/claims/".length));
    if (!claimId || claimId.includes("/")) {
      return jsonResponse(env, { error: { message: "Invalid claim id" } }, { status: 400 });
    }
    try {
      const detail = await getAdminClaimDetail(env, claimId);
      return detail
        ? jsonResponse(env, { ok: true, ...detail }, { headers: { "Cache-Control": "no-store" } })
        : jsonResponse(env, { error: { message: "Claim not found" } }, { status: 404 });
    } catch (error) {
      console.error(`[admin] claim detail failed: ${error instanceof Error ? error.message : String(error)}`);
      return jsonResponse(env, { error: { message: "Unable to load claim" } }, { status: 502 });
    }
  }
  if (method === "GET" && url.pathname === "/admin/api/prompts") {
    try {
      const config = await loadPromptConfig(env);
      return jsonResponse(env, {
        ok: true,
        extractor_instructions: config.extractorInstructions,
        verifier_instructions: config.verifierInstructions,
        is_custom: config.isCustom,
        default_extractor_instructions: DEFAULT_EXTRACTOR_INSTRUCTIONS,
        default_verifier_instructions: DEFAULT_VERIFIER_INSTRUCTIONS,
      }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      console.error(`[admin] prompts load failed: ${error instanceof Error ? error.message : String(error)}`);
      return jsonResponse(env, { error: { message: "Unable to load prompt configuration" } }, { status: 502 });
    }
  }
  if (method === "PUT" && url.pathname === "/admin/api/prompts") {
    try {
      requireSameOrigin(request);
      const body = await parseJson(request) as Record<string, unknown>;
      const extractor = typeof body.extractor_instructions === "string" ? body.extractor_instructions.trim() : "";
      const verifier = typeof body.verifier_instructions === "string" ? body.verifier_instructions.trim() : "";
      if (!extractor) throw new Error("extractor_instructions must not be empty");
      if (!verifier) throw new Error("verifier_instructions must not be empty");
      if (extractor.length > 20_000) throw new Error("extractor_instructions is too long (max 20000 characters)");
      if (verifier.length > 20_000) throw new Error("verifier_instructions is too long (max 20000 characters)");
      await savePromptConfig(env, extractor, verifier, adminActorEmail(request));
      return jsonResponse(env, { ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to save prompt configuration";
      return jsonResponse(env, { error: { message } }, { status: 400 });
    }
  }
  if (method === "POST" && url.pathname === "/admin/api/prompts/test") {
    try {
      requireSameOrigin(request);
      const body = await parseJson(request) as Record<string, unknown>;
      const evidenceText = typeof body.evidence_text === "string" ? body.evidence_text.trim() : "";
      if (!evidenceText) throw new Error("evidence_text must not be empty");
      if (evidenceText.length > 8_000) throw new Error("evidence_text is too long (max 8000 characters)");
      const customExtractor = typeof body.extractor_instructions === "string" ? body.extractor_instructions : undefined;
      const customVerifier = typeof body.verifier_instructions === "string" ? body.verifier_instructions : undefined;
      const result = await runExtractionTest(env, evidenceText, customExtractor, customVerifier);
      return jsonResponse(env, { ok: true, ...result }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Extraction test failed";
      console.error(`[admin] extraction test failed: ${message}`);
      return jsonResponse(env, { error: { message } }, { status: 502 });
    }
  }
  if (method !== "GET") return textResponse(env, "Method Not Allowed", { status: 405 });
  return textResponse(env, "Not Found", { status: 404 });
}
