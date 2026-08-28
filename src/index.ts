import { handleEmbeddingRequest, isEmbeddingPath } from "./api/embedding";
import { handleAdminRequest } from "./admin";
import { handleMemoryRequest } from "./api/memory";
import { handleWebRequest, isWebPath } from "./api/web";
import { RequestAuthError, resolveProjectScope } from "./auth";
import { corsHeaders, isAuthorized, jsonResponse, textResponse, unauthorizedResponse } from "./api/http";
import type { Env } from "./env";
import { runRetentionSweep } from "./memory/retention";
import { flushReadyEvidenceGroups, processProfileJobs } from "./memory/profile";
import { runNudgeExtractionScan } from "./memory/nudge";

// Each job runs up to three sequential extractor calls with a 60s timeout each,
// so three jobs is ~9 minutes worst case — within the waitUntil budget, while
// lifting throughput from 12 to 36 jobs/hour at the current 5-minute cron.
const PROFILE_JOBS_PER_TICK = 10;

function getRequiredApiToken(env: Pick<Env, "API_TOKEN">): string | null {
  const token = env.API_TOKEN?.trim();
  return token ? token : null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const method = request.method.toUpperCase();
    const url = new URL(request.url);

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }

    if (url.pathname === "/admin" || url.pathname === "/admin/" || url.pathname.startsWith("/admin/api/")) {
      return await handleAdminRequest(request, env);
    }

    if (isEmbeddingPath(url.pathname) || isWebPath(url.pathname)) {
      const apiToken = getRequiredApiToken(env);
      if (!apiToken) {
        return jsonResponse(env, { error: { message: "API_TOKEN is required" } }, { status: 500 });
      }
      if (!isAuthorized(request, apiToken)) {
        return unauthorizedResponse(env, "cf-mem");
      }

      return isWebPath(url.pathname)
        ? await handleWebRequest(request, env)
        : await handleEmbeddingRequest(request, env);
    }

    if (url.pathname.startsWith("/memory/")) {
      try {
        const projectScope = resolveProjectScope(request, env);
        return await handleMemoryRequest(request, env, projectScope);
      } catch (error) {
        if (error instanceof RequestAuthError) {
          if (error.status === 401) {
            return unauthorizedResponse(env, "cf-mem-memory");
          }

          // Server-side auth errors describe the deployment's secrets, so the
          // detail goes to the log and the caller gets a generic message.
          console.error(`[auth] ${error.message}`);
          return jsonResponse(env, { error: { message: "Memory authentication is misconfigured" } }, { status: error.status });
        }

        throw error;
      }
    }

    if (method !== "GET" && method !== "POST") {
      return textResponse(env, "Method Not Allowed", { status: 405 });
    }

    return textResponse(env, "Not Found", { status: 404 });
  },
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      // Flush runs before processing so evidence that just became ready can be
      // picked up in the same tick rather than waiting a full cron interval.
      // Nudge scan first: unextracted segments become extraction jobs so
      // the same flush/process cycle handles them this tick.
      runNudgeExtractionScan(env).catch((error) => {
        console.error(`[cron] nudge scan failed: ${error instanceof Error ? error.message : String(error)}`);
      }).then(() => flushReadyEvidenceGroups(env))
        .catch((error) => {
          console.error(`[cron] evidence_flush failed: ${error instanceof Error ? error.message : String(error)}`);
        })
        .then(() => Promise.allSettled([runRetentionSweep(env), processProfileJobs(env, PROFILE_JOBS_PER_TICK)]))
        .then((results) => {
          for (const [index, result] of results.entries()) {
            if (result.status === "rejected") {
              const task = index === 0 ? "retention_sweep" : "profile_jobs";
              console.error(`[cron] ${task} failed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
            }
          }
        }),
    );
  },
};
