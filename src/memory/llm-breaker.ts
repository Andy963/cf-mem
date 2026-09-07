import type { Env } from "../env";

// Shared circuit breaker for the extractor LLM endpoint. One upstream
// (EXTRACTOR_LLM_API_BASE) serves profile extraction, verification,
// reconciliation, and claim-dedup judging. When it starts
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
  updated_at: number | null;
}

async function readBreakerState(db: D1Database): Promise<BreakerRow> {
  try {
    const row = await db.prepare(
      "SELECT consecutive_failures, open_until_at, last_error, updated_at FROM llm_breaker_state WHERE id = 1",
    ).first<BreakerRow>();
    return {
      consecutive_failures: row?.consecutive_failures ?? 0,
      open_until_at: row?.open_until_at ?? null,
      last_error: row?.last_error ?? null,
      updated_at: row?.updated_at ?? null,
    };
  } catch {
    // A missing or temporarily unavailable state table must not block the
    // underlying LLM request. Treat the breaker as closed until D1 recovers.
    return { consecutive_failures: 0, open_until_at: null, last_error: null, updated_at: null };
  }
}

export async function getBreakerOpenUntilAt(env: Env): Promise<number | null> {
  try {
    const state = await readBreakerState(env.DB);
    return state.open_until_at !== null && state.open_until_at > Date.now() ? state.open_until_at : null;
  } catch {
    // The preflight check must not block extraction when breaker state is unavailable.
    return null;
  }
}

async function recordBreakerFailureBestEffort(db: D1Database, failure: string, now: number): Promise<BreakerRow> {
  try {
    // The increment must happen in SQLite. Reading the count before the
    // provider call and writing an absolute value loses concurrent failures.
    await db.prepare(
      `UPDATE llm_breaker_state
       SET consecutive_failures = consecutive_failures + 1,
           open_until_at = CASE
             WHEN consecutive_failures + 1 >= ?
               AND (open_until_at IS NULL OR open_until_at <= ?)
             THEN ?
             ELSE open_until_at
           END,
           last_error = ?,
           updated_at = MAX(updated_at + 1, ?)
       WHERE id = 1`,
    ).bind(DEFAULT_OPEN_THRESHOLD, now, now + DEFAULT_OPEN_MS, failure, now).run();

    // This is only for the existing operational log. The state transition is
    // already complete in the atomic UPDATE above, so a stale read here cannot
    // reintroduce the lost-update race.
    return await readBreakerState(db);
  } catch (error) {
    // Breaker persistence is telemetry and coordination state. It must never
    // replace a successful provider result or the provider's original error.
    console.error(`[llm-breaker] failed to persist state: ${error instanceof Error ? error.message : String(error)}`);
    return { consecutive_failures: 0, open_until_at: null, last_error: null, updated_at: null };
  }
}

async function resetBreakerStateBestEffort(db: D1Database, state: BreakerRow, now: number): Promise<void> {
  try {
    // A slow success may have started before another request recorded a
    // failure. Only clear the row if every value, including the monotonic
    // updated_at version, is still the value observed before the call.
    await db.prepare(
      `UPDATE llm_breaker_state
       SET consecutive_failures = 0,
           open_until_at = NULL,
           last_error = NULL,
           updated_at = MAX(updated_at + 1, ?)
       WHERE id = 1
         AND consecutive_failures = ?
         AND (open_until_at = ? OR (open_until_at IS NULL AND ? IS NULL))
         AND (last_error = ? OR (last_error IS NULL AND ? IS NULL))
         AND updated_at = ?`,
    ).bind(
      now,
      state.consecutive_failures,
      state.open_until_at,
      state.open_until_at,
      state.last_error,
      state.last_error,
      state.updated_at,
    ).run();
  } catch (error) {
    // Breaker persistence is telemetry and coordination state. It must never
    // replace a successful provider result or the provider's original error.
    console.error(`[llm-breaker] failed to persist state: ${error instanceof Error ? error.message : String(error)}`);
  }
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
      await resetBreakerStateBestEffort(env.DB, state, Date.now());
    }
    return result;
  } catch (error) {
    const failure = classifyBreakerFailure(error);
    if (!failure) throw error;
    const failureState = await recordBreakerFailureBestEffort(env.DB, failure, Date.now());
    if (failureState.open_until_at !== null && failureState.open_until_at > Date.now()) {
      console.error(
        `[llm-breaker] OPENED after ${failureState.consecutive_failures} consecutive failures `
        + `(cooldown ${DEFAULT_OPEN_MS}ms): ${failure}`,
      );
    }
    throw error;
  }
}
