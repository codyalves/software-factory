# ADR 0003: Hash-chained, append-only audit log in Postgres

Status: accepted (2026-11-02)

## Context

The factory's value is evidence: what was asked, what was decided, what was
tested, who approved. That record must be trustworthy even to someone who does
not trust the operator.

## Decision

- One `audit_event` table, append-only, where each row stores
  `sha256(prev_hash, seq, at, run_id, type, payload)`.
- Writes only through the `audit_append` function, which serializes appends
  with an advisory lock so there is a single chain.
- Payloads are stored as their exact canonical JSON text; a generated `jsonb`
  column is kept for querying.
- Triggers block `UPDATE`, `DELETE` and `TRUNCATE`, including on partitions.
- The same hash formula exists in SQL and TypeScript, pinned together by test vectors.

## Consequences

- An owner can still disable triggers, but any edit breaks the chain at the
  edited event, and both verifiers report it.
- A single chain serializes audit writes. At this project's volume that is
  negligible; per-repo chains are the path if it ever is not.
- Anchoring the head hash in signed release tags (planned) makes rewriting
  history also require rewriting public tags.
