import { fetchClaimById, type StoredClaimRow } from "../../db/d1";
import type { Env } from "../../env";
import type { ProjectScope } from "../../project";
import { ClaimDedupLockBusyError } from "../claim-dedup";
import { mutateClaim } from "../claim-store";
import { normalizeClaimMutationRequest, type ClaimCategory, type ClaimType } from "../claims";
import { isBreakerOpenError } from "../llm-breaker";
import { jobEvidenceIds } from "./evidence";
import { candidateEvidenceIds } from "./reconciler";
import {
  errorLabel,
  resolveProfileClaimScope,
  type ExtractedClaim,
  type ProfileJob,
} from "./shared";

async function applyOneClaim(
  env: Env,
  scope: ProjectScope,
  job: ProfileJob,
  extracted: ExtractedClaim,
  activeById: ReadonlyMap<string, StoredClaimRow>,
  jobEvidence: string[],
  survivingEvidenceIds: ReadonlySet<string>,
): Promise<void> {
  // Must match candidateAccepted's view: verifyEvidence rejects any id whose
  // segment was pruned by retention, and that throw is swallowed per candidate,
  // so an unfiltered id here loses an already-accepted claim silently.
  const evidenceSegmentIds = candidateEvidenceIds(extracted, job).filter((id) => survivingEvidenceIds.has(id));
  const resolvedEvidenceIds = evidenceSegmentIds.length > 0
    ? evidenceSegmentIds
    : jobEvidence.filter((id) => survivingEvidenceIds.has(id));
  if (!["create", "reinforce", "supersede", "retract"].includes(extracted.operation)) {
    throw new Error("extractor_claim_invalid_operation");
  }
  if (extracted.operation === "reinforce" || extracted.operation === "retract") {
    const claimId = extracted.claim_id;
    if (!claimId || !activeById.has(claimId)) throw new Error("extractor_claim_invalid_claim_id");
    if (extracted.category_explicit && activeById.get(claimId)?.category !== extracted.category) {
      throw new Error("extractor_claim_category_mismatch");
    }
    if (extracted.operation === "retract" && activeById.get(claimId)?.status === "retracted") {
      return;
    }
    if (activeById.get(claimId)?.status !== "active") throw new Error("extractor_claim_inactive_claim_id");
    await mutateClaim(env, scope, extracted.operation === "reinforce"
      ? {
        operation: "reinforce",
        claimId,
        evidenceSegmentIds: resolvedEvidenceIds,
        confidence: typeof extracted.confidence === "number" ? extracted.confidence : null,
      }
      : { operation: "retract", claimId });
    return;
  }

  const existing = extracted.operation === "supersede"
    ? activeById.get(extracted.replaces_claim_id ?? "")
    : undefined;
  if (existing && extracted.category_explicit && existing.category !== extracted.category) {
    throw new Error("extractor_claim_category_mismatch");
  }
  if (extracted.operation === "supersede" && (!existing || existing.status !== "active")) {
    if (!existing?.superseded_by) throw new Error("extractor_claim_invalid_replacement");
    const replacement = await fetchClaimById(env.DB, scope.projectId, existing.superseded_by);
    if (
      !replacement
      || replacement.value_json !== JSON.stringify(extracted.value)
      || replacement.canonical_text !== extracted.canonical_text
    ) {
      throw new Error("extractor_claim_conflicting_replacement");
    }
    return;
  }
  const claimType = existing?.type ?? extracted.type;
  const claimCategory: ClaimCategory = existing?.category ?? extracted.category ?? (
      claimType === "profile"
        ? "user_profile"
        : claimType === "instruction" || (claimType === "preference" && (extracted.applicability === "global" || extracted.applicability === "workspace"))
          ? "rule"
          : "domain_fact"
    );
  const applicability = extracted.applicability_explicit
    ? extracted.applicability
    : existing?.applicability
      ?? extracted.applicability
      ?? (job.workspace_id && claimCategory !== "tool_insight"
        ? "workspace"
        : claimCategory === "rule" || claimCategory === "user_profile"
          ? "global"
          : "semantic");
  const claimScope = resolveProfileClaimScope(
    existing ?? null,
    claimCategory,
    claimType as ClaimType | undefined,
    extracted.scope_id,
    job.owner_id,
    scope.projectId,
  );
  const claimWorkspaceId = applicability === "workspace"
    ? existing?.workspace_id ?? job.workspace_id
    : null;
  const mutation = normalizeClaimMutationRequest({
    operation: extracted.operation,
    claim: {
      scope_kind: claimScope.scopeKind,
      scope_id: claimScope.scopeId,
      category: claimCategory,
      type: claimType,
      subject: existing?.subject ?? extracted.subject,
      memory_key: existing?.memory_key ?? extracted.memory_key,
      value: extracted.value,
      canonical_text: extracted.canonical_text,
      // Candidates reach this point only after the extractor marked them
      // explicit, an independent verifier accepted them, and the reconciler
      // placed them against existing claims. That is a confirmation pipeline,
      // not a direct user statement — and not a bare model inference either.
      provenance: "user_confirmed",
      confidence: extracted.confidence,
      valid_until: extracted.valid_until,
      applicability,
      workspace_id: claimWorkspaceId,
      evidence_segment_ids: resolvedEvidenceIds,
    },
  }, scope);
  await mutateClaim(env, scope, mutation);
}

/**
 * Failures are isolated per candidate: one malformed claim used to abort the
 * whole loop, leaving earlier claims written, the job marked failed, and every
 * retry re-hitting the same bad candidate until the job was declared dead.
 */
export async function applyExtractedClaims(
  env: Env,
  scope: ProjectScope,
  job: ProfileJob,
  output: ExtractedClaim[],
  activeClaims: StoredClaimRow[],
  survivingEvidenceIds: ReadonlySet<string>,
): Promise<{ applied: number; failures: string[] }> {
  const activeById = new Map(activeClaims.map((claim) => [claim.id, claim]));
  const jobEvidence = jobEvidenceIds(job);
  const failures: string[] = [];
  let applied = 0;

  for (const [index, extracted] of output.entries()) {
    try {
      await applyOneClaim(env, scope, job, extracted, activeById, jobEvidence, survivingEvidenceIds);
      applied += 1;
    } catch (error) {
      if (isBreakerOpenError(error)) throw error;
      if (error instanceof ClaimDedupLockBusyError) throw error;
      const label = `candidate_${index}:${errorLabel(error)}`;
      failures.push(label);
      console.error(`[profile] job=${job.id} failed to apply ${label}`);
    }
  }

  return { applied, failures };
}
