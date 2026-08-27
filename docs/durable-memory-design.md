# Durable Memory Design

## Goal

Extend `cf-rag` from a raw-segment RAG backend into a durable memory backend without
losing the original evidence that supports each memory.

The system must distinguish between:

1. **Evidence**: immutable source text in `memory_segments`.
2. **Claims**: structured, versioned memory derived from evidence.
3. **Context**: the small set of active claims and evidence returned to an agent.

This design is intentionally generic. It models user preferences, instructions,
decisions, profile facts, and task state without encoding any product-domain rules.

## Non-goals

- Replacing `memory_segments` or deleting source conversation data.
- Treating model inference as a confirmed user preference.
- Letting vector similarity decide which of two conflicting current preferences is valid.
- Making completion or tool-execution verification a responsibility of memory retrieval.

## Current State

`memory_segments` stores raw text in D1 and its embedding in Vectorize. Durable claims
are stored in `memory_claims` with evidence links in `memory_evidence`; `/memory/index`
deduplicates identical content for an id, while `/memory/search` performs vector
retrieval with an optional reranker. `/memory/claims` supports deterministic identity
checks plus scope-local semantic deduplication backed by a dedicated Vectorize index.

## Target Data Model

### `memory_segments`

Remains the evidence store. Existing indexing and retrieval behavior stays compatible.

### `memory_claims`

One row is one version of a durable statement.

| Field | Purpose |
| --- | --- |
| `id` | Stable claim identifier |
| `project_id` | Mandatory isolation key |
| `scope_kind`, `scope_id` | Ownership scope: `project`, `user`, or `session` |
| `type` | `preference`, `instruction`, `decision`, `profile`, or `task_state` |
| `subject`, `memory_key` | Canonical identity used for consolidation |
| `value_json`, `canonical_text` | Machine-readable value and agent-readable text |
| `status` | `active`, `superseded`, `retracted`, or `proposed` |
| `provenance` | `user_explicit`, `user_confirmed`, or `model_inferred` |
| `confidence` | Number in `[0, 1]` |
| `superseded_by` | The replacement claim, when applicable |
| validity and timestamps | Temporal auditability |

### `memory_evidence`

Links a claim to raw `memory_segments`. Relations are `supports` and `contradicts`.
Claim-to-claim replacement is represented by `memory_claims.superseded_by`. An
evidence link is always project-scoped.

## Claim Safety Rules

1. A claim can only reference segments in the authenticated project.
2. `user_explicit` and `user_confirmed` claims require at least one supporting
   source segment.
3. `model_inferred` claims must be created as `proposed`; they are never returned as
   active user memory until explicitly confirmed.
4. A key has at most one active claim in a given project, scope, type, subject, and
   `memory_key`.
5. A replacement creates a new claim and marks the old active claim as
   `superseded`; historical claims are never overwritten.
6. A retraction changes status to `retracted` and retains its evidence trail.
7. Semantic deduplication only compares active, currently valid claims with the same
   project, scope, type, and workspace. Vectorize results are narrowed by metadata
   filters, while D1 remains the final authority for status and validity.
8. During Vectorize's eventual-consistency window, claims missing from the vector
   result are re-embedded from D1 before a create decision is made.
9. The semantic read/decide/write sequence is guarded by a short D1 lease lock to
   prevent concurrent requests from inserting the same semantic claim.

## API Contract

The existing endpoints remain unchanged.

### `POST /memory/claims`

Creates or mutates structured claims. Supported operations:

- `create`: creates the first active claim for a canonical key.
- `reinforce`: adds supporting evidence and raises confidence on the existing active
  claim, without changing its value.
- `supersede`: creates a replacement claim and supersedes the active claim(s) for the
  same canonical key.
- `retract`: marks a specified active claim as retracted.

All mutations are validated by the Worker and scoped by the project token. Automated clients
must report evidence to `POST /memory/extraction/ingest`; the Worker owns candidate extraction,
verification, and automated claim mutation. `POST /memory/claims` remains for explicitly
authorized management operations.

### `POST /memory/context`

Returns active, non-proposed claims ordered deterministically by scope and recency,
with their supporting segment ids. It is intended for a pre-turn context loader.

Initial selection is structural, not semantic:

1. requested user scope,
2. requested project scope,
3. requested session scope,
4. active claim status only.

This makes currently applicable instructions and preferences reliable before adding a
second vector index.

## Phased Delivery

### Phase 1: Durable claim ledger

1. Add `memory_claims` and `memory_evidence` migrations.
2. Add D1 access functions and strict claim request validation.
3. Implement claim mutation and deterministic `/memory/context`.
4. Type-check the Worker and exercise all mutation paths with a D1-backed test harness.

### Phase 2: Candidate extraction

1. Let clients report bounded, already-indexed evidence to the Worker-owned extraction queue.
2. Require structured candidate output with cited source segment ids and a classification that
   separates preferences from opinions and current state.
3. Run an independent verification pass before any candidate can mutate `memory_claims`.
4. Persist candidate/verdict audit rows; reject opinions and ambiguous current-workflow statements
   rather than treating them as preferences.
5. Use only user-labelled portions of mixed conversation segments as extraction evidence, and reject
   candidates that do not cite one of the queued evidence segment ids.

### Phase 2b: Worker-side link fetching

Links inside user evidence are resolved by the Worker itself (the "Worker fetch" option of the
link-content design), not by each submit client. Chosen because pages behind a login or on a
private network are explicitly out of scope; without that requirement, client-side fetching buys
nothing and costs one implementation per client.

1. Strip client-inlined `<referenced_web_content>` blocks at ingest and neutralize line-leading
   role markers, so the trust delimiter is always one the Worker wrote and can verify.
2. Fetch links at flush time, once per batch: no client latency, no refetch on job retry, and one
   fetch per distinct URL in the batch.
3. Store each page as its own `kind: "web_reference"` segment carrying `source_url`, `final_url`,
   `fetched_at`, `fetch_provider`, and `content_hash`. The segment id is derived from URL plus
   content hash, so a changed page becomes a new segment instead of rewriting evidence an existing
   claim already cites.
4. Budget user speech and fetched pages separately (12000 / 6000 characters), and count only user
   speech toward the batching threshold, so one link cannot consume a whole batch.
5. Require every accepted candidate to cite at least one `kind: "user"` segment. A page instructing
   the reader to "always answer in English" therefore cannot promote itself into a claim.

Fetching is guarded against SSRF (scheme, port, credential, private-address, and per-hop redirect
checks). Workers cannot resolve DNS before fetching, so a public hostname that resolves to a private
address is a known, accepted gap.

### Phase 3: Semantic durable-memory retrieval

1. Add a dedicated `CLAIMS_INDEX` Vectorize binding and
   `project:<project_id>:claims` namespace.
2. Embed only active claim text; remove or update vectors on supersede/retract.
3. Use status, scope, type, and workspace metadata filters before topK truncation, and
   use exact cosine scores for threshold decisions.
4. Use a D1 candidate fallback when newly written vectors are not query-visible yet.
5. Serialize semantic create decisions with a short-lived D1 lease lock.
6. Fuse deterministic active instructions/preferences with semantic claim matches and
   raw evidence matches.
7. Keep D1 status, scope, validity, and project checks as the final authority after
   vector retrieval.

### Phase 4: Whisper integration

1. Load `/memory/context` before each Whisper turn using the current user, project,
   and session scopes.
2. Add selected claims as a bounded, clearly labelled context block.
3. Retain `recall.search` for raw conversational evidence and detailed historical
   retrieval.
4. Record whether injected claims were used so stale or harmful memories can be
   audited and corrected.

### Phase 5: Evaluation and operations

Maintain regression cases for explicit preferences, reinforcement, replacement,
retraction, transient statements, model-inferred candidates, project isolation, evidence
traceability, Vectorize eventual consistency, and concurrent claim writes. Track extraction
precision, conflict rate, stale-memory rate, duplicate rate, lock contention, and
context-token budget.

## Implementation Status

- [x] Phase 1.1 migrations
- [x] Phase 1.2 claim ledger access and validation
- [x] Phase 1.3 claim mutation API
- [x] Phase 1.4 deterministic context API
- [x] Phase 1.5 type-check
- [x] Phase 2 extraction producer
- [x] Phase 2b Worker-side link fetching
- [x] Phase 3 semantic claim index
- [x] Phase 4 Whisper integration
- [ ] Phase 5 evaluation and operations
