# Software Factory

An auditable software factory: GitHub issues go in, tested and reviewed changes
come out, and every step leaves a tamper-evident record of how the change was made.

Most agentic coding demos show an agent writing code. This project is about the
part regulated teams actually worry about: **who decided what, on what
evidence, and can you prove the record wasn't edited afterwards?**

```mermaid
flowchart LR
    I[Issue labeled factory] --> T[Triage] --> P[Spec + plan] --> M[Implement] --> G{Gates pass?}
    G -- yes --> R[Review] --> MG[Merge or approve]
    G -- "fail: iterate, max 4" --> M
    M -- budget or attempts used up --> E[Escalate to a human]
```

Every transition writes an event to a hash-chained, append-only audit log in Postgres.

## Design principles

- **Deterministic orchestration.** Code owns the state machine, gates, budgets
  and merges. Models answer bounded questions inside steps; they never decide
  what happens next on their own. ([ADR 0001](docs/adr/0001-deterministic-orchestrator.md))
- **Evidence by construction.** A state change and its audit event commit in the
  same transaction. The chain is verifiable both inside Postgres and in plain TypeScript.
  ([ADR 0003](docs/adr/0003-hash-chained-audit-log.md))
- **Infrastructure retries are not agent iteration.** A network blip is retried
  with backoff; failing tests become a new implement attempt with the failure as input.
- **Model tiers.** A decision layer (Jev or a constrained LLM) handles typed
  judgments with a confidence; small and frontier LLMs handle generation by tier.
- **Host-agnostic.** GitHub first, behind a forge adapter. ([ADR 0002](docs/adr/0002-github-first-forge-adapter.md))

Full design: [docs/design.md](docs/design.md).

## Stack

| Layer | Choice |
| --- | --- |
| Language | TypeScript (strict), run natively by Node 26 LTS with no build step |
| API | Fastify |
| Database | PostgreSQL 16, Kysely query builder, plain SQL migrations |
| Validation | Zod |
| Tests | Vitest, with real Postgres in CI |
| Lint and format | Biome |
| Monorepo | pnpm workspaces |
| Dashboard (M2) | React |
| Target app | Next.js |

Why TypeScript: [ADR 0004](docs/adr/0004-typescript-stack.md).

## Status

| Milestone | Scope | State |
| --- | --- | --- |
| M0 Skeleton | Schema, hash-chained audit log, signed webhook intake, run state machine, CI | Done |
| **M1 Reliable core** | Queue, leases, retries, DLQ, outbox, gates, iteration loop, decision layer | **In progress**: step queue and triage done |
| M2 Visible | Dashboard, DLQ replay, traceability report, cloud deploy with LB and CDN | Planned |
| M3 More intake | CI-failure and error-webhook intake, scheduled self-review | Planned |
| M4 Reference mode | Behavior traces from a reference app become issues and replay gates | Planned |
| M5 Scale story | Autoscaling workers, load test, read replica, sharding write-up | Planned |

**Target app:** a platform that turns a company's supplied information into a
website with a chatbot grounded in that information. The factory builds and
maintains the platform; chatbot answer quality is gated by eval suites.

## What works today

- `POST /webhooks/github` verifies the HMAC signature, ignores redeliveries,
  and turns an issue labeled `factory` into a requirement and a run.
- The orchestrator claims runs with `FOR UPDATE SKIP LOCKED` and moves them
  through the state machine, recording each transition.
- `GET /audit/verify` recomputes the whole chain twice, in Postgres and in TypeScript,
  and reports the first broken event.
- The audit table rejects `UPDATE`, `DELETE` and `TRUNCATE`, including on
  individual partitions. If a privileged user disables that, the hash chain
  still pinpoints the edited event (see the integration tests).
- **Durable step queue.** Workers claim steps with `FOR UPDATE SKIP LOCKED`
  under a lease and extend it with heartbeats. Failures are classified:
  transient errors retry with exponential backoff and full jitter (honoring
  `Retry-After`), timeouts retry once, permanent errors go straight to the
  dead-letter queue. A step whose worker dies is reclaimed when its lease
  expires, and the dead worker's late result is rejected.
- **Failure capture.** Every attempt is kept in `step_attempt` with its worker,
  outcome, failure class and error details. `GET /admin/dead-letters` lists
  them and `POST /admin/steps/:id/replay` retries one, recording who did it.
  Admin routes need `Authorization: Bearer $ADMIN_TOKEN`.
- **Triage through the decision layer.** A new run gets a triage step. A worker
  asks Claude Haiku three closed questions (issue type, spec readiness, risk
  tier) using structured outputs, so each answer is one of the allowed options
  plus a probability. The orchestrator, not the model, then applies the rules:
  low-confidence answers take safe fallbacks (unsure risk counts as high, an
  unsure spec counts as not ready, an unsure type goes to a human), and the run
  moves to Planning, Rejected or Escalated. Every decision is an audit event
  with its probability, model and prompt hash, and an issue that needs
  clarification gets a comment queued in the outbox.

## Run it locally

Requires Docker. To work outside Docker you need Node 26 and pnpm (`npm install -g pnpm`).

```bash
cp .env.example .env            # set GITHUB_WEBHOOK_SECRET
docker compose -f deploy/docker-compose.yml --env-file .env up --build

curl localhost:8080/healthz
GITHUB_WEBHOOK_SECRET=<your secret> scripts/send-test-webhook.sh
curl localhost:8080/audit/verify
```

Develop and test:

```bash
pnpm install
pnpm verify                     # lint, type-check, unit tests

# Postgres integration tests need a server the user can create databases on
FACTORY_TEST_DB=postgres://factory:factory@localhost:5432/factory pnpm test
```

## Repository layout

```
apps/
  api/                     Fastify: webhook intake and read API
  orchestrator/            run state machine driver
  workers/                 agent and gate step runners (M1)
packages/
  domain/                  state machine, audit chain, retry policy, decision + forge interfaces
  db/                      Kysely stores and migrator
  github/                  webhook signature verification and parsing
db/migrations/             SQL schema, including the audit chain functions
gates/gates.yaml           gate thresholds and merge policy (CODEOWNERS-protected)
prompts/                   versioned prompts (CODEOWNERS-protected)
deploy/                    Dockerfile and docker compose stack
docs/                      design and architecture decision records
```

## License

[MIT](LICENSE)
