#!/usr/bin/env bash
set -euo pipefail

database="cf-text"
apply_changes=false

usage() {
  cat <<'EOF'
Usage: scripts/remediate-system-scaffolding.sh [--database NAME] [--apply]

Without --apply, report active rule claims whose evidence contains known agent
system scaffolding. With --apply, retract those claims. The existing D1 trigger
will enqueue Vectorize deletion jobs; the Worker cron reconciler removes the
corresponding vectors.
EOF
}

while (($# > 0)); do
  case "$1" in
    --database)
      if (($# < 2)); then
        usage >&2
        exit 2
      fi
      database="$2"
      shift 2
      ;;
    --apply)
      apply_changes=true
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
done

scaffolding_predicate="c.status = 'active' AND c.category = 'rule' AND EXISTS (
  SELECT 1
  FROM memory_evidence AS e
  JOIN memory_segments AS s ON s.project_id = e.project_id AND s.id = e.segment_id
  WHERE e.project_id = c.project_id
    AND e.claim_id = c.id
    AND (
      LOWER(s.text) LIKE '%<instructions%'
      OR LOWER(s.text) LIKE '%<system-reminder%'
      OR LOWER(s.text) LIKE '%<system_prompt%'
      OR LOWER(s.text) LIKE '%<skill_system%'
      OR LOWER(s.text) LIKE '%<available_skills%'
      OR LOWER(s.text) LIKE '%<requested_skills%'
      OR LOWER(s.text) LIKE '%<skills_instructions%'
      OR LOWER(s.text) LIKE '%<tools_instructions%'
      OR LOWER(s.text) LIKE '%<recalled_memory%'
      OR LOWER(s.text) LIKE '%# agents.md instructions%'
      OR LOWER(s.text) LIKE '%you are % (id:%'
    )
)"

query="SELECT COUNT(*) AS candidate_count FROM memory_claims AS c WHERE ${scaffolding_predicate};"
echo "Scanning ${database} for active rule claims backed by system scaffolding evidence..."
./node_modules/.bin/wrangler d1 execute "$database" --remote --command "$query"

if [[ "$apply_changes" != true ]]; then
  echo "Preview only. Re-run with --apply after reviewing the candidate count."
  exit 0
fi

read -r -p "Retract all matched claims in ${database}? Type APPLY to continue: " confirmation
if [[ "$confirmation" != "APPLY" ]]; then
  echo "Aborted. No claims were changed."
  exit 0
fi

update="UPDATE memory_claims AS c
SET status = 'retracted',
    valid_until = COALESCE(valid_until, unixepoch('now') * 1000),
    updated_at = unixepoch('now') * 1000
WHERE ${scaffolding_predicate};"
./node_modules/.bin/wrangler d1 execute "$database" --remote --command "$update" --yes
echo "Matched claims were retracted. Vectorize cleanup is queued by the D1 trigger for the next reconciliation tick."
