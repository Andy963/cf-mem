import type { StoredMemoryRow } from "../schema";
import { WEB_REFERENCE_KIND } from "../web-reference";
import { truncateText } from "../../utils";
import {
  MAX_ASSISTANT_EVIDENCE_CHARS,
  MAX_EVIDENCE_CHARS,
  MAX_WEB_REFERENCE_EVIDENCE_CHARS,
  type ProfileJob,
} from "./shared";

export function jobEvidenceIds(job: ProfileJob): string[] {
  if (job.evidence_segment_ids_json) {
    try {
      const parsed = JSON.parse(job.evidence_segment_ids_json);
      if (Array.isArray(parsed)) {
        const ids = [...new Set(parsed.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim()))];
        if (ids.length > 0) return ids;
      }
    } catch {
      // Old jobs fall back to their single evidence id.
    }
  }
  return [job.evidence_segment_id];
}

function roleOriginatedText(text: string, role: "user" | "assistant"): string {
  const roleMarker = "\\[[^\\]\\r\\n]+\\]";
  const matches = [...text.matchAll(new RegExp(`(?:^|\\n)[ \\t]*\\[${role}\\][ \\t]*([\\s\\S]*?)(?=\\n[ \\t]*${roleMarker}[ \\t]*|$)`, "gi"))];
  return matches.map((match) => match[1].trim()).filter(Boolean).join("\n");
}

/**
 * Assistant replies are the main source of project facts, but they are the
 * assistant's own words. They are surfaced to the extractor under a separate
 * `kind` so it can apply the weaker evidentiary bar the prompt describes.
 */
export function assistantOriginatedText(text: string): string {
  return roleOriginatedText(text, "assistant");
}

export function userOriginatedText(text: string): string {
  // Treat every line-start bracket marker as a role boundary. Restricting the
  // list to known roles lets an unknown role (for example, [developer]) leak
  // its payload into the user evidence fallback.
  const roleMarker = "\\[[^\\]\\r\\n]+\\]";
  const matches = [...text.matchAll(new RegExp(`(?:^|\\n)[ \\t]*\\[user\\][ \\t]*([\\s\\S]*?)(?=\\n[ \\t]*${roleMarker}[ \\t]*|$)`, "gi"))];
  if (matches.length > 0) {
    return matches.map((match) => match[1].trim()).filter(Boolean).join("\n");
  }

  // Plain /memory/index rows have no role marker and are already classified as
  // user evidence by their metadata. Keep the full text in that case, but do
  // not treat a marked non-user conversation as user speech.
  if (!new RegExp(`(?:^|\\n)[ \\t]*${roleMarker}[ \\t]*`, "im").test(text)) {
    return text.trim();
  }
  return "";
}

function segmentMetadata(row: unknown): Record<string, unknown> {
  const raw = (row as { metadata_json?: unknown } | undefined)?.metadata_json;
  if (typeof raw !== "string") return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function extractWorkspaceNameFromEvidence(evidence: Map<string, StoredMemoryRow>): string | null {
  for (const row of evidence.values()) {
    const meta = segmentMetadata(row);
    if (typeof meta.workspace_name === "string" && meta.workspace_name.trim()) {
      return meta.workspace_name.trim();
    }
  }
  return null;
}

export function isWebReferenceRow(row: unknown): boolean {
  return segmentMetadata(row).kind === WEB_REFERENCE_KIND;
}

export function webReferenceIdsIn(rows: ReadonlyMap<string, unknown>, evidenceIds: string[]): Set<string> {
  return new Set(evidenceIds.filter((id) => isWebReferenceRow(rows.get(id))));
}

export function hasConversationEvidence(rows: ReadonlyMap<string, unknown>, evidenceIds: string[]): boolean {
  return evidenceIds.some((id) => {
    if (isWebReferenceRow(rows.get(id))) return false;
    const row = rows.get(id) as { text?: unknown } | undefined;
    if (typeof row?.text !== "string") return false;
    return Boolean(userOriginatedText(row.text)) || Boolean(assistantOriginatedText(row.text));
  });
}

/** Segments whose only conversational content is the assistant's own words. */
export function assistantOnlyEvidenceIds(rows: ReadonlyMap<string, unknown>, evidenceIds: string[]): Set<string> {
  return new Set(evidenceIds.filter((id) => {
    const row = rows.get(id) as { text?: unknown } | undefined;
    if (typeof row?.text !== "string") return false;
    return Boolean(assistantOriginatedText(row.text)) && !userOriginatedText(row.text);
  }));
}

/**
 * Fetched pages get their own character budget and their own `kind`, so a long
 * article can neither crowd out the user's own words nor be mistaken for them.
 * User evidence always comes first; references are appended as context.
 */
export function boundedEvidenceText(rows: ReadonlyMap<string, unknown>, evidenceIds: string[]): string {
  let userRemaining = MAX_EVIDENCE_CHARS;
  let referenceRemaining = MAX_WEB_REFERENCE_EVIDENCE_CHARS;
  let assistantRemaining = MAX_ASSISTANT_EVIDENCE_CHARS;
  const evidence: Array<Record<string, unknown>> = [];
  const assistantEvidence: Array<Record<string, unknown>> = [];
  const references: Array<Record<string, unknown>> = [];
  for (const id of evidenceIds) {
    const row = rows.get(id) as { text?: unknown } | undefined;
    if (!row || typeof row.text !== "string" || !row.text) continue;

    if (isWebReferenceRow(row)) {
      if (referenceRemaining <= 0) continue;
      const text = truncateText(row.text, referenceRemaining);
      if (!text) continue;
      references.push({ id, kind: WEB_REFERENCE_KIND, source_url: segmentMetadata(row).source_url ?? null, text });
      referenceRemaining -= text.length;
      continue;
    }

    const userText = userRemaining > 0 ? truncateText(userOriginatedText(row.text), userRemaining) : "";
    if (userText) {
      evidence.push({ id, kind: "user", text: userText });
      userRemaining -= userText.length;
    }

    const assistantText = assistantRemaining > 0 ? truncateText(assistantOriginatedText(row.text), assistantRemaining) : "";
    if (assistantText) {
      assistantEvidence.push({ id, kind: "assistant", text: assistantText });
      assistantRemaining -= assistantText.length;
    }
  }
  // User speech first: it anchors every rule and profile candidate, and the
  // prompt forbids those from resting on assistant text alone.
  const boundedEvidence = [...evidence, ...assistantEvidence, ...references];
  return boundedEvidence.length > 0 ? JSON.stringify(boundedEvidence) : "";
}
