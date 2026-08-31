export interface HttpEnv {
  CORS_ALLOW_ORIGIN?: string;
}

export function corsHeaders(env: HttpEnv): Headers {
  const headers = new Headers();
  headers.set("Access-Control-Allow-Origin", env.CORS_ALLOW_ORIGIN ?? "*");
  headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type,Authorization,X-Api-Key,X-Project-Id");
  headers.set("Access-Control-Max-Age", "86400");
  headers.set("Access-Control-Allow-Credentials", "false");
  return headers;
}

export function jsonResponse(env: HttpEnv, body: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");

  for (const [headerName, headerValue] of corsHeaders(env).entries()) {
    headers.set(headerName, headerValue);
  }

  return new Response(JSON.stringify(body), { ...init, headers });
}

export function textResponse(env: HttpEnv, text: string, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "text/plain; charset=utf-8");

  for (const [headerName, headerValue] of corsHeaders(env).entries()) {
    headers.set(headerName, headerValue);
  }

  return new Response(text, { ...init, headers });
}

export function getBearerToken(request: Request): string | null {
  const authorization = request.headers.get("Authorization") ?? request.headers.get("authorization");
  if (!authorization) return null;

  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? null;
}

export function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

export function isAuthorized(request: Request, expectedToken: string): boolean {
  const bearerToken = getBearerToken(request);
  if (bearerToken && constantTimeEqual(bearerToken, expectedToken)) return true;

  const apiKey = request.headers.get("X-Api-Key") ?? request.headers.get("x-api-key");
  return Boolean(apiKey && constantTimeEqual(apiKey, expectedToken));
}

export function unauthorizedResponse(env: HttpEnv, realm: string): Response {
  return jsonResponse(
    env,
    { error: { message: "Unauthorized" } },
    { status: 401, headers: { "WWW-Authenticate": `Bearer realm="${realm}"` } },
  );
}

export async function parseJson(request: Request): Promise<unknown> {
  const contentType = request.headers.get("Content-Type") ?? request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new Error("Content-Type must be application/json");
  }

  return await request.json();
}
