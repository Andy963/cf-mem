import { createRemoteJWKSet, decodeJwt, jwtVerify } from "jose";
import type { Env } from "./env";

const ACCESS_ISSUER_SUFFIX = ".cloudflareaccess.com";
const JWKS_CACHE_MAX_AGE_MS = 10 * 60 * 1_000;
const remoteJwksByIssuer = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export interface AdminIdentity {
  email: string;
}

function normalizedAccessIssuer(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:"
      || url.username
      || url.password
      || url.port
      || url.pathname !== "/"
      || url.search
      || url.hash
      || !url.hostname.endsWith(ACCESS_ISSUER_SUFFIX)
      || url.hostname === ACCESS_ISSUER_SUFFIX.slice(1)
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function configuredAccessIssuer(env: Env): string | null {
  const rawIssuer = env.ADMIN_ACCESS_TEAM_DOMAIN?.trim();
  if (!rawIssuer) return null;
  return normalizedAccessIssuer(rawIssuer);
}

export function adminAccessConfigured(env: Env): boolean {
  if (!env.ADMIN_ALLOWED_EMAIL?.trim()) return false;
  if (env.ADMIN_ACCESS_TEAM_DOMAIN !== undefined && !configuredAccessIssuer(env)) return false;
  return true;
}

function remoteJwks(issuer: string): ReturnType<typeof createRemoteJWKSet> {
  const cached = remoteJwksByIssuer.get(issuer);
  if (cached) return cached;

  const jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`), {
    cacheMaxAge: JWKS_CACHE_MAX_AGE_MS,
    cooldownDuration: 30_000,
    timeoutDuration: 5_000,
  });
  remoteJwksByIssuer.set(issuer, jwks);
  return jwks;
}

export async function verifyAdminAccess(request: Request, env: Env): Promise<AdminIdentity | null> {
  const token = request.headers.get("Cf-Access-Jwt-Assertion")?.trim();
  const allowedEmail = env.ADMIN_ALLOWED_EMAIL?.trim().toLowerCase();
  const configuredIssuer = env.ADMIN_ACCESS_TEAM_DOMAIN === undefined
    ? null
    : configuredAccessIssuer(env);
  const audience = env.ADMIN_ACCESS_AUD?.trim() || undefined;
  if (!token || !allowedEmail || !adminAccessConfigured(env) || (env.ADMIN_ACCESS_TEAM_DOMAIN !== undefined && !configuredIssuer)) {
    return null;
  }

  try {
    const unverifiedPayload = decodeJwt(token);
    const tokenIssuer = typeof unverifiedPayload.iss === "string"
      ? normalizedAccessIssuer(unverifiedPayload.iss)
      : null;
    if (!tokenIssuer || (configuredIssuer && tokenIssuer !== configuredIssuer)) return null;

    const { payload } = await jwtVerify(token, remoteJwks(tokenIssuer), {
      issuer: tokenIssuer,
      audience,
      algorithms: ["RS256"],
      requiredClaims: ["aud", "email", "exp", "iat", "iss"],
    });
    const tokenEmail = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : null;
    const headerEmail = request.headers.get("Cf-Access-Authenticated-User-Email")?.trim().toLowerCase() ?? null;
    if (!tokenEmail || tokenEmail !== allowedEmail || headerEmail !== tokenEmail) return null;
    return { email: tokenEmail };
  } catch {
    return null;
  }
}
