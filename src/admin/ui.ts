export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>cf-mem · Admin</title>
  <style>
    :root {
      color-scheme: dark;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #0d1219;
      color: #edf3fa;
      --surface: #151c26;
      --surface-strong: #1a2532;
      --surface-soft: #111923;
      --border: #293746;
      --border-strong: #426271;
      --muted: #9fb0c2;
      --subtle: #718397;
      --accent: #6ed2bc;
      --accent-strong: #163c3a;
      --danger: #ffb5b5;
      --danger-strong: #54282d;
    }
    * { box-sizing: border-box; }
    [hidden] { display: none !important; }
    body { margin: 0; min-width: 320px; background: radial-gradient(circle at top right, #193e45 0, transparent 38rem), #0d1219; }
    button, input, select, textarea { font: inherit; }
    button { cursor: pointer; border: 1px solid var(--border-strong); border-radius: 9px; padding: 10px 14px; color: #e9fbf5; background: var(--accent-strong); font-weight: 680; }
    button:hover { background: #1d504c; }
    button:focus-visible, input:focus, select:focus, textarea:focus { outline: 3px solid var(--accent); outline-offset: 2px; }
    button:disabled { cursor: not-allowed; opacity: .45; }
    .app-shell { width: min(1280px, calc(100% - 32px)); margin: 0 auto; padding: 34px 0 72px; }
    .app-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; margin-bottom: 24px; }
    .eyebrow { color: var(--accent); font-size: 12px; font-weight: 760; letter-spacing: .12em; text-transform: uppercase; }
    h1 { margin: 7px 0 0; font-size: clamp(30px, 5vw, 46px); letter-spacing: -.045em; line-height: 1; }
    .updated { margin-top: 9px; color: var(--muted); font-size: 14px; }
    .view-nav { display: flex; gap: 8px; margin-bottom: 24px; padding: 6px; overflow-x: auto; border: 1px solid var(--border); border-radius: 12px; background: rgba(21, 28, 38, .84); }
    .view-tab { flex: 0 0 auto; border-color: transparent; color: var(--muted); background: transparent; }
    .view-tab[aria-selected="true"] { border-color: #327562; color: #dffaf3; background: #123b34; }
    .error-banner { margin: 0 0 18px; padding: 12px 14px; border: 1px solid #7b4646; border-radius: 10px; color: #ffe0e0; background: #3a2227; }
    .view-heading { display: flex; align-items: flex-end; justify-content: space-between; gap: 20px; margin-bottom: 18px; }
    .view-heading h2 { margin: 0; font-size: 22px; }
    .view-heading p { margin: 6px 0 0; color: var(--muted); font-size: 14px; }
    .metric-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; }
    .metric-card, .panel { border: 1px solid var(--border); border-radius: 14px; background: rgba(21, 28, 38, .9); box-shadow: 0 16px 32px rgba(0, 0, 0, .13); }
    .metric-card { min-height: 132px; padding: 18px; }
    .metric-label { color: var(--muted); font-size: 13px; font-weight: 680; }
    .metric-value { margin-top: 20px; font-size: 30px; font-weight: 740; letter-spacing: -.04em; }
    .hint { margin-top: 6px; color: var(--subtle); font-size: 12px; }
    .panel { margin-top: 20px; overflow: hidden; }
    .panel-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 18px 20px; border-bottom: 1px solid var(--border); }
    .panel-heading h2, .panel-heading h3 { margin: 0; font-size: 16px; }
    .table-wrap { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; text-align: left; }
    th, td { padding: 14px 16px; border-bottom: 1px solid var(--border); font-size: 14px; vertical-align: top; }
    th { color: var(--muted); font-size: 12px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
    tbody tr:last-child td { border-bottom: 0; }
    tbody tr:hover { background: rgba(110, 210, 188, .035); }
    .claims-table { min-width: 1080px; }
    .project-table { min-width: 720px; }
    .empty-state { padding: 30px 20px; color: var(--muted); text-align: center; }
    .filters { display: grid; grid-template-columns: minmax(220px, 1.5fr) repeat(4, minmax(140px, .7fr)) auto; gap: 12px; padding: 16px 20px; border-bottom: 1px solid var(--border); }
    input, select, textarea { width: 100%; min-height: 40px; padding: 8px 10px; color: #edf3fa; border: 1px solid var(--border-strong); border-radius: 8px; background: #161f2a; }
    textarea { min-height: 112px; resize: vertical; line-height: 1.5; }
    .active-filters { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; min-height: 48px; padding: 10px 20px; border-bottom: 1px solid var(--border); color: var(--muted); font-size: 13px; }
    .filter-chip { padding: 4px 8px; border: 1px solid #486477; border-radius: 999px; color: #c8d8e4; background: #1a2533; }
    .claim-button { width: 100%; padding: 0; border: 0; border-radius: 0; color: #edf3fa; background: transparent; text-align: left; }
    .claim-button:hover { color: var(--accent); background: transparent; }
    .claim-text { display: -webkit-box; overflow: hidden; -webkit-box-orient: vertical; -webkit-line-clamp: 3; line-height: 1.45; }
    .claim-meta { margin-top: 7px; color: var(--subtle); font-size: 12px; overflow-wrap: anywhere; }
    .badge, .tag, .source, .filter-chip { display: inline-flex; align-items: center; width: fit-content; border-radius: 999px; white-space: nowrap; }
    .badge { border: 1px solid #486477; padding: 3px 8px; color: #bdd0dd; font-size: 12px; }
    .badge.active { color: #a8ead7; border-color: #327562; background: #123b34; }
    .badge.retracted { color: var(--danger); border-color: #7b4646; background: #3a2227; }
    .badge.superseded { color: #d3bdff; border-color: #604e83; background: #2b253d; }
    .badge.proposed { color: #ffd9a0; border-color: #765b35; background: #382d20; }
    .label-stack { display: flex; flex-wrap: wrap; gap: 5px; }
    .tag { margin: 0; padding: 3px 8px; color: #b9cef9; background: #243251; font-size: 12px; }
    button.tag { cursor: pointer; }
    .source { padding: 3px 8px; color: #91d8ca; background: #153a37; font-size: 12px; font-weight: 680; }
    .muted-value { color: var(--subtle); }
    .table-actions, .dialog-actions, .card-actions { display: flex; align-items: center; gap: 8px; }
    .table-actions { flex-wrap: wrap; }
    .action-divider { width: 1px; height: 22px; margin: 0 2px; background: var(--border-strong); }
    .op-button { padding: 6px 9px; border-color: var(--border-strong); color: #c5d7e4; background: var(--surface-strong); font-size: 12px; }
    .op-button:hover { color: var(--accent); background: #233448; }
    .op-button.danger, .danger { color: #ffd4d4; border-color: #8c4c4c; background: var(--danger-strong); }
    .op-button.danger:hover, .danger:hover { background: #70333a; }
    .link-action { padding: 4px 7px; border-color: transparent; color: var(--accent); background: transparent; font-size: 12px; }
    .link-action:hover { color: #bff6e9; background: #153a37; }
    .pager { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 14px 20px; border-top: 1px solid var(--border); color: var(--muted); font-size: 13px; }
    .pager-controls { display: flex; gap: 8px; }
    .claim-cards { display: none; padding: 12px; }
    .claim-card { padding: 15px; border: 1px solid var(--border); border-radius: 12px; background: var(--surface-soft); }
    .claim-card + .claim-card { margin-top: 10px; }
    .claim-card .claim-button { font-size: 15px; }
    .claim-card-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin-top: 14px; }
    .claim-card-section { min-width: 0; }
    .claim-card-label { display: block; margin-bottom: 6px; color: var(--subtle); font-size: 11px; font-weight: 720; letter-spacing: .05em; text-transform: uppercase; }
    .claim-card-footer { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-top: 15px; padding-top: 12px; border-top: 1px solid var(--border); }
    .prompt-layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(280px, .7fr); gap: 18px; padding: 20px; }
    .prompt-editor { display: grid; gap: 16px; align-content: start; }
    .prompt-field { display: grid; gap: 7px; }
    .prompt-field label, .prompt-test label { color: var(--muted); font-size: 13px; font-weight: 680; }
    .prompt-actions { display: flex; flex-wrap: wrap; gap: 8px; }
    .prompt-test { padding: 18px; border: 1px solid var(--border); border-radius: 12px; background: var(--surface-soft); }
    .prompt-test h3 { margin: 0 0 14px; }
    .prompt-test > textarea { margin-bottom: 10px; }
    #test-results { margin-top: 18px; }
    .test-candidate { margin-bottom: 12px; padding: 13px; border: 1px solid var(--border); border-radius: 9px; background: #101720; }
    .test-candidate h4 { margin: 0 0 8px; font-size: 14px; }
    .test-verdict { margin-top: 8px; font-weight: 680; }
    .test-verdict.accept { color: #a8ead7; }
    .test-verdict.reject { color: var(--danger); }
    .test-verdict.hold { color: #ffd9a0; }
    .test-raw { margin-top: 12px; max-height: 300px; overflow: auto; padding: 12px; border: 1px solid var(--border); border-radius: 8px; color: var(--subtle); background: #0d141c; font: 12px/1.5 ui-monospace, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
    dialog { width: min(920px, calc(100% - 32px)); max-height: calc(100dvh - 32px); padding: 0; overflow: hidden; color: #edf3fa; border: 1px solid var(--border-strong); border-radius: 16px; background: var(--surface); box-shadow: 0 30px 80px rgba(0, 0, 0, .5); }
    dialog::backdrop { background: rgba(4, 8, 12, .76); backdrop-filter: blur(3px); }
    .dialog-head { position: sticky; top: 0; z-index: 2; display: flex; justify-content: space-between; align-items: center; gap: 18px; padding: 16px 18px; border-bottom: 1px solid var(--border); background: rgba(21, 28, 38, .97); }
    .dialog-head h2 { margin: 0; font-size: 19px; }
    .dialog-actions { flex-wrap: wrap; justify-content: flex-end; }
    .destructive-actions { display: flex; align-items: center; gap: 8px; padding-left: 10px; border-left: 1px solid #7b4646; }
    #claim-detail { max-height: calc(100dvh - 86px); overflow-y: auto; padding: 18px; }
    .detail-section + .detail-section { margin-top: 16px; }
    .detail-section { padding: 16px; border: 1px solid var(--border); border-radius: 12px; background: var(--surface-soft); }
    .detail-section h3 { margin: 0 0 12px; font-size: 14px; letter-spacing: .04em; text-transform: uppercase; }
    .detail-content { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 15px; line-height: 1.6; }
    .detail-grid { display: grid; grid-template-columns: minmax(120px, .45fr) minmax(0, 1fr); gap: 8px 14px; margin: 0; }
    .detail-grid dt { color: var(--subtle); font-size: 12px; font-weight: 700; }
    .detail-grid dd { margin: 0; overflow-wrap: anywhere; }
    .evidence-list { display: grid; gap: 10px; }
    .evidence-item { padding: 12px; border: 1px solid var(--border); border-radius: 9px; background: #101720; }
    .evidence-item p { margin: 7px 0 0; color: #c8d5df; line-height: 1.5; }
    @media (max-width: 900px) {
      .metric-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .filters { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .filters input { grid-column: 1 / -1; }
      .prompt-layout { grid-template-columns: 1fr; }
    }
    @media (max-width: 720px) {
      .app-shell { width: min(100% - 20px, 1280px); padding-top: 20px; }
      .app-header { align-items: center; }
      .view-heading { align-items: flex-start; flex-direction: column; }
      .metric-grid { gap: 10px; }
      .metric-card { min-height: 112px; padding: 14px; }
      .metric-value { margin-top: 16px; font-size: 25px; }
      .filters { grid-template-columns: 1fr; padding: 14px; }
      .filters input { grid-column: auto; }
      .filters button { width: 100%; }
      .active-filters { padding: 10px 14px; }
      .claims-table-wrap { display: none; }
      .claim-cards { display: block; }
      .claim-card-grid { grid-template-columns: 1fr; }
      .claim-card-footer { align-items: flex-start; flex-direction: column; }
      .pager { align-items: flex-start; flex-direction: column; padding: 14px; }
      dialog { width: 100%; max-width: none; height: 100dvh; max-height: none; margin: 0; border: 0; border-radius: 0; }
      .dialog-head { align-items: flex-start; flex-direction: column; }
      .dialog-actions { width: 100%; justify-content: flex-start; }
      .destructive-actions { padding-left: 0; border-left: 0; }
      #claim-detail { max-height: none; padding: 12px; }
    }
  </style>
</head>
<body>
  <div class="app-shell">
    <header class="app-header">
      <div>
        <div class="eyebrow">Cloudflare Worker</div>
        <h1>cf-mem admin</h1>
        <div class="updated" id="updated">Loading overview…</div>
      </div>
      <button type="button" id="refresh">Refresh data</button>
    </header>
    <nav class="view-nav" role="tablist" aria-label="Admin sections">
      <button class="view-tab" id="tab-overview" type="button" role="tab" aria-selected="true" aria-controls="overview-view" data-view="overview">Overview</button>
      <button class="view-tab" id="tab-claims" type="button" role="tab" aria-selected="false" aria-controls="claims-view" data-view="claims" tabindex="-1">Claims</button>
      <button class="view-tab" id="tab-prompts" type="button" role="tab" aria-selected="false" aria-controls="prompts-view" data-view="prompts" tabindex="-1">Extraction prompts</button>
    </nav>
    <p class="error-banner" id="error" role="alert" hidden></p>

    <section id="overview-view" role="tabpanel" aria-labelledby="tab-overview">
      <div class="view-heading"><div><h2>Memory overview</h2><p>Storage health and project-level activity.</p></div></div>
      <div class="metric-grid" aria-label="Memory metrics">
        <div class="metric-card"><div class="metric-label">Active claims</div><div class="metric-value" id="active-claims">—</div><div class="hint" id="all-claims">— total claims</div></div>
        <div class="metric-card"><div class="metric-label">Raw segments</div><div class="metric-value" id="segments">—</div><div class="hint" id="pending-deletion">— pending deletion</div></div>
        <div class="metric-card"><div class="metric-label">Stored content</div><div class="metric-value" id="storage">—</div><div class="hint">Text and metadata bytes</div></div>
        <div class="metric-card"><div class="metric-label">Projects</div><div class="metric-value" id="projects">—</div><div class="hint">Isolated memory scopes</div></div>
      </div>
      <section class="panel" aria-labelledby="project-title">
        <div class="panel-heading"><h2 id="project-title">Project usage</h2><span class="hint">Select a project to inspect its claims.</span></div>
        <div class="table-wrap"><table class="project-table"><thead><tr><th>Project</th><th>Claims</th><th>Segments</th><th>Storage</th><th>Last update</th><th>Action</th></tr></thead><tbody id="project-rows"></tbody></table></div>
      </section>
    </section>

    <section id="claims-view" role="tabpanel" aria-labelledby="tab-claims" hidden>
      <div class="view-heading"><div><h2>Claims</h2><p>Search, classify, compare evidence, and review claim activity.</p></div><span class="hint" id="claims-count">Loading…</span></div>
      <section class="panel" aria-labelledby="claims-title">
        <div class="panel-heading"><h2 id="claims-title">Claim browser</h2><span class="hint" id="claims-scope">All projects</span></div>
        <form class="filters" id="claim-filters">
          <input id="claim-query" type="search" placeholder="Search claim text, subject, or key" aria-label="Search claims">
          <select id="claim-project" aria-label="Filter by project"><option value="">All projects</option></select>
          <select id="claim-category" aria-label="Filter by category"><option value="">All categories</option><option value="rule">Rule</option><option value="tool_insight">Tool insight</option><option value="user_profile">User profile</option><option value="domain_fact">Domain fact</option></select>
          <select id="claim-status" aria-label="Filter by status"><option value="">All statuses</option><option value="active">Active</option><option value="proposed">Proposed</option><option value="superseded">Superseded</option><option value="retracted">Retracted</option></select>
          <select id="claim-type" aria-label="Filter by type"><option value="">All types</option><option value="preference">Preference</option><option value="instruction">Instruction</option><option value="decision">Decision</option><option value="profile">Profile</option></select>
          <button type="submit">Apply filters</button>
        </form>
        <div class="active-filters" id="active-filters" aria-live="polite"></div>
        <div class="table-wrap claims-table-wrap"><table class="claims-table"><thead><tr><th>Claim</th><th>Classification</th><th>Evidence</th><th>Status</th><th>Usage</th><th>Updated</th><th>Actions</th></tr></thead><tbody id="claim-rows"></tbody></table></div>
        <div class="claim-cards" id="claim-cards" aria-label="Claim results"></div>
        <div class="pager"><span id="page-label">—</span><div class="pager-controls"><button type="button" id="previous-page">Previous</button><button type="button" id="next-page">Next</button></div></div>
      </section>
    </section>

    <section id="prompts-view" role="tabpanel" aria-labelledby="tab-prompts" hidden>
      <div class="view-heading"><div><h2>Extraction prompts</h2><p>Manage extraction policy and test candidate output separately from claim browsing.</p></div><span class="hint" id="prompt-status">Loading…</span></div>
      <section class="panel prompt-layout" aria-labelledby="prompt-title">
        <div class="prompt-editor">
          <div class="prompt-field"><label for="extractor-prompt">Extractor instructions</label><textarea id="extractor-prompt" rows="18" spellcheck="false" placeholder="Loading…"></textarea></div>
          <div class="prompt-field"><label for="verifier-prompt">Verifier instructions</label><textarea id="verifier-prompt" rows="14" spellcheck="false" placeholder="Loading…"></textarea></div>
          <div class="prompt-actions"><button type="button" id="save-prompts">Save prompts</button><button type="button" id="reset-prompts">Reset to defaults</button></div>
        </div>
        <div class="prompt-test">
          <h3 id="prompt-title">Test extraction</h3>
          <label for="test-evidence">Evidence text</label>
          <textarea id="test-evidence" rows="7" spellcheck="false" placeholder="Paste representative user or tool evidence"></textarea>
          <button type="button" id="run-test">Run test</button>
          <div id="test-results" aria-live="polite"></div>
        </div>
      </section>
    </section>
  </div>

  <dialog id="claim-dialog" aria-labelledby="claim-dialog-title">
    <div class="dialog-head">
      <h2 id="claim-dialog-title">Claim detail</h2>
      <div class="dialog-actions">
        <button type="button" id="edit-claim">Edit</button>
        <button type="button" id="add-tag">Add tag</button>
        <span class="destructive-actions"><button type="button" class="danger" id="retract-claim">Retract</button><button type="button" class="danger" id="delete-claim">Delete</button></span>
        <button type="button" id="close-dialog">Close</button>
      </div>
    </div>
    <div id="claim-detail" aria-live="polite"></div>
  </dialog>

  <script>
    const formatNumber = new Intl.NumberFormat();
    const claimState = { page: 1, total: 0, pageSize: 25, currentClaim: null, claims: new Map() };
    const enumLabels = {
      rule: "Rule",
      tool_insight: "Tool insight",
      user_profile: "User profile",
      domain_fact: "Domain fact",
      preference: "Preference",
      instruction: "Instruction",
      decision: "Decision",
      profile: "Profile",
      project: "Project",
      user: "User",
      session: "Session",
      active: "Active",
      proposed: "Proposed",
      superseded: "Superseded",
      retracted: "Retracted",
      user_confirmed: "User confirmed",
      derived: "Derived",
      semantic: "Semantic",
      exact: "Exact",
      edit: "Edit",
      retract: "Retract",
      tag_add: "Tag added",
      tag_remove: "Tag removed",
      delete: "Delete",
      supports: "Supports",
      contradicts: "Contradicts",
      pending_delete: "Pending deletion",
      deleted: "Deleted",
      accept: "Accept",
      reject: "Reject",
      hold: "Hold"
    };
    function label(value) {
      if (!value) return "None";
      if (enumLabels[value]) return enumLabels[value];
      return String(value).replace(/_/g, " ").replace(/\\b\\w/g, (character) => character.toUpperCase());
    }
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
    function createCell(value, className) { const cell = document.createElement("td"); if (className) cell.className = className; cell.textContent = value; return cell; }
    function createBadge(value) { const element = document.createElement("span"); element.className = "badge " + value; element.textContent = label(value); return element; }
    function splitLabels(value) { return value ? value.split(",").filter(Boolean) : []; }
    function labels(values, className, transform) {
      const fragment = document.createDocumentFragment();
      for (const value of values) {
        const element = document.createElement("span");
        element.className = className;
        element.textContent = transform ? transform(value) : value;
        fragment.append(element);
      }
      return fragment;
    }
    function showError(message) {
      const error = document.getElementById("error");
      error.textContent = message;
      error.hidden = false;
    }
    function clearError() {
      const error = document.getElementById("error");
      error.textContent = "";
      error.hidden = true;
    }
    function setView(view, focusTab) {
      for (const tab of document.querySelectorAll("[role=tab]")) {
        const selected = tab.dataset.view === view;
        tab.setAttribute("aria-selected", String(selected));
        tab.tabIndex = selected ? 0 : -1;
      }
      for (const panel of document.querySelectorAll("[role=tabpanel]")) panel.hidden = panel.id !== view + "-view";
      if (focusTab) document.querySelector('[role=tab][data-view="' + view + '"]').focus();
    }
    function filters() {
      return {
        q: document.getElementById("claim-query").value.trim(),
        project_id: document.getElementById("claim-project").value,
        category: document.getElementById("claim-category").value,
        status: document.getElementById("claim-status").value,
        type: document.getElementById("claim-type").value
      };
    }
    function renderActiveFilters() {
      const container = document.getElementById("active-filters");
      const active = Object.entries(filters()).filter(([, value]) => value);
      const title = document.createElement("span");
      title.textContent = active.length ? "Active filters:" : "Showing all claims";
      container.replaceChildren(title);
      for (const [key, value] of active) {
        const chip = document.createElement("span");
        chip.className = "filter-chip";
        const names = { q: "Search", project_id: "Project", category: "Category", status: "Status", type: "Type" };
        chip.textContent = names[key] + ": " + (key === "q" || key === "project_id" ? value : label(value));
        container.append(chip);
      }
      setText("claims-scope", filters().project_id || "All projects");
    }
    async function loadOverview() {
      const panel = document.getElementById("overview-view");
      panel.setAttribute("aria-busy", "true");
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
          const row = document.createElement("tr");
          const cell = document.createElement("td");
          cell.colSpan = 6;
          cell.className = "empty-state";
          cell.textContent = "No memory data has been indexed yet.";
          row.append(cell);
          rows.append(row);
        }
        for (const project of data.projects) {
          const row = document.createElement("tr");
          row.append(createCell(project.project_id));
          row.append(createCell(formatNumber.format(project.claims_total)));
          row.append(createCell(formatNumber.format(project.segments_total)));
          row.append(createCell(formatBytes(project.storage_bytes)));
          row.append(createCell(formatDate(project.newest_update_at)));
          const actionCell = document.createElement("td");
          const action = document.createElement("button");
          action.type = "button";
          action.className = "link-action view-project-claims";
          action.dataset.projectId = project.project_id;
          action.textContent = "View claims";
          action.setAttribute("aria-label", "View claims for project " + project.project_id);
          actionCell.append(action);
          row.append(actionCell);
          rows.append(row);
        }
        const select = document.getElementById("claim-project");
        const selected = select.value;
        select.replaceChildren(new Option("All projects", ""));
        for (const project of data.projects) select.add(new Option(project.project_id, project.project_id));
        select.value = selected;
      } catch (cause) {
        showError(cause instanceof Error ? cause.message : "The dashboard data could not be loaded.");
      } finally {
        panel.removeAttribute("aria-busy");
      }
    }
    function appendClassification(cell, claim) {
      const stack = document.createElement("div");
      stack.className = "label-stack";
      for (const value of [claim.category, claim.type, claim.scope_kind]) stack.append(createBadge(value));
      const confidence = document.createElement("div");
      confidence.className = "hint";
      confidence.textContent = "Confidence " + (claim.confidence * 100).toFixed(0) + "%";
      cell.append(stack, confidence);
    }
    function appendEvidence(cell, claim) {
      const sources = splitLabels(claim.sources);
      if (!sources.length) {
        const empty = document.createElement("span");
        empty.className = "muted-value";
        empty.textContent = "No source metadata";
        cell.append(empty);
        return;
      }
      cell.append(labels(sources, "source", label));
    }
    function claimTextBlock(claim) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "claim-button open-claim";
      button.dataset.claimId = claim.id;
      button.setAttribute("aria-label", "Open claim " + claim.subject);
      const text = document.createElement("div");
      text.className = "claim-text";
      text.textContent = claim.canonical_text;
      const meta = document.createElement("div");
      meta.className = "claim-meta";
      meta.textContent = claim.subject + " · " + claim.memory_key;
      button.append(text, meta);
      if (splitLabels(claim.tags).length) button.append(labels(splitLabels(claim.tags), "tag", label));
      return button;
    }
    function actionButtons(claim) {
      const container = document.createElement("div");
      container.className = "table-actions";
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "op-button edit-claim";
      edit.dataset.claimId = claim.id;
      edit.textContent = "Edit";
      const divider = document.createElement("span");
      divider.className = "action-divider";
      divider.setAttribute("aria-hidden", "true");
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "op-button danger delete-claim";
      remove.dataset.claimId = claim.id;
      remove.textContent = "Delete";
      container.append(edit, divider, remove);
      return container;
    }
    function claimCardSection(labelText, content) {
      const section = document.createElement("div");
      section.className = "claim-card-section";
      const heading = document.createElement("span");
      heading.className = "claim-card-label";
      heading.textContent = labelText;
      section.append(heading, content);
      return section;
    }
    function renderMobileCard(claim, cards) {
      const card = document.createElement("article");
      card.className = "claim-card";
      card.append(claimTextBlock(claim));
      const grid = document.createElement("div");
      grid.className = "claim-card-grid";
      const classification = document.createElement("div");
      appendClassification(classification, claim);
      const evidence = document.createElement("div");
      appendEvidence(evidence, claim);
      const status = document.createElement("div");
      status.append(createBadge(claim.status));
      const usage = document.createElement("div");
      usage.textContent = String(claim.use_count ?? 0) + (claim.last_used_at ? " · " + formatDate(claim.last_used_at) : " · never");
      const updated = document.createElement("div");
      updated.textContent = formatDate(claim.updated_at);
      grid.append(
        claimCardSection("Classification", classification),
        claimCardSection("Evidence", evidence),
        claimCardSection("Status", status),
        claimCardSection("Usage", usage),
        claimCardSection("Updated", updated)
      );
      const footer = document.createElement("div");
      footer.className = "claim-card-footer";
      const actions = actionButtons(claim);
      actions.className = "card-actions";
      footer.append(actions);
      card.append(grid, footer);
      cards.append(card);
    }
    async function loadClaims() {
      renderActiveFilters();
      const params = new URLSearchParams({ page: String(claimState.page) });
      for (const [key, value] of Object.entries(filters())) if (value) params.set(key, value);
      const view = document.getElementById("claims-view");
      view.setAttribute("aria-busy", "true");
      try {
        const response = await fetch("/admin/api/claims?" + params, { credentials: "same-origin", cache: "no-store" });
        if (!response.ok) throw new Error("The claims list could not be loaded.");
        const data = await response.json();
        claimState.page = data.page;
        claimState.total = data.total;
        claimState.pageSize = data.page_size;
        claimState.claims = new Map(data.claims.map((claim) => [claim.id, claim]));
        const rows = document.getElementById("claim-rows");
        const cards = document.getElementById("claim-cards");
        rows.replaceChildren();
        cards.replaceChildren();
        if (!data.claims.length) {
          const row = document.createElement("tr");
          const cell = document.createElement("td");
          cell.colSpan = 7;
          cell.className = "empty-state";
          cell.textContent = "No claims match these filters.";
          row.append(cell);
          rows.append(row);
          const empty = document.createElement("p");
          empty.className = "empty-state";
          empty.textContent = "No claims match these filters.";
          cards.append(empty);
        }
        for (const claim of data.claims) {
          const row = document.createElement("tr");
          const claimCell = document.createElement("td");
          claimCell.append(claimTextBlock(claim));
          const classification = document.createElement("td");
          appendClassification(classification, claim);
          const evidence = document.createElement("td");
          appendEvidence(evidence, claim);
          const status = document.createElement("td");
          status.append(createBadge(claim.status));
          const usage = createCell(String(claim.use_count ?? 0) + (claim.last_used_at ? " · " + formatDate(claim.last_used_at) : " · never"));
          const updated = createCell(formatDate(claim.updated_at));
          const actions = document.createElement("td");
          actions.append(actionButtons(claim));
          row.append(claimCell, classification, evidence, status, usage, updated, actions);
          rows.append(row);
          renderMobileCard(claim, cards);
        }
        setText("claims-count", formatNumber.format(data.total) + " matching claims");
        const first = data.total ? (data.page - 1) * data.page_size + 1 : 0;
        const last = Math.min(data.page * data.page_size, data.total);
        setText("page-label", data.total ? first + "–" + last + " of " + formatNumber.format(data.total) : "No claims");
        document.getElementById("previous-page").disabled = data.page <= 1;
        document.getElementById("next-page").disabled = last >= data.total;
      } catch (cause) {
        showError(cause instanceof Error ? cause.message : "The claims list could not be loaded.");
      } finally {
        view.removeAttribute("aria-busy");
      }
    }
    function createDetailSection(title, className) {
      const section = document.createElement("section");
      section.className = "detail-section " + (className || "");
      const heading = document.createElement("h3");
      heading.textContent = title;
      section.append(heading);
      return section;
    }
    function appendDefinitionList(section, entries) {
      const list = document.createElement("dl");
      list.className = "detail-grid";
      for (const entry of entries) {
        const term = document.createElement("dt");
        term.textContent = entry[0];
        const description = document.createElement("dd");
        description.textContent = entry[1];
        list.append(term, description);
      }
      section.append(list);
    }
    function renderEvidenceSection(data) {
      const section = createDetailSection("Evidence", "detail-evidence");
      const sourcesTitle = document.createElement("h4");
      sourcesTitle.textContent = "Sources";
      const sources = document.createElement("div");
      if (data.claim.sources) sources.append(labels(splitLabels(data.claim.sources), "source", label));
      else {
        const empty = document.createElement("p");
        empty.className = "hint";
        empty.textContent = "No channel metadata on linked evidence.";
        sources.append(empty);
      }
      const evidenceTitle = document.createElement("h4");
      evidenceTitle.textContent = "Supporting evidence (" + data.evidence.length + ")";
      const evidence = document.createElement("div");
      evidence.className = "evidence-list";
      if (!data.evidence.length) {
        const empty = document.createElement("p");
        empty.className = "hint";
        empty.textContent = "No evidence segments are linked to this claim.";
        evidence.append(empty);
      }
      for (const item of data.evidence) {
        const card = document.createElement("article");
        card.className = "evidence-item";
        const heading = document.createElement("strong");
        heading.textContent = label(item.relation) + " · " + item.segment_id;
        const content = document.createElement("p");
        content.textContent = item.text || (item.deletion_state === "pending_delete" ? "This evidence segment is pending deletion." : "This evidence segment is no longer available.");
        card.append(heading, content);
        evidence.append(card);
      }
      section.append(sourcesTitle, sources, evidenceTitle, evidence);
      return section;
    }
    function renderActivitySection(data) {
      const section = createDetailSection("Activity", "detail-activity");
      appendDefinitionList(section, [
        ["Status", label(data.claim.status)],
        ["Provenance", label(data.claim.provenance)],
        ["Applicability", label(data.claim.applicability)],
        ["Used", String(data.claim.use_count ?? 0) + (data.claim.last_used_at ? " · " + formatDate(data.claim.last_used_at) : " · never")],
        ["Updated", formatDate(data.claim.updated_at)]
      ]);
      const historyTitle = document.createElement("h4");
      historyTitle.textContent = "Change history (" + data.audit.length + ")";
      const history = document.createElement("div");
      history.className = "evidence-list";
      if (!data.audit.length) {
        const empty = document.createElement("p");
        empty.className = "hint";
        empty.textContent = "No administrator changes have been recorded.";
        history.append(empty);
      }
      for (const item of data.audit) {
        const row = document.createElement("article");
        row.className = "evidence-item";
        const heading = document.createElement("strong");
        heading.textContent = label(item.action) + " · " + formatDate(item.created_at);
        const content = document.createElement("p");
        content.textContent = item.reason || "No reason provided.";
        row.append(heading, content);
        history.append(row);
      }
      section.append(historyTitle, history);
      return section;
    }
    async function openClaim(id) {
      const dialog = document.getElementById("claim-dialog");
      const detail = document.getElementById("claim-detail");
      detail.setAttribute("aria-busy", "true");
      detail.textContent = "Loading claim…";
      if (!dialog.open) dialog.showModal();
      try {
        const response = await fetch("/admin/api/claims/" + encodeURIComponent(id), { credentials: "same-origin", cache: "no-store" });
        if (!response.ok) throw new Error("The claim detail could not be loaded.");
        const data = await response.json();
        const claim = data.claim;
        claimState.currentClaim = claim;
        let structuredValue = claim.value_json;
        try { structuredValue = JSON.stringify(JSON.parse(structuredValue), null, 2); } catch {}
        const summary = createDetailSection("Summary", "detail-summary");
        const canonicalTitle = document.createElement("h4");
        canonicalTitle.textContent = "Canonical text";
        const canonical = document.createElement("div");
        canonical.className = "detail-content";
        canonical.textContent = claim.canonical_text;
        const structuredTitle = document.createElement("h4");
        structuredTitle.textContent = "Structured value";
        const structured = document.createElement("div");
        structured.className = "detail-content";
        structured.textContent = structuredValue;
        summary.append(canonicalTitle, canonical, structuredTitle, structured);
        const classification = createDetailSection("Classification", "detail-classification");
        appendDefinitionList(classification, [
          ["Project", claim.project_id],
          ["Scope", label(claim.scope_kind) + " · " + claim.scope_id],
          ["Category", label(claim.category)],
          ["Type", label(claim.type)],
          ["Confidence", (claim.confidence * 100).toFixed(0) + "%"],
          ["Subject", claim.subject],
          ["Memory key", claim.memory_key]
        ]);
        const tagsTitle = document.createElement("h4");
        tagsTitle.textContent = "Tags";
        const tags = document.createElement("div");
        if (!data.tags.length) {
          tags.className = "hint";
          tags.textContent = "No tags. Use Add tag to organize this claim.";
        }
        for (const tag of data.tags) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "tag remove-tag";
          button.dataset.tag = tag;
          button.textContent = tag + " ×";
          button.setAttribute("aria-label", "Remove tag " + tag);
          tags.append(button);
        }
        classification.append(tagsTitle, tags);
        detail.replaceChildren(summary, classification, renderEvidenceSection(data), renderActivitySection(data));
      } catch (cause) {
        detail.textContent = cause instanceof Error ? cause.message : "The claim detail could not be loaded.";
      } finally {
        detail.removeAttribute("aria-busy");
      }
    }
    async function refresh() {
      clearError();
      await loadOverview();
      await loadClaims();
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
      const claim = claimState.currentClaim;
      if (!claim) return;
      const canonicalText = prompt("Claim text:", claim.canonical_text);
      if (canonicalText === null) return;
      const rawValue = prompt("Structured JSON value:", claim.value_json);
      if (rawValue === null) return;
      try {
        await adminMutation("/admin/api/claims/" + encodeURIComponent(claim.id), "PUT", { canonical_text: canonicalText, value: JSON.parse(rawValue), reason: prompt("Reason for this edit (optional):") || null });
      } catch (cause) { showError(cause instanceof Error ? cause.message : "Claim edit failed."); }
    });
    async function quickEditClaim(claim) {
      const canonicalText = prompt("Claim text:", claim.canonical_text);
      if (canonicalText === null || !canonicalText.trim()) return;
      const rawValue = prompt("Structured JSON value:", claim.value_json || JSON.stringify(canonicalText.trim()));
      if (rawValue === null) return;
      try {
        let value = canonicalText.trim();
        try { value = JSON.parse(rawValue); } catch { value = rawValue; }
        await adminMutation("/admin/api/claims/" + encodeURIComponent(claim.id), "PUT", { canonical_text: canonicalText.trim(), value, reason: "admin edit" });
      } catch (cause) { showError(cause instanceof Error ? cause.message : "Claim edit failed."); }
    }
    async function quickDeleteClaim(claim) {
      if (!confirm('Delete claim "' + claim.canonical_text + '" permanently?')) return;
      try {
        await adminMutation("/admin/api/claims/" + encodeURIComponent(claim.id), "DELETE", { reason: "admin delete" });
        if (claimState.currentClaim && claimState.currentClaim.id === claim.id) document.getElementById("claim-dialog").close();
      } catch (cause) { showError(cause instanceof Error ? cause.message : "Claim deletion failed."); }
    }
    document.getElementById("delete-claim").addEventListener("click", async () => {
      const claim = claimState.currentClaim;
      if (!claim || !confirm('Delete claim "' + claim.canonical_text + '" permanently?')) return;
      try {
        await adminMutation("/admin/api/claims/" + encodeURIComponent(claim.id), "DELETE", { reason: "admin delete" });
        document.getElementById("claim-dialog").close();
      } catch (cause) { showError(cause instanceof Error ? cause.message : "Claim deletion failed."); }
    });
    document.getElementById("retract-claim").addEventListener("click", async () => {
      const claim = claimState.currentClaim;
      if (!claim || !confirm("Retract this claim? It will stop being used for retrieval.")) return;
      try {
        await adminMutation("/admin/api/claims/" + encodeURIComponent(claim.id) + "/retract", "POST", { reason: prompt("Reason for retraction (optional):") || null });
        document.getElementById("claim-dialog").close();
      } catch (cause) { showError(cause instanceof Error ? cause.message : "Claim retraction failed."); }
    });
    document.getElementById("add-tag").addEventListener("click", async () => {
      const claim = claimState.currentClaim;
      const tag = prompt("Tag (lowercase letters, numbers, - or _):");
      if (!claim || tag === null) return;
      try {
        await adminMutation("/admin/api/claims/" + encodeURIComponent(claim.id) + "/tags", "POST", { tag, reason: prompt("Reason for adding this tag (optional):") || null });
      } catch (cause) { showError(cause instanceof Error ? cause.message : "Adding tag failed."); }
    });
    document.getElementById("claim-filters").addEventListener("submit", (event) => { event.preventDefault(); claimState.page = 1; loadClaims(); });
    document.getElementById("previous-page").addEventListener("click", () => { if (claimState.page > 1) { claimState.page -= 1; loadClaims(); } });
    document.getElementById("next-page").addEventListener("click", () => { if (claimState.page * claimState.pageSize < claimState.total) { claimState.page += 1; loadClaims(); } });
    document.getElementById("close-dialog").addEventListener("click", () => document.getElementById("claim-dialog").close());
    document.getElementById("refresh").addEventListener("click", refresh);
    document.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const tab = target.closest("[role=tab][data-view]");
      if (tab) {
        setView(tab.dataset.view);
        return;
      }
      const projectAction = target.closest(".view-project-claims");
      if (projectAction) {
        document.getElementById("claim-project").value = projectAction.dataset.projectId;
        claimState.page = 1;
        setView("claims");
        loadClaims();
        return;
      }
      const openButton = target.closest(".open-claim");
      if (openButton) {
        openClaim(openButton.dataset.claimId);
        return;
      }
      const editButton = target.closest(".edit-claim");
      if (editButton) {
        const claim = claimState.claims.get(editButton.dataset.claimId);
        if (claim) quickEditClaim(claim);
        return;
      }
      const deleteButton = target.closest(".delete-claim");
      if (deleteButton) {
        const claim = claimState.claims.get(deleteButton.dataset.claimId);
        if (claim) quickDeleteClaim(claim);
        return;
      }
      const tagButton = target.closest(".remove-tag");
      if (tagButton) removeTag(tagButton.dataset.tag);
    });
    document.querySelector(".view-nav").addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const tabs = [...document.querySelectorAll("[role=tab]")];
      const current = tabs.indexOf(document.activeElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
      setView(tabs[next].dataset.view, true);
    });

    let promptDefaults = { extractor: "", verifier: "" };
    async function loadPrompts() {
      try {
        const response = await fetch("/admin/api/prompts", { credentials: "same-origin", cache: "no-store" });
        if (!response.ok) throw new Error("Prompt configuration could not be loaded.");
        const data = await response.json();
        document.getElementById("extractor-prompt").value = data.extractor_instructions;
        document.getElementById("verifier-prompt").value = data.verifier_instructions;
        promptDefaults = { extractor: data.default_extractor_instructions, verifier: data.default_verifier_instructions };
        setText("prompt-status", data.is_custom ? "Custom prompts saved" : "Compiled defaults");
      } catch (cause) {
        setText("prompt-status", cause instanceof Error ? cause.message : "Error loading prompts");
      }
    }
    document.getElementById("save-prompts").addEventListener("click", async () => {
      const extractor = document.getElementById("extractor-prompt").value.trim();
      const verifier = document.getElementById("verifier-prompt").value.trim();
      if (!extractor || !verifier) { alert("Both prompts must not be empty."); return; }
      try {
        const response = await fetch("/admin/api/prompts", {
          method: "PUT",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ extractor_instructions: extractor, verifier_instructions: verifier })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error?.message || "Save failed.");
        setText("prompt-status", "Custom prompts saved");
      } catch (cause) { alert(cause instanceof Error ? cause.message : "Save failed."); }
    });
    document.getElementById("reset-prompts").addEventListener("click", () => {
      if (!confirm("Reset both prompts to compiled defaults? Unsaved changes will be lost.")) return;
      document.getElementById("extractor-prompt").value = promptDefaults.extractor;
      document.getElementById("verifier-prompt").value = promptDefaults.verifier;
      setText("prompt-status", "Compiled defaults, unsaved changes");
    });
    document.getElementById("run-test").addEventListener("click", async () => {
      const evidence = document.getElementById("test-evidence").value.trim();
      if (!evidence) { alert("Enter some evidence text to test."); return; }
      const results = document.getElementById("test-results");
      results.textContent = "Running extraction test…";
      const button = document.getElementById("run-test");
      button.disabled = true;
      try {
        const response = await fetch("/admin/api/prompts/test", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            evidence_text: evidence,
            extractor_instructions: document.getElementById("extractor-prompt").value,
            verifier_instructions: document.getElementById("verifier-prompt").value
          })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error?.message || "Test failed.");
        results.replaceChildren();
        if (!data.candidates.length) {
          const empty = document.createElement("p");
          empty.className = "hint";
          empty.textContent = "No candidates extracted.";
          results.append(empty);
        }
        for (const [index, candidate] of data.candidates.entries()) {
          const card = document.createElement("article");
          card.className = "test-candidate";
          const title = document.createElement("h4");
          title.textContent = "Candidate " + index + ": " + label(candidate.candidate_kind || candidate.type || "Unknown") + " · " + (candidate.explicit ? "Explicit" : "Inferred");
          const text = document.createElement("div");
          text.className = "detail-content";
          text.textContent = candidate.canonical_text || "(no canonical_text)";
          card.append(title, text);
          const verdict = data.verdicts.find((item) => item.candidate_index === index);
          if (verdict) {
            const verdictElement = document.createElement("div");
            verdictElement.className = "test-verdict " + verdict.verdict;
            verdictElement.textContent = label(verdict.verdict) + " — " + verdict.reason;
            card.append(verdictElement);
          }
          results.append(card);
        }
        for (const [titleText, rawValue] of [["Raw extractor output", data.rawExtractor], ["Raw verifier output", data.rawVerifier]]) {
          if (!rawValue) continue;
          const details = document.createElement("details");
          const summary = document.createElement("summary");
          summary.textContent = titleText;
          const raw = document.createElement("div");
          raw.className = "test-raw";
          raw.textContent = rawValue;
          details.append(summary, raw);
          results.append(details);
        }
      } catch (cause) {
        results.textContent = cause instanceof Error ? cause.message : "Test failed.";
      } finally {
        button.disabled = false;
      }
    });
    setView("overview");
    loadPrompts();
    refresh();
  </script>
</body>
</html>`;
