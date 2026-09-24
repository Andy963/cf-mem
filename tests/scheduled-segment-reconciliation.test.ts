import type { ExecutionContext, ScheduledEvent } from "@cloudflare/workers-types";
import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import worker from "../src/index";
import { runRetentionSweep } from "../src/memory/retention";
import { runSegmentVectorReconciliation } from "../src/memory/segment-reconciliation";

vi.mock("../src/memory/nudge", () => ({ runNudgeExtractionScan: vi.fn(async () => undefined) }));
vi.mock("../src/memory/profile", () => ({ flushReadyEvidenceGroups: vi.fn(async () => undefined), processProfileJobs: vi.fn(async () => undefined) }));
vi.mock("../src/memory/retention", () => ({ runRetentionSweep: vi.fn(async () => undefined) }));
vi.mock("../src/memory/claim-reconciliation", () => ({ runClaimVectorReconciliation: vi.fn(async () => undefined) }));
vi.mock("../src/memory/segment-reconciliation", () => ({ runSegmentVectorReconciliation: vi.fn(async () => undefined) }));

describe("scheduled segment reconciliation", () => {
  it("continues after retention failure", async () => {
    vi.mocked(runRetentionSweep).mockRejectedValueOnce(new Error("retention unavailable"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    let work: Promise<unknown> | undefined;
    const context = { waitUntil: vi.fn((value: Promise<unknown>) => { work = value; }) } as unknown as ExecutionContext;

    await worker.scheduled({} as ScheduledEvent, {} as Env, context);
    await work;

    expect(runSegmentVectorReconciliation).toHaveBeenCalledOnce();
  });
});
