import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Window } from "happy-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DASHBOARD_HTML } from "../src/admin/ui";

function inlineScript(): string {
  const match = DASHBOARD_HTML.match(/<script>([\s\S]*)<\/script>/);
  if (!match) throw new Error("Admin dashboard script is missing");
  return match[1];
}

describe("Admin dashboard information architecture", () => {
  it("separates overview, claims, and extraction prompts into accessible views", () => {
    expect(DASHBOARD_HTML).toContain('role="tablist" aria-label="Admin sections"');
    expect(DASHBOARD_HTML).toContain('data-view="overview"');
    expect(DASHBOARD_HTML).toContain('data-view="claims"');
    expect(DASHBOARD_HTML).toContain('data-view="prompts"');
    expect(DASHBOARD_HTML).toContain('id="overview-view" role="tabpanel"');
    expect(DASHBOARD_HTML).toContain('id="claims-view" role="tabpanel"');
    expect(DASHBOARD_HTML).toContain('id="prompts-view" role="tabpanel"');
    expect(DASHBOARD_HTML).toContain("ArrowLeft");
    expect(DASHBOARD_HTML).toContain("ArrowRight");
  });

  it("renders scannable desktop columns and a narrow-screen card view", () => {
    for (const heading of ["Claim", "Classification", "Evidence", "Status", "Usage", "Updated", "Actions"]) {
      expect(DASHBOARD_HTML).toContain(`<th>${heading}</th>`);
    }
    expect(DASHBOARD_HTML).toContain('class="claim-cards" id="claim-cards"');
    expect(DASHBOARD_HTML).toContain("@media (max-width: 720px)");
    expect(DASHBOARD_HTML).toContain(".claims-table-wrap { display: none; }");
    expect(DASHBOARD_HTML).toContain(".claim-cards { display: block; }");
    expect(DASHBOARD_HTML).not.toContain("min-width: 620px");
  });

  it("connects project usage to a visible claim filter", () => {
    expect(DASHBOARD_HTML).toContain("view-project-claims");
    expect(DASHBOARD_HTML).toContain('id="active-filters" aria-live="polite"');
    expect(DASHBOARD_HTML).toContain("Showing all claims");
    expect(DASHBOARD_HTML).toContain("Active filters:");
    expect(DASHBOARD_HTML).toContain('action.dataset.projectId = project.project_id');
  });

  it("groups claim details and normalizes stored enum values for display", () => {
    expect(DASHBOARD_HTML).toContain('createDetailSection("Summary", "detail-summary")');
    expect(DASHBOARD_HTML).toContain('createDetailSection("Classification", "detail-classification")');
    expect(DASHBOARD_HTML).toContain('createDetailSection("Evidence", "detail-evidence")');
    expect(DASHBOARD_HTML).toContain('createDetailSection("Activity", "detail-activity")');
    expect(DASHBOARD_HTML).toContain('domain_fact: "Domain fact"');
    expect(DASHBOARD_HTML).toContain('user_profile: "User profile"');
    expect(DASHBOARD_HTML).toContain('pending_delete: "Pending deletion"');
  });

  it("separates routine and destructive actions while retaining confirmation", () => {
    expect(DASHBOARD_HTML).toContain('divider.className = "action-divider"');
    expect(DASHBOARD_HTML).toContain('class="destructive-actions"');
    expect(DASHBOARD_HTML).toContain('remove.className = "op-button danger delete-claim"');
    expect(DASHBOARD_HTML).toContain('edit.setAttribute("aria-label", "Edit claim " + claim.subject)');
    expect(DASHBOARD_HTML).toContain('remove.setAttribute("aria-label", "Delete claim " + claim.subject)');
    expect(DASHBOARD_HTML).toContain("permanently?");
    expect(DASHBOARD_HTML).toContain("Retract this claim? It will stop being used for retrieval.");
  });

  it("keeps the mobile detail drawer scrollable", () => {
    expect(DASHBOARD_HTML).toContain("dialog:not([open]) { display: none; }");
    expect(DASHBOARD_HTML).toContain("dialog[open] { display: flex; flex-direction: column; }");
    expect(DASHBOARD_HTML).toContain("#claim-detail { flex: 1 1 auto; min-height: 0;");
    expect(DASHBOARD_HTML).toContain("overflow-y: auto; padding: 18px;");
  });

  it("preserves claim, prompt, filter, pagination, and tag workflows", () => {
    for (const path of [
      "/admin/api/overview",
      "/admin/api/claims?",
      "/admin/api/prompts",
      "/admin/api/prompts/test",
      '"/tags/"',
      '"/retract"',
    ]) {
      expect(DASHBOARD_HTML).toContain(path);
    }
    expect(DASHBOARD_HTML).toContain('id="claim-query"');
    expect(DASHBOARD_HTML).toContain('id="claim-project"');
    expect(DASHBOARD_HTML).toContain('id="previous-page"');
    expect(DASHBOARD_HTML).toContain('id="next-page"');
    expect(DASHBOARD_HTML).toContain('id="save-prompts"');
    expect(DASHBOARD_HTML).toContain('id="reset-prompts"');
    expect(DASHBOARD_HTML).toContain('id="run-test"');
  });

  it("emits syntactically valid inline JavaScript", () => {
    expect(() => new Function(inlineScript())).not.toThrow();
  });

  const chromePath = process.env.CHROME_BIN || ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find(existsSync);
  it.skipIf(!chromePath)("keeps a closed claim dialog hidden in Chromium", () => {
    const directory = mkdtempSync(join(tmpdir(), "cf-mem-admin-ui-"));
    const file = join(directory, "dashboard.html");
    try {
      const measurement = `<script>setTimeout(() => { document.body.dataset.closedDialogDisplay = getComputedStyle(document.getElementById("claim-dialog")).display; }, 50);</script>`;
      writeFileSync(file, DASHBOARD_HTML.replace(/<script>[\s\S]*<\/script>/, measurement));
      const output = execFileSync(chromePath as string, [
        "--headless",
        "--no-sandbox",
        "--disable-gpu",
        "--virtual-time-budget=500",
        "--dump-dom",
        `file://${file}`
      ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

      expect(output).toContain('data-closed-dialog-display="none"');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 15_000);
});

const sampleClaim = {
  id: "claim-1",
  project_id: "cf-mem",
  canonical_text: "Validated dashboard claim.",
  subject: "Dashboard validation",
  memory_key: "admin.dashboard.validation",
  tags: "admin,ui",
  category: "domain_fact",
  type: "decision",
  scope_kind: "project",
  sources: "codex,github",
  status: "active",
  confidence: 0.95,
  use_count: 3,
  last_used_at: 1787548800000,
  updated_at: 1787635200000
};

const dashboardWindows: Window[] = [];

afterEach(() => {
  for (const window of dashboardWindows.splice(0)) window.happyDOM.abort();
  vi.restoreAllMocks();
});

async function createDashboard(): Promise<{
  window: Window;
  fetchMock: ReturnType<typeof vi.fn>;
  promptMock: ReturnType<typeof vi.fn>;
  confirmMock: ReturnType<typeof vi.fn>;
}> {
  const window = new Window({ url: "https://cf-mem.test/admin" });
  dashboardWindows.push(window);
  const promptMock = vi.fn().mockReturnValue(null);
  const confirmMock = vi.fn().mockReturnValue(true);
  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const json = (value: unknown) => new Response(JSON.stringify(value), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
    if (url === "/admin/api/claims/claim-1" && init?.method === "DELETE") return json({ ok: true, deleted: true });
    if (url === "/admin/api/claims/claim-1") {
      return json({
        claim: {
          ...sampleClaim,
          scope_id: "cf-mem",
          value_json: JSON.stringify({ validated: true }),
          provenance: "user_confirmed",
          applicability: "semantic"
        },
        evidence: [{ segment_id: "seg-1", relation: "supports", deletion_state: "active", text: "Evidence" }],
        tags: ["admin", "ui"],
        audit: [{ action: "edit", actor_email: "admin@example.com", reason: "Reviewed", created_at: 1787548800000 }]
      });
    }
    if (url.startsWith("/admin/api/overview")) {
      return json({
        summary: {
          claims_total: 1,
          claims_active: 1,
          segments_total: 1,
          segments_pending_deletion: 0,
          storage_bytes: 1024,
          projects_total: 1,
          newest_update_at: 1787635200000
        },
        projects: [{
          project_id: "cf-mem",
          claims_total: 1,
          segments_total: 1,
          storage_bytes: 1024,
          newest_update_at: 1787635200000
        }]
      });
    }
    if (url.startsWith("/admin/api/claims?")) return json({ page: 1, page_size: 25, total: 1, claims: [sampleClaim] });
    if (url.startsWith("/admin/api/prompts")) {
      return json({
        extractor_instructions: "Extract",
        verifier_instructions: "Verify",
        is_custom: false,
        default_extractor_instructions: "Extract",
        default_verifier_instructions: "Verify"
      });
    }
    return json({ ok: true });
  });
  Object.assign(window, {
    fetch: fetchMock,
    prompt: promptMock,
    confirm: confirmMock,
    alert: vi.fn()
  });
  const html = DASHBOARD_HTML.replace(/<script>[\s\S]*<\/script>/, "");
  window.document.open();
  window.document.write(html);
  window.document.close();
  window.eval(inlineScript());
  await new Promise((resolve) => setTimeout(resolve, 10));
  return { window, fetchMock, promptMock, confirmMock };
}

describe("Admin dashboard interactions", () => {
  it("moves focus to Claims when project usage opens the filtered view", async () => {
    const { window } = await createDashboard();
    await vi.waitFor(() => {
      expect(window.document.querySelector('#claim-project option[value="cf-mem"]')).not.toBeNull();
    });
    const projectAction = window.document.querySelector<HTMLButtonElement>(".view-project-claims");
    expect(projectAction).not.toBeNull();

    projectAction?.click();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(window.document.querySelector<HTMLElement>("#overview-view")?.hidden).toBe(true);
    expect(window.document.querySelector<HTMLElement>("#claims-view")?.hidden).toBe(false);
    expect(window.document.activeElement?.id).toBe("tab-claims");
    expect(window.document.querySelector<HTMLSelectElement>("#claim-project")?.value).toBe("cf-mem");
  });

  it("supports keyboard tab navigation and synchronized panel visibility", async () => {
    const { window } = await createDashboard();
    const overviewTab = window.document.querySelector<HTMLButtonElement>("#tab-overview");
    overviewTab?.focus();
    overviewTab?.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));

    expect(window.document.activeElement?.id).toBe("tab-claims");
    expect(window.document.querySelector<HTMLElement>("#claims-view")?.hidden).toBe(false);
    expect(window.document.querySelector<HTMLElement>("#overview-view")?.hidden).toBe(true);
  });

  it("uses row claim data for desktop and mobile actions", async () => {
    const { window, promptMock } = await createDashboard();
    const desktopEdit = window.document.querySelector<HTMLButtonElement>("#claim-rows .edit-claim");
    const mobileEdit = window.document.querySelector<HTMLButtonElement>("#claim-cards .edit-claim");

    expect(desktopEdit?.getAttribute("aria-label")).toBe("Edit claim Dashboard validation");
    expect(mobileEdit?.getAttribute("aria-label")).toBe("Edit claim Dashboard validation");
    desktopEdit?.click();
    mobileEdit?.click();

    expect(promptMock).toHaveBeenNthCalledWith(1, "Claim text:", sampleClaim.canonical_text);
    expect(promptMock).toHaveBeenNthCalledWith(2, "Claim text:", sampleClaim.canonical_text);
  });

  it("opens grouped claim details and routes destructive actions", async () => {
    const { window, fetchMock, confirmMock } = await createDashboard();
    const openButton = window.document.querySelector<HTMLButtonElement>("#claim-rows .open-claim");
    openButton?.click();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(window.document.querySelector<HTMLDialogElement>("#claim-dialog")?.open).toBe(true);
    expect([...window.document.querySelectorAll(".detail-section h3")].map((heading) => heading.textContent)).toEqual([
      "Summary",
      "Classification",
      "Evidence",
      "Activity"
    ]);
    window.document.querySelector<HTMLButtonElement>("#close-dialog")?.click();
    window.document.querySelector<HTMLButtonElement>("#claim-rows .delete-claim")?.click();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(confirmMock).toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([url, options]) => String(url).includes("/admin/api/claims/claim-1") && options?.method === "DELETE")).toBe(true);
  });
});
