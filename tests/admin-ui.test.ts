import { describe, expect, it } from "vitest";
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
    expect(DASHBOARD_HTML).toContain("permanently?");
    expect(DASHBOARD_HTML).toContain("Retract this claim? It will stop being used for retrieval.");
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
});
