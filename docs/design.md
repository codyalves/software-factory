# Design

The factory turns an issue into a merged, tested change with a tamper-evident
record of how it got there. Throughput is limited by model rate limits and
budget, not by servers, and the design is sized for that.

## Goals

- Take an issue through triage, spec, plan, implement, gates and merge with no
  human in the loop for low-risk work.
- Produce an audit record per change: requirement, acceptance criteria, plan,
  commits, test evidence, reviewer verdict, approver.
- Iterate on gate failures automatically within an attempt and cost cap, then
  escalate.
- Recover from crashes mid-run without losing or duplicating work.

Non-goals for v1: cloning third-party websites, multi-tenant SaaS, claiming
regulatory compliance (it produces evidence; it is not an eQMS).

## Architecture

Three deployables and three stores.

| Component | Role |
| --- | --- |
| `apps/api` | Webhook intake, dashboard API. Stateless; scales behind a load balancer. |
| `apps/orchestrator` | Run state machine and outbox relay. The only component that merges. |
| `apps/workers` | Lease steps; run each agent or gate step in a fresh sandbox container. Scale on queue depth. |
| Postgres | System of record: runs, queue, evidence, audit chain. |
| Redis | Rate limits per model and repo, locks. |
| Object storage | Logs, diffs, transcripts, test reports, addressed by SHA-256. |

## Run state machine

`Intake → Triage → Planning → Implementing → Gating → Reviewing → Merging → Merged`

- Gating or Reviewing can return to Implementing with the failure as input, up
  to 4 implement attempts.
- Any active run can go to Escalated (budget, attempts, low confidence) or
  Cancelled. Triage can Reject.
- Encoded in `packages/domain/src/run-state-machine.ts`; transitions commit with
  their audit event in one transaction.

## Audit chain

`hash = sha256(prev_hash \n seq \n at \n run_id \n type \n payload)`

- Appends go through the `audit_append` SQL function, which serializes writers
  with an advisory lock.
- Triggers reject `UPDATE`, `DELETE` and `TRUNCATE`.
- `audit_verify()` in SQL and `verifyChain` in TypeScript implement the same check;
  test vectors keep them in lockstep.
- Planned: anchor the head hash in a signed release tag per release.
- `audit_event` and `cost_ledger` are partitioned by month from day one.

## Failures

| Failure | Handling |
| --- | --- |
| Transient (network, 429, 5xx) | Retry the step with exponential backoff and full jitter, max 5, honoring Retry-After |
| Timeout | Retry once, then dead-letter |
| Gate failure | Not an infra retry: new implement attempt with the failure output |
| Budget exceeded | Escalate |
| Permanent | Dead-letter immediately |

Steps move `queued → running → succeeded`, or back to `queued` after a
backoff, or to `dead_lettered`. A worker holds a lease while it runs and
heartbeats at a third of the lease; the orchestrator's reaper reclaims expired
leases as transient failures. Every attempt is recorded in `step_attempt`.

Delivery is at-least-once with idempotent handlers (`idempotency_key` per step,
`inbound_delivery` for webhooks). Side effects go through a transactional outbox.

## Model tiers and decision layer

| Tier | Does |
| --- | --- |
| 0. Code | State machine, gates, budgets, merges |
| 1. Decision model | Typed judgments with confidence: triage, routing, failure class, merge tier |
| 2. Small LLM | Summaries, criteria extraction, PR descriptions |
| 3. Frontier LLM | Plan, implement, review |

`DecisionModel` has interchangeable engines. The first is Claude Haiku with
structured outputs (`packages/decisions`); a Jev engine can be added behind the
same interface and compared per question. Prompts live in `prompts/` and every
decision records the prompt's name and content hash. Each
decision is audited with its probability; below the confidence threshold the
safe fallback applies. The reviewer runs on a different model than the implementer.

## Infrastructure phasing

Each component lands when a measured need appears.

| Component | Milestone |
| --- | --- |
| Task queue, retries, DLQ, idempotency, partitioning | M1 |
| Redis rate limits and locks | M1 |
| Read cache, load balancer, CDN | M2 |
| Serverless webhook intake | M3 |
| Worker autoscaling, read replica | M5 |
| Sharding (key: `repo_id`) | Designed, not built; M5 load test shows where one node breaks |

## Security

- Sandboxed steps with no host mounts and restricted egress.
- Short-lived, repo-scoped tokens. Agents never hold the merge token.
- Issue text and repo content are data, never instructions to agents.
- A global pause switch (the factory starts paused) and a per-day budget
  enforced from the cost ledger before each step is claimed (built in M1).
  Per-run budgets and a `factory:stop` label come with the implement loop.
- Gates, prompts, migrations, CI, pricing and the spending controls are
  CODEOWNERS-protected, so an agent cannot raise its own budget.
