# ADR 0003: Reconcile Raw Segment Vector Writes Through a D1 Outbox

## Status

Accepted

## Context

Raw segment indexing writes to Vectorize and D1 as separate operations. A failure or process termination between them can leave a vector without a durable segment row, and the retention pipeline cannot discover that orphan from D1 alone.

## Decision

Write the segment and a segment-vector outbox record to D1 first. D1 triggers create or supersede one outbox row per segment. The request path writes Vectorize only after the D1 transaction succeeds, then removes the matching outbox row. A scheduled reconciler leases pending rows, retries the latest segment revision, and deletes vectors for pending or completed deletions.

Historical orphan cleanup accepts an explicit bounded candidate set, reports dry-run results, and applies deletes only when explicitly requested. Search continues to join Vectorize matches back to active D1 rows.

## Consequences

- D1 failure cannot create a new vector-before-row orphan.
- Process interruption is recoverable because the outbox row is committed before Vectorize access.
- Reconciliation may re-embed pending segment text, but bounded retries prevent an unbounded request-path cost.
- Vectorize and D1 remain separate systems, so stale work is resolved by revision-checked leases and latest-job retries rather than a distributed transaction.
