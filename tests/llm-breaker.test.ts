import type { D1Database } from "@cloudflare/workers-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { withBreaker } from "../src/memory/llm-breaker";

interface BreakerSnapshot {
  consecutive_failures: number;
  open_until_at: number | null;
  last_error: string | null;
  updated_at: number;
}

interface RecordedStatement {
  sql: string;
  values: unknown[];
}

function createDatabase(initial: Partial<BreakerSnapshot> = {}): {
  db: D1Database;
  state: BreakerSnapshot;
  statements: RecordedStatement[];
} {
  const state: BreakerSnapshot = {
    consecutive_failures: 0,
    open_until_at: null,
    last_error: null,
    updated_at: 1,
    ...initial,
  };
  const statements: RecordedStatement[] = [];

  const db = {
    prepare(sql: string) {
      const statement: RecordedStatement = { sql, values: [] };
      statements.push(statement);
      return {
        bind(...values: unknown[]) {
          statement.values = values;
          return {
            async run() {
              if (sql.includes("consecutive_failures = consecutive_failures + 1")) {
                const [threshold, now, nextOpenUntil, failure, updatedAt] = values;
                const nextFailures = state.consecutive_failures + 1;
                if (
                  nextFailures >= Number(threshold)
                  && (state.open_until_at === null || state.open_until_at <= Number(now))
                ) {
                  state.open_until_at = Number(nextOpenUntil);
                }
                state.consecutive_failures = nextFailures;
                state.last_error = String(failure);
                state.updated_at = Math.max(state.updated_at + 1, Number(updatedAt));
                return { meta: { changes: 1 } };
              }

              if (sql.includes("SET consecutive_failures = 0")) {
                const [updatedAt, expectedFailures, expectedOpenUntil, expectedOpenUntilAgain,
                  expectedError, expectedErrorAgain, expectedVersion] = values;
                const matches = state.consecutive_failures === Number(expectedFailures)
                  && state.open_until_at === expectedOpenUntil
                  && state.open_until_at === expectedOpenUntilAgain
                  && state.last_error === expectedError
                  && state.last_error === expectedErrorAgain
                  && state.updated_at === Number(expectedVersion);
                if (!matches) return { meta: { changes: 0 } };

                state.consecutive_failures = 0;
                state.open_until_at = null;
                state.last_error = null;
                state.updated_at = Math.max(state.updated_at + 1, Number(updatedAt));
                return { meta: { changes: 1 } };
              }

              throw new Error(`Unexpected statement: ${sql}`);
            },
          };
        },
        async first<T>() {
          return { ...state } as T;
        },
      };
    },
  } as unknown as D1Database;

  return { db, state, statements };
}

function createEnv(db: D1Database): Env {
  return { DB: db } as Env;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("withBreaker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("atomically counts concurrent classified failures and opens at the threshold", async () => {
    const { db, state, statements } = createDatabase();
    const calls = [deferred<void>(), deferred<void>(), deferred<void>()];
    const allCallsStarted = deferred<void>();
    let started = 0;
    const requests = calls.map((call) => withBreaker(createEnv(db), async () => {
      started += 1;
      if (started === calls.length) allCallsStarted.resolve();
      return call.promise;
    }));

    await allCallsStarted.promise;
    for (const call of calls) call.reject(new Error("upstream_http_503"));
    const results = await Promise.allSettled(requests);

    expect(results.every((result) => result.status === "rejected")).toBe(true);
    expect(state.consecutive_failures).toBe(3);
    expect(state.open_until_at).toBe(1_600_000);
    const failureUpdates = statements.filter((statement) => statement.sql.includes(
      "consecutive_failures = consecutive_failures + 1",
    ));
    expect(failureUpdates).toHaveLength(3);
    expect(failureUpdates[0]?.sql).toContain("open_until_at = CASE");
  });

  it("does not let a stale success clear a failure recorded while it was running", async () => {
    const { db, state } = createDatabase({
      consecutive_failures: 1,
      last_error: "http_503",
      updated_at: 10,
    });
    const successResult = deferred<string>();
    const successStarted = deferred<void>();
    const success = withBreaker(createEnv(db), async () => {
      successStarted.resolve();
      return successResult.promise;
    });

    await successStarted.promise;
    await expect(withBreaker(createEnv(db), async () => {
      throw new Error("upstream_http_503");
    })).rejects.toThrow("upstream_http_503");
    successResult.resolve("ok");

    await expect(success).resolves.toBe("ok");
    expect(state.consecutive_failures).toBe(2);
    expect(state.last_error).toBe("http_503");
  });

  it("does not change breaker state for a non-breaker error", async () => {
    const { db, state, statements } = createDatabase({
      consecutive_failures: 1,
      last_error: "http_503",
      updated_at: 10,
    });

    await expect(withBreaker(createEnv(db), async () => {
      throw new Error("upstream_http_400");
    })).rejects.toThrow("upstream_http_400");

    expect(state).toEqual({
      consecutive_failures: 1,
      open_until_at: null,
      last_error: "http_503",
      updated_at: 10,
    });
    expect(statements.some((statement) => statement.sql.includes(
      "consecutive_failures = consecutive_failures + 1",
    ))).toBe(false);
  });

  it("clears an old failure state after a current successful call", async () => {
    const { db, state, statements } = createDatabase({
      consecutive_failures: 3,
      open_until_at: 999_000,
      last_error: "http_503",
      updated_at: 10,
    });

    await expect(withBreaker(createEnv(db), async () => "ok")).resolves.toBe("ok");

    expect(state).toEqual({
      consecutive_failures: 0,
      open_until_at: null,
      last_error: null,
      updated_at: 1_000_000,
    });
    expect(statements.some((statement) => statement.sql.includes(
      "AND updated_at = ?",
    ))).toBe(true);
  });
});
