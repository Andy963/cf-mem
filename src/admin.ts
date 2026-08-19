import type { Env } from "./env";
import { jsonResponse, textResponse } from "./api/http";

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
  if (method !== "GET") return textResponse(env, "Method Not Allowed", { status: 405 });
  return textResponse(env, "Not Found", { status: 404 });
}

const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>cf-rag · Admin</title>
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
    #error { display: none; margin: 0 0 24px; padding: 14px 16px; color: #ffd9d9; border: 1px solid #814747; border-radius: 10px; background: #371e24; }
    @media (max-width: 780px) { main { width: min(100% - 24px, 1120px); padding-top: 32px; } header { margin-bottom: 28px; } .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
    @media (max-width: 440px) { header { display: block; } header button { margin-top: 20px; } .grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <main>
    <header>
      <div><div class="eyebrow">Cloudflare Worker</div><h1>cf-rag admin</h1><div class="updated" id="updated">Loading overview…</div></div>
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
  </main>
  <script>
    const formatNumber = new Intl.NumberFormat();
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
    async function loadOverview() {
      const error = document.getElementById("error");
      error.style.display = "none";
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
          cell.colSpan = 5; cell.className = "empty"; cell.textContent = "No memory data has been indexed yet.";
          row.append(cell); rows.append(row); return;
        }
        for (const project of data.projects) {
          const row = document.createElement("tr");
          for (const value of [project.project_id, formatNumber.format(project.claims_total), formatNumber.format(project.segments_total), formatBytes(project.storage_bytes), formatDate(project.newest_update_at)]) {
            const cell = document.createElement("td"); cell.textContent = value; row.append(cell);
          }
          rows.append(row);
        }
      } catch (cause) {
        error.textContent = cause instanceof Error ? cause.message : "The dashboard data could not be loaded.";
        error.style.display = "block";
      }
    }
    document.getElementById("refresh").addEventListener("click", loadOverview);
    loadOverview();
  </script>
</body>
</html>`;
