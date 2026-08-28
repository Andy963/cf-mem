import type { Env } from "../env";

// Shared circuit breaker for the extractor LLM endpoint. One upstream
// (OpenRouter / PROFILE_EXTRACTOR_ENDPOINT) serves profile extraction,
// verification, reconciliation, and claim-dedup judging. When it starts
// failing, the breaker opens so cron ticks stop hammering a dead endpoint;
// after the cooldown a single real call is allowed through (half-open) and
// success closes it. State lives in a single D1 row because Workers have no
// cross-request memory and the project does not use KV.

const DEFAULT_OPEN_THRESHOLD = 3;
const DEFAULT_OPEN_MS = 10 * 60_000;

export class BreakerOpenError extends Error {
  readonly openUntilAt: number;
  constructor(openUntilAt: number) {
    super(`llm_breaker_open_until_${openUntilAt}`);
    this.name = "BreakerOpenError";
    this.openUntilAt = openUntilAt;
  }
}

export function isBreakerOpenError(error: unknown): error is BreakerOpenError {
  return error instanceof BreakerOpenError;
}

interface BreakerRow {
  consecutive_failures: number;
  open_until_at: number | null;
  last_error: string | null;
}

async function readBreakerState(db: D1Database): Promise<BreakerRow> {
  const row = await db.prepare(
    "SELECT consecutive_failures, open_until_at, last_error FROM llm_breaker_state WHERE id = 1",
  ).first<BreakerRow>();
  return {
    consecutive_failures: row?.consecutive_failures ?? 0,
    open_until_at: row?.open_until_at ?? null,
    last_error: row?.last_error ?? null,
  };
}

async function writeBreakerState(
  db: D1Database,
  state: { consecutive_failures: number; open_until_at: number | null; last_error: string | null },
  now: number,
): Promise<void> {
  await db.prepare(
    "UPDATE llm_breaker_state SET consecutive_failures = ?, open_until_at = ?, last_error = ?, updated_at = ? WHERE id = 1",
  ).bind(state.consecutive_failures, state.open_until_at, state.last_error, now).run();
}

// Classifies an error for the breaker. Network failures, timeouts, HTTP 5xx
// and 429 count; HTTP 4xx from our own bad request (400/401/403/422) does NOT
// — retrying those against a healthy provider would be pointless, but opening
// the breaker for them would block unrelated work that happens to be valid.
export function classifyBreakerFailure(error: unknown): string | null {
  const label = error instanceof Error ? error.message : String(error);
  if (/abort|timeout|network|fetch failed|econnreset|socket/i.test(label)) return `transport:${label}`.slice(0, 200);
  const httpMatch = /_http_(\d{3})/.exec(label);
  if (httpMatch) {
    const status = Number(httpMatch[1]);
    if (status === 429 || status >= 500) return `http_${status}`;
    return null;
  }
  // Response-missing-content and JSON-parse failures are provider-side quality
  // issues — they usually indicate the endpoint is degraded even when the HTTP
  // status was 200.
  if (/_response_missing_content|_invalid_json/.test(label)) return `quality:${label}`.slice(0, 200);
  return null;
}

// Wrap an LLM call: refuse to start while open; record success/failure after.
export async function withBreaker<T>(env: Env, call: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const state = await readBreakerState(env.DB);
  if (state.open_until_at !== null && state.open_until_at > now) {
    throw new BreakerOpenError(state.open_until_at);
  }

  try {
    const result = await call();
    if (state.consecutive_failures > 0 || state.open_until_at !== null) {
      await writeBreakerState(env.DB, { consecutive_failures: 0, open_until_at: null, last_error: null }, Date.now());
    }
    return result;
  } catch (error) {
    const failure = classifyBreakerFailure(error);
    if (!failure) throw error;
    const failures = state.consecutive_failures + 1;
    const open_until_at = failures >= DEFAULT_OPEN_THRESHOLD ? Date.now() + DEFAULT_OPEN_MS : null;
    await writeBreakerState(
      env.DB,
      {
        consecutive_failures: failures,
        open_until_at,
        last_error: failure,
      },
      Date.now(),
    );
    if (open_until_at !== null) {
      console.error(`[llm-breaker] OPENED after ${failures} consecutive failures (cooldown ${DEFAULT_OPEN_MS}ms): ${failure}`);
    }
    throw error;
  }
}
