import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { handleAdminRequest } from "../src/admin";
import type { Env } from "../src/env";

const ACCESS_TEAM_DOMAIN = "https://admin-access-test.cloudflareaccess.com";
const ACCESS_AUDIENCE = "admin-access-test-audience";

let privateKey: CryptoKey;
let publicJwk: JWK;

function createEnvironment(overrides: Partial<Env> = {}): Env {
  return {
    ADMIN_ALLOWED_EMAIL: "admin@example.com",
    ADMIN_ACCESS_TEAM_DOMAIN: ACCESS_TEAM_DOMAIN,
    ADMIN_ACCESS_AUD: ACCESS_AUDIENCE,
    ...overrides,
  } as Env;
}

async function createToken(overrides: { audience?: string; issuer?: string; email?: string } = {}): Promise<string> {
  return new SignJWT({ email: overrides.email ?? "admin@example.com" })
    .setProtectedHeader({ alg: "RS256", kid: publicJwk.kid })
    .setIssuer(overrides.issuer ?? ACCESS_TEAM_DOMAIN)
    .setAudience(overrides.audience ?? ACCESS_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}

async function createAdminRequest(options: {
  token?: string;
  email?: string;
  env?: Env;
} = {}): Promise<Response> {
  const headers = new Headers();
  if (options.token) headers.set("Cf-Access-Jwt-Assertion", options.token);
  if (options.email) headers.set("Cf-Access-Authenticated-User-Email", options.email);
  return handleAdminRequest(
    new Request("https://cf-mem.test/admin", { headers }),
    options.env ?? createEnvironment(),
  );
}

beforeAll(async () => {
  const keyPair = await generateKeyPair("RS256");
  privateKey = keyPair.privateKey;
  publicJwk = await exportJWK(keyPair.publicKey);
  publicJwk.kid = "admin-access-test-key";
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";
});

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ keys: [publicJwk] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Cloudflare Access admin authentication", () => {
  it("accepts a valid Access JWT for the configured team and application", async () => {
    const token = await createToken();
    const response = await createAdminRequest({ token, email: "admin@example.com" });

    expect(response.status).toBe(200);
  });

  it("rejects a forged email header without an Access JWT", async () => {
    const response = await createAdminRequest({ email: "admin@example.com" });

    expect(response.status).toBe(403);
  });

  it("rejects a tampered Access JWT", async () => {
    const token = await createToken();
    const parts = token.split(".");
    const signature = parts[2];
    parts[2] = `${signature[0] === "a" ? "b" : "a"}${signature.slice(1)}`;
    const response = await createAdminRequest({
      token: parts.join("."),
      email: "admin@example.com",
    });

    expect(response.status).toBe(403);
  });

  it("rejects a signed token for a different Access application", async () => {
    const token = await createToken({ audience: "another-app" });
    const response = await createAdminRequest({
      token,
      email: "admin@example.com",
      env: createEnvironment({
        ADMIN_ACCESS_TEAM_DOMAIN: ACCESS_TEAM_DOMAIN,
        ADMIN_ACCESS_AUD: ACCESS_AUDIENCE,
      }),
    });

    expect(response.status).toBe(403);
  });

  it("rejects a signed token from a different Access team", async () => {
    const token = await createToken({ issuer: "https://other-team.cloudflareaccess.com" });
    const response = await createAdminRequest({ token, email: "admin@example.com" });

    expect(response.status).toBe(403);
  });

  it("rejects a token whose email header was changed", async () => {
    const token = await createToken();
    const response = await createAdminRequest({ token, email: "other@example.com" });

    expect(response.status).toBe(403);
  });

  it("fails closed when the configured team domain is invalid", async () => {
    const response = await createAdminRequest({
      env: createEnvironment({ ADMIN_ACCESS_TEAM_DOMAIN: "https://example.com" }),
    });

    expect(response.status).toBe(503);
  });

  it("fails closed when issuer and audience pins are missing", async () => {
    const response = await createAdminRequest({
      env: createEnvironment({
        ADMIN_ACCESS_TEAM_DOMAIN: undefined,
        ADMIN_ACCESS_AUD: undefined,
      }),
    });

    expect(response.status).toBe(503);
  });
});
