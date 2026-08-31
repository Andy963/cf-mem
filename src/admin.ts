import type { Env } from "./env";
import type { StoredClaimRow } from "./db/d1";
import { jsonResponse, parseJson, textResponse } from "./api/http";
import { syncClaimVector } from "./memory/claim-index";
import {
  DEFAULT_EXTRACTOR_INSTRUCTIONS,
  DEFAULT_VERIFIER_INSTRUCTIONS,
  loadPromptConfig,
  savePromptConfig,
  runExtractionTest,
} from "./memory/profile";

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

async function syncAdminClaimVector(env: Env, claim: StoredClaimRow): Promise<void> {
  try {
    await syncClaimVector(env, claim);
  } catch (error) {
    // The D1 mutation and audit log are authoritative. Claim searches validate
    // status in D1 after Vectorize retrieval, so an unavailable vector binding
    // must not turn a completed admin operation into a misleading failure.
    console.error(`[admin] vector sync deferred for ${claim.id}: ${error instanceof Error ? error.message : String(error)}`);
  }
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
  await syncAdminClaimVector(env, updated);
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
  await syncAdminClaimVector(env, updated);
}

async function deleteAdminClaim(env: Env, request: Request, claimId: string, _body: unknown): Promise<void> {
  const claim = await requireAdminClaim(env, claimId);
  await env.DB.prepare("DELETE FROM memory_claim_tags WHERE project_id = ? AND claim_id = ?").bind(claim.project_id, claim.id).run();
  await env.DB.prepare("DELETE FROM memory_evidence WHERE project_id = ? AND claim_id = ?").bind(claim.project_id, claim.id).run();
  await env.DB.prepare("DELETE FROM memory_claim_audit_log WHERE project_id = ? AND claim_id = ?").bind(claim.project_id, claim.id).run();
  await env.DB.prepare("DELETE FROM memory_claims WHERE project_id = ? AND id = ?").bind(claim.project_id, claim.id).run();
  if (env.CLAIMS_INDEX?.deleteByIds) {
    try {
      await env.CLAIMS_INDEX.deleteByIds([claim.id]);
    } catch (e) {
      console.error(`[admin] failed to delete vector for claim ${claim.id}: ${e}`);
    }
  }
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
      const status = ["page must be a positive integer", "project_id is too long", "q is too long", "status is invalid", "type is invalid"].includes(message) ? 400 : 502;
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

const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>cf-mem · Admin</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #10141b; color: #edf3fa; }
    * { box-sizing: border-box; }
    body { margin: 0; min-width: 320px; background: radial-gradient(circle at top right, #193e45 0, transparent 36rem), #10141b; }
    main { width: min(1120px, calc(100% - 32px)); margin: 0 auto; padding: 56px 0 72px; }
    header { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; margin-bottom: 40px; }
    .eyebrow { color: #6ed2bc; font-size: 12px; font-weight: 750; letter-spacing: .12em; text-transform: uppercase; }
    h1 { font-size: clamp(32px, 5vw, 48px); letter-spacing: -.045em; line-height: 1; margin: 8px 0 0; }
    .updated { color: #9fb0c2; font-size: 14px; margin-top: 8px; }
    button { cursor: pointer; border: 1px solid #426271; border-radius: 8px; padding: 10px 14px; color: #e9fbf5; background: #163c3a; font: inherit; font-weight: 650; }
    button:hover { background: #1d504c; } button:focus-visible { outline: 3px solid #6ed2bc; outline-offset: 3px; }
    .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px; }
    .card, .table-card { border: 1px solid #293746; border-radius: 14px; background: rgba(21, 28, 38, .88); box-shadow: 0 16px 32px rgba(0, 0, 0, .13); }
    .card { min-height: 142px; padding: 20px; }
    .label { color: #9fb0c2; font-size: 13px; font-weight: 650; }
    .value { margin-top: 22px; font-size: 30px; font-weight: 720; letter-spacing: -.04em; }
    .hint { margin-top: 6px; color: #718397; font-size: 12px; }
    .table-card { margin-top: 32px; overflow: hidden; }
    .table-card h2 { margin: 0; padding: 20px; font-size: 16px; border-bottom: 1px solid #293746; }
    .table-wrap { overflow-x: auto; }
    table { border-collapse: collapse; width: 100%; min-width: 620px; text-align: left; }
    th, td { padding: 15px 20px; border-bottom: 1px solid #293746; font-size: 14px; }
    th { color: #9fb0c2; font-weight: 600; }
    td { color: #edf3fa; } tbody tr:last-child td { border-bottom: 0; }
    .empty { color: #9fb0c2; padding: 24px 20px; }
    .section-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 20px; border-bottom: 1px solid #293746; }
    .section-heading h2 { border: 0; padding: 0; }
    .filters { display: grid; grid-template-columns: minmax(180px, 1.4fr) repeat(3, minmax(120px, .6fr)) auto; gap: 12px; padding: 16px 20px; border-bottom: 1px solid #293746; }
    input, select { width: 100%; min-height: 40px; color: #edf3fa; border: 1px solid #426271; border-radius: 8px; background: #161f2a; padding: 8px 10px; font: inherit; }
    input:focus, select:focus { outline: 3px solid #6ed2bc; outline-offset: 2px; border-color: #6ed2bc; }
    .claim-button { width: 100%; border: 0; border-radius: 0; padding: 0; color: #edf3fa; background: transparent; font: inherit; font-weight: 600; text-align: left; }
    .claim-button:hover { color: #6ed2bc; background: transparent; }
    .claim-text { display: -webkit-box; overflow: hidden; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-height: 1.4; }
    .claim-meta { color: #718397; font-size: 12px; margin-top: 5px; }
    .badge { display: inline-block; border: 1px solid #486477; border-radius: 999px; padding: 3px 7px; color: #bdd0dd; font-size: 12px; white-space: nowrap; }
    .badge.active { color: #a8ead7; border-color: #327562; background: #123b34; }
    .badge.retracted { color: #ffb5b5; border-color: #7b4646; background: #3a2227; }
    .badge.superseded { color: #d3bdff; border-color: #604e83; background: #2b253d; }
    .tag { display: inline-block; margin: 2px 4px 2px 0; padding: 3px 7px; color: #b9cef9; border-radius: 999px; background: #243251; font-size: 12px; }
    .source { display: inline-block; margin: 5px 4px 0 0; color: #91d8ca; font-size: 12px; font-weight: 650; }
    .danger { color: #ffd4d4; border-color: #8c4c4c; background: #54282d; } .danger:hover { background: #70333a; }
    .claim-ops { white-space: nowrap; }
    .op-button { padding: 3px 8px; margin-right: 6px; font-size: 12px; font-weight: 600; border-radius: 6px; border: 1px solid #426471; background: #1a2533; color: #b9cef9; cursor: pointer; }
    .op-button:hover { background: #233448; color: #6ed2bc; }
    .op-button.danger-op { color: #ffb5b5; border-color: #7b4646; background: #3a2227; }
    .op-button.danger-op:hover { background: #54282d; color: #ffd4d4; }
    .pager { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 16px 20px; border-top: 1px solid #293746; color: #9fb0c2; font-size: 13px; }
    .pager div { display: flex; gap: 8px; }
    button:disabled { cursor: not-allowed; opacity: .45; }
    dialog { width: min(760px, calc(100% - 24px)); max-height: min(760px, calc(100% - 48px)); overflow: auto; color: #edf3fa; border: 1px solid #426271; border-radius: 14px; background: #161f2a; box-shadow: 0 24px 80px rgba(0, 0, 0, .6); }
    dialog::backdrop { background: rgba(4, 9, 14, .72); backdrop-filter: blur(3px); }
    .dialog-head { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding-bottom: 16px; border-bottom: 1px solid #293746; }
    .dialog-head h2 { margin: 0; font-size: 20px; }
    .dialog-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
    .detail-grid { display: grid; grid-template-columns: 150px 1fr; gap: 10px 16px; margin: 20px 0; font-size: 14px; }
    .detail-grid dt { color: #9fb0c2; } .detail-grid dd { margin: 0; overflow-wrap: anywhere; }
    .detail-content { white-space: pre-wrap; overflow-wrap: anywhere; padding: 14px; border: 1px solid #293746; border-radius: 9px; background: #101720; font: 13px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .evidence { margin-top: 24px; } .evidence h3 { font-size: 15px; }
    .evidence-item { margin-top: 12px; padding: 14px; border: 1px solid #293746; border-radius: 9px; background: #101720; }
    .evidence-item p { margin: 8px 0 0; white-space: pre-wrap; line-height: 1.5; }
    #error { display: none; margin: 0 0 24px; padding: 14px 16px; color: #ffd9d9; border: 1px solid #814747; border-radius: 10px; background: #371e24; }
    @media (max-width: 780px) { main { width: min(100% - 24px, 1120px); padding-top: 32px; } header { margin-bottom: 28px; } .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .filters { grid-template-columns: 1fr 1fr; } .filters input { grid-column: 1 / -1; } }
    @media (max-width: 440px) { header { display: block; } header button { margin-top: 20px; } .grid { grid-template-columns: 1fr; } }
    .prompt-body { padding: 20px; }
    .prompt-field { margin-bottom: 20px; }
    .prompt-field label { display: block; color: #9fb0c2; font-size: 13px; font-weight: 650; margin-bottom: 6px; }
    textarea { width: 100%; color: #edf3fa; border: 1px solid #426471; border-radius: 8px; background: #161f2a; padding: 10px 12px; font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; resize: vertical; }
    textarea:focus { outline: 3px solid #6ed2bc; outline-offset: 2px; border-color: #6ed2bc; }
    .prompt-actions { display: flex; gap: 10px; margin-bottom: 28px; }
    .prompt-test { border-top: 1px solid #293746; padding-top: 20px; }
    .prompt-test h3 { font-size: 15px; margin: 0 0 12px; }
    .prompt-test label { display: block; color: #9fb0c2; font-size: 13px; font-weight: 650; margin-bottom: 6px; }
    .prompt-test button { margin-top: 10px; }
    #test-results { margin-top: 20px; }
    .test-candidate { margin-bottom: 16px; padding: 14px; border: 1px solid #293746; border-radius: 9px; background: #101720; }
    .test-candidate h4 { margin: 0 0 8px; font-size: 14px; }
    .test-verdict { margin-top: 8px; font-weight: 650; }
    .test-verdict.accept { color: #a8ead7; }
    .test-verdict.reject { color: #ffb5b5; }
    .test-verdict.hold { color: #ffd9a0; }
    .test-raw { margin-top: 12px; white-space: pre-wrap; overflow-wrap: anywhere; padding: 12px; border: 1px solid #293746; border-radius: 8px; background: #0d141c; font: 12px/1.5 ui-monospace, monospace; color: #718397; max-height: 300px; overflow-y: auto; }
  </style>
</head>
<body>
  <main>
    <header>
      <div><div class="eyebrow">Cloudflare Worker</div><h1>cf-mem admin</h1><div class="updated" id="updated">Loading overview…</div></div>
      <button type="button" id="refresh">Refresh</button>
    </header>
    <p id="error" role="alert"></p>
    <section class="grid" aria-label="Memory metrics">
      <div class="card"><div class="label">Active claims</div><div class="value" id="active-claims">—</div><div class="hint" id="all-claims">— total claims</div></div>
      <div class="card"><div class="label">Raw segments</div><div class="value" id="segments">—</div><div class="hint" id="pending-deletion">— pending deletion</div></div>
      <div class="card"><div class="label">Stored content</div><div class="value" id="storage">—</div><div class="hint">Text and metadata bytes</div></div>
      <div class="card"><div class="label">Projects</div><div class="value" id="projects">—</div><div class="hint">Isolated memory scopes</div></div>
    </section>
    <section class="table-card" aria-labelledby="project-title">
      <h2 id="project-title">Project usage</h2>
      <div class="table-wrap"><table><thead><tr><th>Project</th><th>Claims</th><th>Segments</th><th>Storage</th><th>Last update</th></tr></thead><tbody id="project-rows"></tbody></table></div>
    </section>
    <section class="table-card" aria-labelledby="claims-title">
      <div class="section-heading"><h2 id="claims-title">Extracted claims</h2><span class="hint" id="claims-count">Loading…</span></div>
      <form class="filters" id="claim-filters">
        <input id="claim-query" type="search" placeholder="Search claim text, subject, or key" aria-label="Search claims">
        <select id="claim-project" aria-label="Filter by project"><option value="">All projects</option></select>
        <select id="claim-status" aria-label="Filter by status"><option value="">All statuses</option><option value="active">Active</option><option value="proposed">Proposed</option><option value="superseded">Superseded</option><option value="retracted">Retracted</option></select>
        <select id="claim-type" aria-label="Filter by type"><option value="">All types</option><option value="preference">Preference</option><option value="instruction">Instruction</option><option value="decision">Decision</option><option value="profile">Profile</option></select>
        <button type="submit">Filter</button>
      </form>
      <div class="table-wrap"><table><thead><tr><th>Claim</th><th>Type / scope</th><th>Status</th><th>Confidence</th><th>Used</th><th>Updated</th><th>Operations</th></tr></thead><tbody id="claim-rows"></tbody></table></div>
      <div class="pager"><span id="page-label">—</span><div><button type="button" id="previous-page">Previous</button><button type="button" id="next-page">Next</button></div></div>
    </section>
    <section class="table-card" id="prompt-section" aria-labelledby="prompt-title">
      <div class="section-heading"><h2 id="prompt-title">Extractor prompts</h2><span class="hint" id="prompt-status">Loading…</span></div>
      <div class="prompt-body">
        <div class="prompt-field">
          <label for="extractor-prompt">Extractor instructions</label>
          <textarea id="extractor-prompt" rows="12" spellcheck="false" placeholder="Loading…"></textarea>
        </div>
        <div class="prompt-field">
          <label for="verifier-prompt">Verifier instructions</label>
          <textarea id="verifier-prompt" rows="10" spellcheck="false" placeholder="Loading…"></textarea>
        </div>
        <div class="prompt-actions">
          <button type="button" id="save-prompts">Save prompts</button>
          <button type="button" id="reset-prompts">Reset to defaults</button>
        </div>
        <div class="prompt-test">
          <h3>Test extraction</h3>
          <label for="test-evidence">Evidence text (user speech)</label>
          <textarea id="test-evidence" rows="4" spellcheck="false" placeholder="e.g. 版本号明明是三位数字 你非要加个pre.0上去"></textarea>
          <button type="button" id="run-test">Run test</button>
          <div id="test-results"></div>
        </div>
      </div>
    </section>
  </main>
  <dialog id="claim-dialog">
    <div class="dialog-head"><h2>Claim detail</h2><div class="dialog-actions"><button type="button" id="edit-claim">Edit</button><button type="button" id="add-tag">Add tag</button><button type="button" class="danger" id="retract-claim">Retract</button><button type="button" class="danger" id="delete-claim">Delete</button><button type="button" id="close-dialog">Close</button></div></div>
    <div id="claim-detail"></div>
  </dialog>
  <script>
    const formatNumber = new Intl.NumberFormat();
    const claimState = { page: 1, total: 0, pageSize: 25, currentClaim: null };
    function formatBytes(bytes) {
      if (!bytes) return "0 B";
      const units = ["B", "KB", "MB", "GB", "TB"];
      const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
      return (bytes / Math.pow(1024, index)).toFixed(index === 0 ? 0 : 1) + " " + units[index];
    }
    function formatDate(value) {
      return value ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "No data";
    }
    function setText(id, value) { document.getElementById(id).textContent = value; }
    function createCell(value) { const cell = document.createElement("td"); cell.textContent = value; return cell; }
    function badge(value) { const element = document.createElement("span"); element.className = "badge " + value; element.textContent = value; return element; }
    function splitLabels(value) { return value ? value.split(",").filter(Boolean) : []; }
    function labels(values, className) { const fragment = document.createDocumentFragment(); for (const value of values) { const label = document.createElement("span"); label.className = className; label.textContent = value; fragment.append(label); } return fragment; }
    function showError(message) {
      const error = document.getElementById("error"); error.textContent = message; error.style.display = "block";
    }
    function filters() {
      return {
        q: document.getElementById("claim-query").value.trim(),
        project_id: document.getElementById("claim-project").value,
        status: document.getElementById("claim-status").value,
        type: document.getElementById("claim-type").value,
      };
    }
    async function loadOverview() {
      try {
        const response = await fetch("/admin/api/overview", { credentials: "same-origin", cache: "no-store" });
        if (!response.ok) throw new Error(response.status === 403 ? "Your Cloudflare Access account is not allowed to view this dashboard." : "The dashboard data could not be loaded.");
        const data = await response.json();
        const summary = data.summary;
        setText("active-claims", formatNumber.format(summary.claims_active));
        setText("all-claims", formatNumber.format(summary.claims_total) + " total claims");
        setText("segments", formatNumber.format(summary.segments_total));
        setText("pending-deletion", formatNumber.format(summary.segments_pending_deletion) + " pending deletion");
        setText("storage", formatBytes(summary.storage_bytes));
        setText("projects", formatNumber.format(summary.projects_total));
        setText("updated", "Last memory update: " + formatDate(summary.newest_update_at));
        const rows = document.getElementById("project-rows");
        rows.replaceChildren();
        if (!data.projects.length) {
          const row = document.createElement("tr"); const cell = document.createElement("td");
          cell.colSpan = 6; cell.className = "empty"; cell.textContent = "No memory data has been indexed yet.";
          row.append(cell); rows.append(row); return;
        }
        for (const project of data.projects) {
          const row = document.createElement("tr");
          for (const value of [project.project_id, formatNumber.format(project.claims_total), formatNumber.format(project.segments_total), formatBytes(project.storage_bytes), formatDate(project.newest_update_at)]) {
            const cell = document.createElement("td"); cell.textContent = value; row.append(cell);
          }
          rows.append(row);
        }
        const select = document.getElementById("claim-project");
        const selected = select.value;
        select.replaceChildren(new Option("All projects", ""));
        for (const project of data.projects) select.add(new Option(project.project_id, project.project_id));
        select.value = selected;
      } catch (cause) {
        showError(cause instanceof Error ? cause.message : "The dashboard data could not be loaded.");
      }
    }
    async function loadClaims() {
      const params = new URLSearchParams({ page: String(claimState.page) });
      for (const [key, value] of Object.entries(filters())) if (value) params.set(key, value);
      try {
        const response = await fetch("/admin/api/claims?" + params, { credentials: "same-origin", cache: "no-store" });
        if (!response.ok) throw new Error("The claims list could not be loaded.");
        const data = await response.json();
        claimState.page = data.page; claimState.total = data.total; claimState.pageSize = data.page_size;
        const rows = document.getElementById("claim-rows"); rows.replaceChildren();
        if (!data.claims.length) {
          const row = document.createElement("tr"); const cell = document.createElement("td");
          cell.colSpan = 6; cell.className = "empty"; cell.textContent = "No claims match these filters.";
          row.append(cell); rows.append(row);
        }
        for (const claim of data.claims) {
          const row = document.createElement("tr");
          const claimCell = document.createElement("td"); const button = document.createElement("button");
          button.type = "button"; button.className = "claim-button"; button.addEventListener("click", () => openClaim(claim.id));
          const text = document.createElement("div"); text.className = "claim-text"; text.textContent = claim.canonical_text;
          const meta = document.createElement("div"); meta.className = "claim-meta"; meta.textContent = claim.subject + " · " + claim.memory_key;
          button.append(text, meta, labels(splitLabels(claim.tags), "tag")); claimCell.append(button); row.append(claimCell);
          const typeCell = createCell(claim.type + " · " + claim.scope_kind); typeCell.append(document.createElement("br"), labels(splitLabels(claim.sources), "source")); row.append(typeCell);
          const statusCell = document.createElement("td"); statusCell.append(badge(claim.status)); row.append(statusCell);
          row.append(createCell((claim.confidence * 100).toFixed(0) + "%"));
          row.append(createCell(String(claim.use_count ?? 0) + (claim.last_used_at ? " · " + formatDate(claim.last_used_at) : " · never")));
          row.append(createCell(formatDate(claim.updated_at)));
          const opCell = document.createElement("td"); opCell.className = "claim-ops";
          const editBtn = document.createElement("button"); editBtn.type = "button"; editBtn.className = "op-button"; editBtn.textContent = "edit";
          editBtn.addEventListener("click", (e) => { e.stopPropagation(); quickEditClaim(claim); });
          const delBtn = document.createElement("button"); delBtn.type = "button"; delBtn.className = "op-button danger-op"; delBtn.textContent = "del";
          delBtn.addEventListener("click", (e) => { e.stopPropagation(); quickDeleteClaim(claim); });
          opCell.append(editBtn, delBtn);
          row.append(opCell);
          rows.append(row);
        }
        setText("claims-count", formatNumber.format(data.total) + " matching claims");
        const first = data.total ? (data.page - 1) * data.page_size + 1 : 0;
        const last = Math.min(data.page * data.page_size, data.total);
        setText("page-label", data.total ? first + "–" + last + " of " + formatNumber.format(data.total) : "No claims");
        document.getElementById("previous-page").disabled = data.page <= 1;
        document.getElementById("next-page").disabled = last >= data.total;
      } catch (cause) {
        showError(cause instanceof Error ? cause.message : "The claims list could not be loaded.");
      }
    }
    async function openClaim(id) {
      const dialog = document.getElementById("claim-dialog");
      const detail = document.getElementById("claim-detail");
      detail.textContent = "Loading…"; if (!dialog.open) dialog.showModal();
      try {
        const response = await fetch("/admin/api/claims/" + encodeURIComponent(id), { credentials: "same-origin", cache: "no-store" });
        if (!response.ok) throw new Error("The claim detail could not be loaded.");
        const data = await response.json(); const claim = data.claim; claimState.currentClaim = claim;
        let value = claim.value_json;
        try { value = JSON.stringify(JSON.parse(value), null, 2); } catch {}
        detail.replaceChildren();
        const metadata = document.createElement("dl"); metadata.className = "detail-grid";
        for (const [label, value] of [["Project", claim.project_id], ["Scope", claim.scope_kind + " · " + claim.scope_id], ["Type", claim.type], ["Status", claim.status], ["Confidence", (claim.confidence * 100).toFixed(0) + "%"], ["Provenance", claim.provenance], ["Applicability", claim.applicability], ["Used", String(claim.use_count ?? 0) + (claim.last_used_at ? " · " + formatDate(claim.last_used_at) : " · never")], ["Updated", formatDate(claim.updated_at)]]) {
          const term = document.createElement("dt"); term.textContent = label;
          const description = document.createElement("dd"); description.textContent = value;
          metadata.append(term, description);
        }
        const canonical = document.createElement("div"); canonical.className = "detail-content"; canonical.textContent = claim.canonical_text;
        const structured = document.createElement("div"); structured.className = "detail-content"; structured.textContent = value;
        const sourcesTitle = document.createElement("h3"); sourcesTitle.textContent = "Sources";
        const sources = document.createElement("div"); sources.append(labels(splitLabels(claim.sources), "source"));
        if (!claim.sources) sources.textContent = "No channel metadata on linked evidence.";
        const tagsTitle = document.createElement("h3"); tagsTitle.textContent = "Tags";
        const tags = document.createElement("div");
        if (!data.tags.length) tags.className = "hint", tags.textContent = "No tags. Use Add tag to organize this claim.";
        for (const tag of data.tags) {
          const button = document.createElement("button"); button.type = "button"; button.className = "tag"; button.textContent = tag + " ×";
          button.addEventListener("click", () => removeTag(tag)); tags.append(button);
        }
        const canonicalTitle = document.createElement("h3"); canonicalTitle.textContent = "Canonical text";
        const structuredTitle = document.createElement("h3"); structuredTitle.textContent = "Structured value";
        const evidence = document.createElement("section"); evidence.className = "evidence";
        const evidenceTitle = document.createElement("h3"); evidenceTitle.textContent = "Supporting evidence (" + data.evidence.length + ")"; evidence.append(evidenceTitle);
        if (!data.evidence.length) {
          const empty = document.createElement("p"); empty.className = "hint"; empty.textContent = "No evidence segments are linked to this claim."; evidence.append(empty);
        }
        for (const item of data.evidence) {
          const card = document.createElement("article"); card.className = "evidence-item";
          const heading = document.createElement("strong"); heading.textContent = item.relation + " · " + item.segment_id;
          const content = document.createElement("p"); content.textContent = item.text || (item.deletion_state === "pending_delete" ? "This evidence segment is pending deletion." : "This evidence segment is no longer available.");
          card.append(heading, content); evidence.append(card);
        }
        const audit = document.createElement("section"); audit.className = "evidence";
        const auditTitle = document.createElement("h3"); auditTitle.textContent = "Change history (" + data.audit.length + ")"; audit.append(auditTitle);
        if (!data.audit.length) {
          const empty = document.createElement("p"); empty.className = "hint"; empty.textContent = "No administrator changes have been recorded."; audit.append(empty);
        }
        for (const item of data.audit) {
          const row = document.createElement("article"); row.className = "evidence-item";
          const heading = document.createElement("strong"); heading.textContent = item.action + " · " + formatDate(item.created_at);
          const content = document.createElement("p"); content.textContent = item.reason || "No reason provided.";
          row.append(heading, content); audit.append(row);
        }
        detail.append(metadata, sourcesTitle, sources, tagsTitle, tags, canonicalTitle, canonical, structuredTitle, structured, evidence, audit);
      } catch (cause) {
        detail.textContent = cause instanceof Error ? cause.message : "The claim detail could not be loaded.";
      }
    }
    async function refresh() {
      document.getElementById("error").style.display = "none";
      await loadOverview(); await loadClaims();
    }
    async function adminMutation(path, method, payload) {
      const response = await fetch(path, { method, credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message || "Claim update failed.");
      await refresh();
      if (claimState.currentClaim) await openClaim(claimState.currentClaim.id);
    }
    async function removeTag(tag) {
      if (!claimState.currentClaim || !confirm("Remove tag “" + tag + "”?")) return;
      try {
        await adminMutation("/admin/api/claims/" + encodeURIComponent(claimState.currentClaim.id) + "/tags/" + encodeURIComponent(tag), "DELETE", { reason: prompt("Reason for removing this tag (optional):") || null });
      } catch (cause) { showError(cause instanceof Error ? cause.message : "Tag removal failed."); }
    }
    document.getElementById("edit-claim").addEventListener("click", async () => {
      const claim = claimState.currentClaim; if (!claim) return;
      const canonicalText = prompt("Claim text:", claim.canonical_text); if (canonicalText === null) return;
      const rawValue = prompt("Structured JSON value:", claim.value_json); if (rawValue === null) return;
      try {
        await adminMutation("/admin/api/claims/" + encodeURIComponent(claim.id), "PUT", { canonical_text: canonicalText, value: JSON.parse(rawValue), reason: prompt("Reason for this edit (optional):") || null });
      } catch (cause) { showError(cause instanceof Error ? cause.message : "Claim edit failed."); }
    });
    async function quickEditClaim(claim) {
      const canonicalText = prompt("Claim text:", claim.canonical_text); if (canonicalText === null || !canonicalText.trim()) return;
      const rawValue = prompt("Structured JSON value:", claim.value_json || JSON.stringify(canonicalText.trim()));
      if (rawValue === null) return;
      try {
        let val = canonicalText.trim();
        try { val = JSON.parse(rawValue); } catch { val = rawValue; }
        await adminMutation("/admin/api/claims/" + encodeURIComponent(claim.id), "PUT", { canonical_text: canonicalText.trim(), value: val, reason: "admin edit" });
      } catch (cause) { showError(cause instanceof Error ? cause.message : "Claim edit failed."); }
    }
    async function quickDeleteClaim(claim) {
      if (!confirm('Delete claim "' + claim.canonical_text + '" permanently?')) return;
      try {
        await adminMutation("/admin/api/claims/" + encodeURIComponent(claim.id), "DELETE", { reason: "admin delete" });
        if (claimState.currentClaim && claimState.currentClaim.id === claim.id) {
          document.getElementById("claim-dialog").close();
        }
      } catch (cause) { showError(cause instanceof Error ? cause.message : "Claim deletion failed."); }
    }
    document.getElementById("delete-claim").addEventListener("click", async () => {
      const claim = claimState.currentClaim; if (!claim || !confirm('Delete claim "' + claim.canonical_text + '" permanently?')) return;
      try {
        await adminMutation("/admin/api/claims/" + encodeURIComponent(claim.id), "DELETE", { reason: "admin delete" });
        document.getElementById("claim-dialog").close();
      } catch (cause) { showError(cause instanceof Error ? cause.message : "Claim deletion failed."); }
    });
    document.getElementById("retract-claim").addEventListener("click", async () => {
      const claim = claimState.currentClaim; if (!claim || !confirm("Retract this claim? It will stop being used for retrieval.")) return;
      try {
        await adminMutation("/admin/api/claims/" + encodeURIComponent(claim.id) + "/retract", "POST", { reason: prompt("Reason for retraction (optional):") || null });
        document.getElementById("claim-dialog").close();
      } catch (cause) { showError(cause instanceof Error ? cause.message : "Claim retraction failed."); }
    });
    document.getElementById("add-tag").addEventListener("click", async () => {
      const claim = claimState.currentClaim; const tag = prompt("Tag (lowercase letters, numbers, - or _):");
      if (!claim || tag === null) return;
      try {
        await adminMutation("/admin/api/claims/" + encodeURIComponent(claim.id) + "/tags", "POST", { tag, reason: prompt("Reason for adding this tag (optional):") || null });
      } catch (cause) { showError(cause instanceof Error ? cause.message : "Adding tag failed."); }
    });
    document.getElementById("claim-filters").addEventListener("submit", (event) => { event.preventDefault(); claimState.page = 1; loadClaims(); });
    document.getElementById("previous-page").addEventListener("click", () => { if (claimState.page > 1) { claimState.page--; loadClaims(); } });
    document.getElementById("next-page").addEventListener("click", () => { if (claimState.page * claimState.pageSize < claimState.total) { claimState.page++; loadClaims(); } });
    document.getElementById("close-dialog").addEventListener("click", () => document.getElementById("claim-dialog").close());
    document.getElementById("refresh").addEventListener("click", refresh);

    // ── Extractor prompt editor ──
    let promptDefaults = { extractor: "", verifier: "" };
    async function loadPrompts() {
      try {
        const res = await fetch("/admin/api/prompts", { credentials: "same-origin", cache: "no-store" });
        if (!res.ok) throw new Error("Could not load prompt configuration.");
        const data = await res.json();
        document.getElementById("extractor-prompt").value = data.extractor_instructions;
        document.getElementById("verifier-prompt").value = data.verifier_instructions;
        promptDefaults = { extractor: data.default_extractor_instructions, verifier: data.default_verifier_instructions };
        document.getElementById("prompt-status").textContent = data.is_custom ? "Custom prompts (saved)" : "Default prompts";
      } catch (cause) {
        document.getElementById("prompt-status").textContent = "Error loading prompts";
      }
    }
    document.getElementById("save-prompts").addEventListener("click", async () => {
      const extractor = document.getElementById("extractor-prompt").value.trim();
      const verifier = document.getElementById("verifier-prompt").value.trim();
      if (!extractor || !verifier) { alert("Both prompts must not be empty."); return; }
      try {
        const res = await fetch("/admin/api/prompts", {
          method: "PUT", credentials: "same-origin", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ extractor_instructions: extractor, verifier_instructions: verifier }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error?.message || "Save failed.");
        document.getElementById("prompt-status").textContent = "Custom prompts (saved)";
      } catch (cause) { alert(cause instanceof Error ? cause.message : "Save failed."); }
    });
    document.getElementById("reset-prompts").addEventListener("click", () => {
      if (!confirm("Reset both prompts to compiled defaults? Unsaved changes will be lost.")) return;
      document.getElementById("extractor-prompt").value = promptDefaults.extractor;
      document.getElementById("verifier-prompt").value = promptDefaults.verifier;
      document.getElementById("prompt-status").textContent = "Default prompts (unsaved)";
    });
    document.getElementById("run-test").addEventListener("click", async () => {
      const evidence = document.getElementById("test-evidence").value.trim();
      if (!evidence) { alert("Enter some evidence text to test."); return; }
      const results = document.getElementById("test-results");
      results.textContent = "Running extraction test…";
      const btn = document.getElementById("run-test"); btn.disabled = true;
      try {
        const res = await fetch("/admin/api/prompts/test", {
          method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            evidence_text: evidence,
            extractor_instructions: document.getElementById("extractor-prompt").value,
            verifier_instructions: document.getElementById("verifier-prompt").value,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error?.message || "Test failed.");
        results.replaceChildren();
        if (!data.candidates.length) {
          const p = document.createElement("p"); p.className = "hint"; p.textContent = "No candidates extracted.";
          results.append(p);
        }
        for (const [i, c] of data.candidates.entries()) {
          const card = document.createElement("div"); card.className = "test-candidate";
          const title = document.createElement("h4");
          title.textContent = "Candidate " + i + ": " + (c.candidate_kind || c.type || "?") + " · explicit=" + c.explicit;
          const text = document.createElement("div"); text.className = "detail-content";
          text.textContent = c.canonical_text || "(no canonical_text)";
          const v = data.verdicts.find(v => v.candidate_index === i);
          if (v) {
            const verdict = document.createElement("div");
            verdict.className = "test-verdict " + v.verdict;
            verdict.textContent = v.verdict.toUpperCase() + " — " + v.reason;
            card.append(title, text, verdict);
          } else {
            card.append(title, text);
          }
          results.append(card);
        }
        if (data.rawExtractor) {
          const details = document.createElement("details"); const summary = document.createElement("summary");
          summary.textContent = "Raw extractor output"; details.append(summary);
          const raw = document.createElement("div"); raw.className = "test-raw"; raw.textContent = data.rawExtractor;
          details.append(raw); results.append(details);
        }
        if (data.rawVerifier) {
          const details = document.createElement("details"); const summary = document.createElement("summary");
          summary.textContent = "Raw verifier output"; details.append(summary);
          const raw = document.createElement("div"); raw.className = "test-raw"; raw.textContent = data.rawVerifier;
          details.append(raw); results.append(details);
        }
      } catch (cause) {
        results.textContent = cause instanceof Error ? cause.message : "Test failed.";
      } finally {
        btn.disabled = false;
      }
    });
    loadPrompts();
    refresh();
  </script>
</body>
</html>`;
