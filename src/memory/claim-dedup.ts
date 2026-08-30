import { embedTexts } from "../ai/embedding";
import {
  fetchActiveClaimsBySemanticScope,
  type StoredClaimRow,
} from "../db/d1";
import type { Env } from "../env";
import type { ProjectScope } from "../project";
import { readBoolEnv } from "../utils";
import { cosineSimilarity, findVectorizedClaimMatches } from "./claim-index";
import { type ClaimInput, ClaimSchemaError } from "./claims";
import { isBreakerOpenError, withBreaker } from "./llm-breaker";

// Deterministic identity keys (see fetchActiveClaimByIdentity) only catch claims
// written with byte-identical subject/memory_key/value/canonical_text. Extraction
// pipelines feed this worker LLM output, so the same fact routinely arrives
// re-phrased and lands as either a spurious conflict error or a second active
// claim. This module adds a semantic pass: vector search narrows candidates,
// cosine thresholds make the cheap decisions, and ambiguous pairs go to the
// configured extractor LLM for a three-way verdict.

const DEFAULT_SAME_SCORE = 0.92;
const DEFAULT_REVIEW_MIN_SCORE = 0.75;
const RULE_TOOL_SUPERSEDE_MIN_SCORE = 0.85;
const DEFAULT_TOP_K = 12;

const DEDUP_LLM_TIMEOUT_MS = 15_000;
const DEDUP_LOCK_TTL_MS = 120_000;
const DEDUP_LOCK_WAIT_MS = 30_000;
const DEDUP_LOCK_POLL_MS = 100;
const DEDUP_EMBEDDING_BATCH_SIZE = 32;

type ExtractorProtocol = "chat_completions" | "responses";

export interface DedupConfig {
  sameScore: number;
  reviewMinScore: number;
  topK: number;
  llmEnabled: boolean;
  autoReplace: boolean;
}

export interface DedupMeta {
  provider: "identity" | "vector" | "llm";
  matched_claim_id: string | null;
  score: number | null;
  verdict: "same" | "update" | "conflict" | null;
}

export type Verdict = "same" | "update" | "conflict";

export type SemanticAction =
  | { kind: "insert"; meta: DedupMeta }
  | { kind: "reinforce"; match: StoredClaimRow; meta: DedupMeta }
  | { kind: "replace"; match: StoredClaimRow; meta: DedupMeta };

function extractorProtocol(env: Env): ExtractorProtocol | null {
  const protocol = env.PROFILE_EXTRACTOR_PROTOCOL?.trim() || "chat_completions";
  return protocol === "chat_completions" || protocol === "responses" ? protocol : null;
}

export function readDedupConfig(env: Env): DedupConfig {
  const parseScore = (raw: string | undefined, fallback: number) => {
    const normalized = raw?.trim();
    if (!normalized) return fallback;
    const value = Number(normalized);
    return Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback;
  };
  const rawTopK = Number(env.CLAIM_DEDUP_TOP_K?.trim() ?? "");
  const sameScore = parseScore(env.CLAIM_DEDUP_SAME_SCORE, DEFAULT_SAME_SCORE);
  // Keep the review floor below the same threshold even when operators provide
  // the values in the wrong order.
  const reviewMinScore = Math.min(
    parseScore(env.CLAIM_DEDUP_REVIEW_MIN_SCORE, DEFAULT_REVIEW_MIN_SCORE),
    sameScore,
  );
  const protocol = extractorProtocol(env);
  return {
    sameScore,
    reviewMinScore,
    topK: Number.isFinite(rawTopK) && rawTopK >= 1 ? Math.min(Math.trunc(rawTopK), 50) : DEFAULT_TOP_K,
    llmEnabled:
      readBoolEnv(env.CLAIM_DEDUP_LLM_ENABLED, true) &&
      protocol !== null &&
      Boolean(env.EXTRACTOR_LLM_API_BASE?.trim()) &&
      Boolean(env.EXTRACTOR_LLM_API_KEY?.trim()) &&
      Boolean(env.EXTRACTOR_LLM_MODEL?.trim()),
    // Off by default: auto-superseding an active claim silently rewrites
    // remembered history. Opt in only when the feeding pipeline is trusted to
    // judge "newer state" correctly.
    autoReplace: readBoolEnv(env.CLAIM_DEDUP_AUTO_REPLACE, false),
  };
}

interface SemanticMatch {
  claim: StoredClaimRow;
  score: number;
}

async function findNearestSemanticMatch(
  env: Env,
  db: D1Database,
  projectId: string,
  claim: ClaimInput,
  config: DedupConfig,
): Promise<SemanticMatch | null> {
  if (!env.CLAIMS_INDEX || !claim.canonicalText.trim()) return null;
  const [incomingVector] = await embedTexts(env, [claim.canonicalText]);
  if (!incomingVector || incomingVector.length === 0) return null;

  const matches = await findVectorizedClaimMatches(env, {
    projectId,
    vector: incomingVector,
    topK: config.topK,
    filter: {
      status: "active",
      scope_kind: claim.scopeKind,
      scope_id: claim.scopeId,
      category: claim.category,
      type: claim.type,
      workspace_id: claim.workspaceId ?? "",
    },
  });
  const now = Date.now();
  const candidates = await fetchActiveClaimsBySemanticScope(db, projectId, claim, now);
  if (candidates.length === 0) return null;

  const candidateIds = new Set(candidates.map((candidate) => candidate.id));
  const usableMatches = matches.filter((match) => candidateIds.has(match.id));
  let best: SemanticMatch | null = null;

  const candidatesById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  for (const match of usableMatches) {
    const row = candidatesById.get(match.id);
    if (!row) continue;
    if (!best || match.score > best.score) best = { claim: row, score: match.score };
  }

  // Vectorize writes are durable before they become query-visible. Compare
  // D1 rows that are not visible in Vectorize yet so a just-created claim
  // cannot race into a semantic duplicate.
  const vectorizedIds = new Set(usableMatches.map((match) => match.id));
  const pendingCandidates = candidates.filter((candidate) => !vectorizedIds.has(candidate.id));
  if (pendingCandidates.length > 0) {
    for (const batchStart of Array.from(
      { length: Math.ceil(pendingCandidates.length / DEDUP_EMBEDDING_BATCH_SIZE) },
      (_, index) => index * DEDUP_EMBEDDING_BATCH_SIZE,
    )) {
      const batch = pendingCandidates.slice(batchStart, batchStart + DEDUP_EMBEDDING_BATCH_SIZE);
      const vectors = await embedTexts(env, batch.map((candidate) => candidate.canonical_text));
      if (vectors.length !== batch.length) {
        throw new Error(`Claim dedup embedding count mismatch. expected=${batch.length} actual=${vectors.length}`);
      }
      for (const [index, candidateVector] of vectors.entries()) {
        const incomingScore = cosineSimilarity(incomingVector, candidateVector);
        if (incomingScore === null) continue;
        const candidate = batch[index];
        if (!best || incomingScore > best.score) best = { claim: candidate, score: incomingScore };
      }
    }
  }
  return best;
}

function verdictExtraction(content: unknown): Verdict {
  const text = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
        .map((part) => part !== null && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
          ? (part as { text: string }).text
          : "")
        .join("")
      : "";
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error(`claim_dedup_llm_missing_verdict:${text.slice(0, 200)}`);
  }
  let parsed: { verdict?: unknown };
  try {
    parsed = JSON.parse(text.slice(start, end + 1)) as { verdict?: unknown };
  } catch {
    throw new Error(`claim_dedup_llm_invalid_json:${text.slice(0, 200)}`);
  }
  if (parsed.verdict === "same" || parsed.verdict === "update" || parsed.verdict === "conflict") {
    return parsed.verdict;
  }
  throw new Error(`claim_dedup_llm_bad_verdict:${text.slice(0, 200)}`);
}

// Returns null when the judge is not configured; throws on transport or parse
// failures so each call site can pick its own fallback (fail closed vs degrade).
export async function judgeClaimPair(
  env: Env,
  existing: StoredClaimRow,
  incoming: ClaimInput,
): Promise<Verdict | null> {
  const config = readDedupConfig(env);
  if (!config.llmEnabled) return null;

  const protocol = extractorProtocol(env);
  if (!protocol) return null;
  const endpoint = (env.EXTRACTOR_LLM_API_BASE?.trim() || "").replace(/\/+$/, "");
  const endpointSuffix = protocol === "responses" ? "/responses" : "/chat/completions";
  const url = endpoint.endsWith(endpointSuffix) ? endpoint : `${endpoint}${endpointSuffix}`;
  const systemPrompt = [
    "You arbitrate whether two memory claims state the same fact.",
    'Answer with JSON only: {"verdict": "same" | "update" | "conflict"}',
    "Rules:",
    "- same: identical meaning despite paraphrasing, translation, formatting, or unit-normalization differences.",
    "- update: same attribute/fact about the same entity, but the incoming claim reflects a changed, newer state.",
    "- conflict: mutually exclusive statements that ordering in time cannot reconcile.",
  ].join("\n");
  const input = [
    "Existing claim:",
    `- category: ${existing.category}`,
    `- type: ${existing.type}`,
    `- canonical_text: ${existing.canonical_text}`,
    `- value: ${existing.value_json}`,
    "",
    "Incoming claim:",
    `- category: ${incoming.category}`,
    `- type: ${incoming.type}`,
    `- canonical_text: ${incoming.canonicalText}`,
    `- value: ${JSON.stringify(incoming.value) ?? "null"}`,
  ].join("\n");

  return withBreaker(env, async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEDUP_LLM_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${env.EXTRACTOR_LLM_API_KEY?.trim() ?? ""}`,
        },
        body: JSON.stringify(
          protocol === "responses"
            ? {
              model: env.EXTRACTOR_LLM_MODEL?.trim(),
              instructions: systemPrompt,
              input: `${input}\n\nReturn JSON only.`,
              text: { format: { type: "json_object" } },
              max_output_tokens: 200,
            }
            : {
              model: env.EXTRACTOR_LLM_MODEL?.trim(),
              temperature: 0,
              max_tokens: 200,
              messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: input },
              ],
            },
        ),
        signal: controller.signal,
      });
      if (!response.ok) {
        const errText = await response.text().catch(() => "");
        throw new Error(`claim_dedup_llm_http_${response.status}:${errText.slice(0, 300)}`);
      }
      const payload = await response.json() as {
        choices?: Array<{ message?: { content?: unknown } }>;
        output?: Array<{ content?: Array<{ type?: unknown; text?: unknown }> }>;
      };
      const content = protocol === "responses"
        ? payload.output?.flatMap((item) => item.content ?? [])
          .find((item) => item.type === "output_text")?.text
        : payload.choices?.[0]?.message?.content;
      return verdictExtraction(content);
    } finally {
      clearTimeout(timeout);
    }
  });
}

// Decides what to do with an incoming claim that has no deterministic identity
// twin. Throws ClaimSchemaError only for judged conflicts (deliberate hard stop
// so pipelines surface real contradictions instead of silent divergence).
export async function resolveSemanticDuplicate(
  env: Env,
  db: D1Database,
  projectId: string,
  claim: ClaimInput,
  config: DedupConfig,
): Promise<SemanticAction> {
  const insertMeta = (matched: SemanticMatch | null, verdict: DedupMeta["verdict"], provider: DedupMeta["provider"] = "vector"): DedupMeta =>
    ({ provider, matched_claim_id: matched?.claim.id ?? null, score: matched?.score ?? null, verdict });

  const match = await findNearestSemanticMatch(env, db, projectId, claim, config);
  if (!match) return { kind: "insert", meta: insertMeta(null, null) };

  const isRuleOrTool = claim.category === "rule" || claim.category === "tool_insight";
  const sameValue = match.claim.value_json === JSON.stringify(claim.value)
    && match.claim.canonical_text === claim.canonicalText;
  if (match.score >= config.sameScore && (!isRuleOrTool || sameValue)) {
    return { kind: "reinforce", match: match.claim, meta: { provider: "vector", matched_claim_id: match.claim.id, score: match.score, verdict: "same" } };
  }
  if (match.score < config.reviewMinScore) {
    return { kind: "insert", meta: insertMeta(match, null) };
  }

  // Gray zone: close enough that plain insertion invites duplicates, too far
  // apart to trust the threshold alone. Rule and tool claims fail closed when
  // the judge is unavailable because an unjudged active rule can conflict with
  // an existing one. Other categories retain the historical insertion fallback.
  let verdict: Verdict;
  try {
    const judged = await judgeClaimPair(env, match.claim, claim);
    if (!judged) {
      if (isRuleOrTool) {
        throw new ClaimSchemaError(
          `Semantic judge unavailable (score=${match.score.toFixed(3)}, claim_id=${match.claim.id}): rule and tool_insight claims are not written without a verdict`,
        );
      }
      return { kind: "insert", meta: insertMeta(match, null) };
    }
    verdict = judged;
  } catch (error) {
    if (isBreakerOpenError(error)) throw error;
    if (isRuleOrTool) {
      console.error(`[claims] dedup judge unavailable, rejecting rule/tool claim (score=${match.score.toFixed(3)}, existing=${match.claim.id}): ${error instanceof Error ? error.message : String(error)}`);
      throw Object.assign(
        new ClaimSchemaError(
          `Semantic judge unavailable (score=${match.score.toFixed(3)}, claim_id=${match.claim.id}): rule and tool_insight claims are not written without a verdict`,
        ),
        { dedup: { score: match.score, matched_claim_id: match.claim.id } },
      );
    }
    console.error(`[claims] dedup judge unavailable, inserting unmerged claim (score=${match.score.toFixed(3)}, existing=${match.claim.id}): ${error instanceof Error ? error.message : String(error)}`);
    return { kind: "insert", meta: insertMeta(match, null) };
  }

  if (verdict === "same") {
    return { kind: "reinforce", match: match.claim, meta: { provider: "llm", matched_claim_id: match.claim.id, score: match.score, verdict } };
  }
  if (verdict === "update") {
    // Auto-replace is gated because it silently rewrites history: an extraction
    // hiccup could supersede a user-confirmed fact with a weaker inference,
    // but rules and tool_insights follow semantic superseding by design.
    if (isRuleOrTool && match.score <= RULE_TOOL_SUPERSEDE_MIN_SCORE) {
      throw Object.assign(
        new ClaimSchemaError(
          `Semantic update detected (score=${match.score.toFixed(3)}, claim_id=${match.claim.id}): rule and tool_insight superseding requires cosine similarity > ${RULE_TOOL_SUPERSEDE_MIN_SCORE}; use the supersede operation explicitly`,
        ),
        { dedup: { score: match.score, matched_claim_id: match.claim.id } },
      );
    }
    if (!config.autoReplace && !isRuleOrTool) {
      throw Object.assign(
        new ClaimSchemaError(
          `Semantic update detected (score=${match.score.toFixed(3)}, claim_id=${match.claim.id}): the LLM judged the incoming claim a newer state; automatic replacement is disabled, so use the supersede operation`,
        ),
        { dedup: { score: match.score, matched_claim_id: match.claim.id } },
      );
    }
    return { kind: "replace", match: match.claim, meta: { provider: "llm", matched_claim_id: match.claim.id, score: match.score, verdict } };
  }
  if (isRuleOrTool) {
    if (match.score <= RULE_TOOL_SUPERSEDE_MIN_SCORE) {
      throw Object.assign(
        new ClaimSchemaError(
          `Semantic conflict detected (score=${match.score.toFixed(3)}, claim_id=${match.claim.id}): rule and tool_insight superseding requires cosine similarity > ${RULE_TOOL_SUPERSEDE_MIN_SCORE}; use the supersede operation explicitly`,
        ),
        { dedup: { score: match.score, matched_claim_id: match.claim.id } },
      );
    }
    return { kind: "replace", match: match.claim, meta: { provider: "llm", matched_claim_id: match.claim.id, score: match.score, verdict } };
  }
  throw Object.assign(
    new ClaimSchemaError(
      `Semantic duplicate detected (score=${match.score.toFixed(3)}, claim_id=${match.claim.id}): values differ and the LLM judged them conflicting; use reinforce, supersede, or retract`,
    ),
    { dedup: { score: match.score, matched_claim_id: match.claim.id } },
  );
}

function dedupLockKey(claim: Pick<ClaimInput, "scopeKind" | "scopeId" | "type" | "workspaceId">): string[] {
  return [claim.scopeKind, claim.scopeId, claim.type, claim.workspaceId ?? ""];
}

async function tryAcquireDedupLock(
  db: D1Database,
  projectId: string,
  claim: Pick<ClaimInput, "scopeKind" | "scopeId" | "type" | "workspaceId">,
  token: string,
  now: number,
): Promise<boolean> {
  const [scopeKind, scopeId, type, workspaceId] = dedupLockKey(claim);
  const inserted = await db.prepare(
    "INSERT OR IGNORE INTO memory_claim_dedup_locks (project_id, scope_kind, scope_id, type, workspace_id, lock_token, lock_until) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).bind(projectId, scopeKind, scopeId, type, workspaceId, token, now + DEDUP_LOCK_TTL_MS).run();
  if (inserted.meta.changes > 0) return true;

  const renewed = await db.prepare(
    "UPDATE memory_claim_dedup_locks SET lock_token = ?, lock_until = ? WHERE project_id = ? AND scope_kind = ? AND scope_id = ? AND type = ? AND workspace_id = ? AND lock_until <= ?",
  ).bind(token, now + DEDUP_LOCK_TTL_MS, projectId, scopeKind, scopeId, type, workspaceId, now).run();
  return renewed.meta.changes > 0;
}

export async function withClaimDedupLock<T>(
  db: D1Database,
  projectId: string,
  claim: Pick<ClaimInput, "scopeKind" | "scopeId" | "type" | "workspaceId">,
  callback: () => Promise<T>,
): Promise<T> {
  const token = crypto.randomUUID();
  const deadline = Date.now() + DEDUP_LOCK_WAIT_MS;
  let acquired = false;
  while (Date.now() <= deadline) {
    if (await tryAcquireDedupLock(db, projectId, claim, token, Date.now())) {
      acquired = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, DEDUP_LOCK_POLL_MS));
  }
  if (!acquired) throw new Error("claim_dedup_lock_timeout");

  const [scopeKind, scopeId, type, workspaceId] = dedupLockKey(claim);
  try {
    return await callback();
  } finally {
    try {
      await db.prepare(
        "DELETE FROM memory_claim_dedup_locks WHERE project_id = ? AND scope_kind = ? AND scope_id = ? AND type = ? AND workspace_id = ? AND lock_token = ?",
      ).bind(projectId, scopeKind, scopeId, type, workspaceId, token).run();
    } catch (error) {
      console.error(`[claims] failed to release semantic dedup lock: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
