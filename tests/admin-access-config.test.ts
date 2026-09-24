import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function readRepositoryFile(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

describe("Admin deployment configuration", () => {
  it("disables alternate public endpoints in the template", () => {
    const config = readRepositoryFile("wrangler.toml.example");

    expect(config).toMatch(/^workers_dev = false$/m);
    expect(config).toMatch(/^preview_urls = false$/m);
    expect(config).toContain("ADMIN_ACCESS_TEAM_DOMAIN");
    expect(config).toContain("ADMIN_ACCESS_AUD");
  });

  it.skipIf(!existsSync(fileURLToPath(new URL("../wrangler.toml", import.meta.url))))(
    "pins the active Admin deployment and disables preview URLs",
    () => {
      const config = readRepositoryFile("wrangler.toml");

      expect(config).toMatch(/^workers_dev = false$/m);
      expect(config).toMatch(/^preview_urls = false$/m);
      expect(config).toMatch(/^\[\[routes\]\]$/m);
      expect(config).toMatch(/^ADMIN_ACCESS_TEAM_DOMAIN = "https:\/\/[^"]+\.cloudflareaccess\.com"$/m);
      expect(config).toMatch(/^ADMIN_ACCESS_AUD = "[^"]+"$/m);
    },
  );
});
