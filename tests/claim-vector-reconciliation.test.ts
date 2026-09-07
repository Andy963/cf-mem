import type { D1Database } from "@cloudflare/workers-types";
import { describe, expect, it, vi } from "vitest";
import type { StoredClaimRow } from "../src/db/d1";
import type { Env, VectorizeIndex } from "../src/env";
import { runClaimVectorReconciliation } from "../src/memory/claim-reconciliation";

interface Job {
  project_id: string;
  claim_id: string;
  revision: number;
  operation: "upsert" | "delete";
  claim_updated_at: number;
  status: "pending" | "processing" | "failed";
  attempt_count: number;
  last_error: string | null;
  next_attempt_at: number;
  lease_token: string | null;
  lease_expires_at: number | null;
  created_at: number;
  updated_at: number;
}

function createClaim(status: StoredClaimRow["status"] = "active"): StoredClaimRow {
  return {
    id: "claim-1",
    project_id: "project-1",
    scope_kind: "project",
    scope_id: "project-1",
    category: "domain_fact",
    type: "decision",
    subject: "subject",
    memory_key: "key",
    value_json: JSON.stringify({ value: "one" }),
    canonical_text: "The project uses a durable claim.",
    status,
    provenance: "user_confirmed",
    confidence: 1,
    valid_from: null,
    valid_until: null,
    superseded_by: null,
    applicability: "semantic",
    workspace_id: null,
    use_count: 0,
    last_used_at: null,
    created_at: 1,
    updated_at: 1,
  };
}

function createJob(overrides: Partial<Job> = {}): Job {
  return {
    project_id: "project-1",
    claim_id: "claim-1",
    revision: 1,
    operation: "upsert",
    claim_updated_at: 1,
    status: "pending",
    attempt_count: 0,
    last_error: null,
    next_attempt_at: 0,
    lease_token: null,
    lease_expires_at: null,
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

function createDatabase(claim: StoredClaimRow | null, initialJob: Job) {
  const jobs = new Map<string, Job>([[`${initialJob.project_id}:${initialJob.claim_id}`, initialJob]]);
  const database = {
    jobs,
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return {
            async all<T>() {
              if (!sql.includes("FROM memory_claim_vector_jobs")) return { results: [] as T[] };
              const now = Number(values[0]);
              const limit = Number(values[2]);
              const results = [...jobs.values()]
                .filter((job) => (
                  (["pending", "failed"] as string[]).includes(job.status) && job.next_attempt_at <= now
                ) || (
                  job.status === "processing"
                  && job.lease_expires_at !== null
                  && job.lease_expires_at <= now
                ))
                .sort((left, right) => left.updated_at - right.updated_at)
                .slice(0, limit);
              return { results: results as T[] };
            },
            async first<T>() {
              if (sql.includes("FROM memory_claim_vector_jobs")) {
                const projectId = String(values[0]);
                const claimId = String(values[1]);
                const leaseToken = String(values[2]);
                const job = jobs.get(`${projectId}:${claimId}`);
                return (job?.lease_token === leaseToken ? job : null) as T | null;
              }
              if (sql.includes("FROM memory_claims")) return claim as T | null;
              return null;
            },
            async run() {
              if (sql.includes("SET status = 'processing'")) {
                const [leaseToken, leaseExpiresAt, updatedAt, projectId, claimId, firstNow, secondNow] = values;
                const job = jobs.get(`${String(projectId)}:${String(claimId)}`);
                const now = Number(firstNow);
                const canLease = Boolean(job) && (
                  ((job?.status === "pending" || job?.status === "failed") && Number(job.next_attempt_at) <= now)
                  || (job?.status === "processing" && job.lease_expires_at !== null && Number(job.lease_expires_at) <= Number(secondNow))
                );
                if (!job || !canLease) return { meta: { changes: 0 } };
                job.status = "processing";
                job.lease_token = String(leaseToken);
                job.lease_expires_at = Number(leaseExpiresAt);
                job.updated_at = Number(updatedAt);
                return { meta: { changes: 1 } };
              }

              if (sql.startsWith("DELETE FROM memory_claim_vector_jobs")) {
                const [projectId, claimId, leaseToken, revision] = values;
                const key = `${String(projectId)}:${String(claimId)}`;
                const job = jobs.get(key);
                if (job && job.status === "processing" && job.lease_token === leaseToken && job.revision === Number(revision)) {
                  jobs.delete(key);
                  return { meta: { changes: 1 } };
                }
                return { meta: { changes: 0 } };
              }

              if (sql.includes("revision != ?")) {
                const [nextAttemptAt, updatedAt, projectId, claimId, leaseToken] = values;
                const job = jobs.get(`${String(projectId)}:${String(claimId)}`);
                if (job && job.status === "processing" && job.lease_token === leaseToken && job.revision !== Number(values[5])) {
                  job.status = "pending";
                  job.lease_token = null;
                  job.lease_expires_at = null;
                  job.next_attempt_at = Number(nextAttemptAt);
                  job.updated_at = Number(updatedAt);
                  return { meta: { changes: 1 } };
                }
                return { meta: { changes: 0 } };
              }

              if (sql.includes("SET status = CASE WHEN revision")) {
                const revision = Number(values[0]);
                const message = String(values[3]);
                const nextAttemptAt = Number(values[5]);
                const updatedAt = Number(values[6]);
                const projectId = String(values[7]);
                const claimId = String(values[8]);
                const leaseToken = String(values[9]);
                const job = jobs.get(`${projectId}:${claimId}`);
                if (!job || job.status !== "processing" || job.lease_token !== leaseToken) return { meta: { changes: 0 } };
                if (job.revision === revision) {
                  job.status = "failed";
                  job.attempt_count += 1;
                  job.last_error = message;
                  job.next_attempt_at = nextAttemptAt;
                } else {
                  job.status = "pending";
                }
                job.lease_token = null;
                job.lease_expires_at = null;
                job.updated_at = updatedAt;
                return { meta: { changes: 1 } };
              }

              return { meta: { changes: 0 } };
            },
          };
        },
      };
    },
  };
  return { db: database as unknown as D1Database, jobs };
}

function createEnv(db: D1Database, index: VectorizeIndex, ai: Ai): Env {
  return {
    DB: db,
    AI: ai,
    SEGMENTS_INDEX: index,
    CLAIMS_INDEX: index,
  };
}

describe("runClaimVectorReconciliation", () => {
  it("repairs an active claim and removes its completed job", async () => {
    const claim = createClaim();
    const upsert = vi.fn(async () => undefined);
    const index = { upsert, query: vi.fn(), deleteByIds: vi.fn() } as unknown as VectorizeIndex;
    const ai = { run: vi.fn(async () => ({ data: [[0.1, 0.2]] })) } as unknown as Ai;
    const { db, jobs } = createDatabase(claim, createJob());

    await expect(runClaimVectorReconciliation(createEnv(db, index, ai))).resolves.toEqual({
      processed: 1,
      repaired: 1,
      failed: 0,
    });
    expect(upsert).toHaveBeenCalledOnce();
    expect(jobs.size).toBe(0);
  });

  it("keeps a failed job durable and retries it later", async () => {
    const claim = createClaim();
    const upsert = vi.fn()
      .mockRejectedValueOnce(new Error("vectorize unavailable"))
      .mockResolvedValueOnce(undefined);
    const index = { upsert, query: vi.fn(), deleteByIds: vi.fn() } as unknown as VectorizeIndex;
    const ai = { run: vi.fn(async () => ({ data: [[0.1, 0.2]] })) } as unknown as Ai;
    const { db, jobs } = createDatabase(claim, createJob());

    await expect(runClaimVectorReconciliation(createEnv(db, index, ai))).resolves.toEqual({
      processed: 1,
      repaired: 0,
      failed: 1,
    });
    const failedJob = jobs.get("project-1:claim-1");
    expect(failedJob?.status).toBe("failed");
    expect(failedJob?.last_error).toContain("vectorize unavailable");

    if (failedJob) failedJob.next_attempt_at = 0;
    await expect(runClaimVectorReconciliation(createEnv(db, index, ai))).resolves.toEqual({
      processed: 1,
      repaired: 1,
      failed: 0,
    });
    expect(jobs.size).toBe(0);
  });

  it("removes a vector for a non-active claim", async () => {
    const claim = createClaim("retracted");
    const deleteByIds = vi.fn(async () => undefined);
    const index = { upsert: vi.fn(), query: vi.fn(), deleteByIds } as unknown as VectorizeIndex;
    const ai = { run: vi.fn() } as unknown as Ai;
    const { db, jobs } = createDatabase(claim, createJob({ operation: "delete" }));

    await expect(runClaimVectorReconciliation(createEnv(db, index, ai))).resolves.toEqual({
      processed: 1,
      repaired: 1,
      failed: 0,
    });
    expect(deleteByIds).toHaveBeenCalledWith(["claim-1"]);
    expect(ai.run).not.toHaveBeenCalled();
    expect(jobs.size).toBe(0);
  });

  it("keeps a deletion job when Vectorize cannot delete vectors", async () => {
    const claim = createClaim("retracted");
    const index = { upsert: vi.fn(), query: vi.fn() } as unknown as VectorizeIndex;
    const ai = { run: vi.fn() } as unknown as Ai;
    const { db, jobs } = createDatabase(claim, createJob({ operation: "delete" }));

    await expect(runClaimVectorReconciliation(createEnv(db, index, ai))).resolves.toEqual({
      processed: 1,
      repaired: 0,
      failed: 1,
    });
    expect(jobs.get("project-1:claim-1")?.status).toBe("failed");
    expect(jobs.get("project-1:claim-1")?.last_error).toContain("unavailable");
  });

  it("does not complete an older revision after a newer mutation arrives", async () => {
    const claim = createClaim();
    const { db, jobs } = createDatabase(claim, createJob());
    const upsert = vi.fn(async () => {
      const job = jobs.get("project-1:claim-1");
      if (job) job.revision = 2;
    });
    const index = { upsert, query: vi.fn(), deleteByIds: vi.fn() } as unknown as VectorizeIndex;
    const ai = { run: vi.fn(async () => ({ data: [[0.1, 0.2]] })) } as unknown as Ai;

    await expect(runClaimVectorReconciliation(createEnv(db, index, ai))).resolves.toEqual({
      processed: 1,
      repaired: 1,
      failed: 0,
    });
    expect(jobs.get("project-1:claim-1")?.status).toBe("pending");
    expect(jobs.get("project-1:claim-1")?.revision).toBe(2);
  });
});
