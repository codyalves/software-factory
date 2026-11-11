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
| M1 Reliable core | Queue, leases, retries, DLQ, outbox, gates, iteration loop, decision layer | Done: first live run took an issue to a pull request in one attempt for $0.05 |
| **M2 Visible** | Dashboard, DLQ replay, traceability report, cloud deploy with LB and CDN | **In progress**: dashboard, traceability report and hosting setup done ([docs/hosting.md](docs/hosting.md)); going live next |
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
  asks Claude Haiku seven closed questions using structured outputs, so each
  answer is one of the allowed options plus a probability: the issue type,
  whether the spec is testable, and five yes/no risk questions (does the work
  touch authentication, stored data, payments, the platform and its
  dependencies, or behavior users rely on). The orchestrator, not the model,
  then applies the rules: the risk tier is the highest tier among the "yes"
  answers, low-confidence answers take safe fallbacks (an unsure "no" counts
  as "yes", an unsure spec counts as not ready, an unsure type goes to a
  human), and the run moves to Planning, Rejected or Escalated. Every decision
  is an audit event with its probability, model, prompt hash and question
  hash; the tier is recorded with the factors that set it; and an issue that
  needs clarification gets a comment queued in the outbox.
- **Triage evals.** [`evals/triage/golden.json`](evals/triage/golden.json)
  holds 20 hand-labeled issues, including prompt-injection attempts. A test
  proves the labels and the triage rules agree; the `triage-eval` workflow
  (run by hand) scores the live model: routing and tier accuracy, per-question
  accuracy, confident mistakes, calibration (Brier score) and cost. It fails
  on any unsafe outcome: work planned that should not be, or risk rated too
  low. See [docs/evals.md](docs/evals.md).
- **Outbox relay.** Side effects are written to the outbox in the same
  transaction as the state change that causes them, then posted to GitHub by
  the factory's own [GitHub App](docs/github-app.md) (short-lived, repo-scoped
  tokens). Delivery retries with backoff and honors GitHub's rate limits.
  Each comment carries a hidden marker, so if GitHub accepted a comment but
  the response was lost, the retry finds it instead of posting twice.
- **Pause switch and daily budget.** The factory starts paused. Workers check
  the switch and today's spend before claiming each step, and the outbox relay
  checks the switch before sending, so pausing stops every call to Claude and
  GitHub while webhooks keep being recorded. Every billed model call, including
  ones whose answer was rejected, lands in `cost_ledger` at list price; once
  today's total reaches the budget (default $3.00/day, about $100 a month),
  workers stop claiming until midnight in the budget's time zone. Pause,
  resume and budget changes are audit events naming who made them.
- **Implement-and-gate loop.** A planned run numbers the issue's acceptance
  criteria (AC-1, AC-2, ...), then loops: an implementer changes the code on
  the run's branch, the worker commits and pushes it with trailers naming the
  run and attempt, and the gates run on that exact commit in a fresh clone.
  Failing gates go back to the implementer as feedback (up to 4 attempts or
  the run's budget, then a person); passing gates record the traceability
  links and queue the pull request. Gates: the target's own commands (from
  [`gates/targets.json`](gates/targets.json), which lives here so an agent
  cannot change how it is judged), plus built-in checks for an empty change,
  protected files, committed credentials, and **traceability**: every
  criterion must be named by a test (`it('AC-1: ...')`), giving a record of
  requirement → criterion → test → commit. See
  [ADR 0005](docs/adr/0005-implement-and-gate-loop.md).
- **Claude Code as the implementer.** Each attempt is one headless
  `claude -p` run in the workspace: `--bare` (no personal settings, hooks or
  memory), `--permission-mode dontAsk` with an allow-list (file tools plus
  exactly the target's own setup and gate commands; no web, no MCP), a hard
  `--max-budget-usd` cap, and only the API key in its environment, so it
  cannot push. Sonnet does the first attempts; after two failures the next
  attempt escalates to Opus (`gates.yaml`). Its own cost report is metered
  into the ledger, and a run that cannot start (bad key, outage) fails the
  step instead of spending an attempt.
- **Dashboard.** A read-only Next.js app over the record: every run, each run
  told in order (triage answers with their confidence, the numbered criteria,
  every attempt and its checks, measured risk, the criterion-to-test trace,
  cost by model), a traceability matrix across requirements, and the audit
  chain, recomputed and verified on every view. See
  [docs/dashboard.md](docs/dashboard.md); `pnpm seed:demo` fills a database
  with realistic runs for free.

  ![A run record: an issue escalated after four attempts, with its triage answers](docs/images/dashboard-run-record.png)

  ![Two attempts: the first failed traceability, the second passed every check](docs/images/dashboard-run-attempts.png)

- **Tester (phase 1).** A crawler finds problems a program can decide on its
  own (uncaught errors, console errors, failed requests, broken links,
  serious accessibility violations), confirms each with a generated
  Playwright test that fails three times out of three, and files the
  confirmed ones as issues carrying that test. The dev loop must make the
  test pass without changing it: the worker commits it first and the folder
  is protected. Only the factory's own App can attach such a test. No model,
  no cost. See [docs/tester.md](docs/tester.md) and
  [ADR 0006](docs/adr/0006-tester.md).

## Run it locally

Requires Docker. To work outside Docker you need Node 26 and pnpm (`npm install -g pnpm`).

```bash
cp .env.example .env            # set GITHUB_WEBHOOK_SECRET
docker compose -f deploy/docker-compose.yml --env-file .env up --build

curl localhost:8080/healthz
GITHUB_WEBHOOK_SECRET=<your secret> scripts/send-test-webhook.sh
curl localhost:8080/audit/verify

scripts/factory.sh status       # paused? spent today? (reads ADMIN_TOKEN from .env)
scripts/factory.sh resume       # let workers spend
scripts/factory.sh pause "done for today"
scripts/factory.sh budget 2.00 America/New_York
```

Develop and test:

```bash
pnpm install
pnpm verify                     # lint, type-check, unit tests

# Postgres integration tests need a server the user can create databases on
FACTORY_TEST_DB=postgres://factory:factory@localhost:5432/factory pnpm test
```

## When it spends API credit

Only when you start it. Nothing is deployed, and nothing runs on a schedule.

- **The factory** runs only while `docker compose up` (or `pnpm dev:*`) is
  running, and even then it starts paused: nothing is spent until you run
  `scripts/factory.sh resume`. Pause it again when you stop working.
- **The daily budget** caps what workers spend per day. The check happens
  before each step, so one step can finish slightly over the cap (a triage
  step costs well under a cent).
- **Per run and per attempt:** a run escalates once its spend reaches its
  budget ($5 by default), and each Claude Code attempt is hard-capped by
  Claude Code itself (`IMPLEMENT_ATTEMPT_BUDGET_USD`, default $1.25).
- **A single issue, start to finish:** Actions → **factory-run** → Run
  workflow, with the repo and issue number. It triages, implements, gates,
  comments and opens the PR, then pauses and stops. The report is in the run
  summary and the audit log is an artifact. Locally:
  `node apps/workers/src/run-issue.ts --repo owner/name --issue N`.
- Workers without `ANTHROPIC_API_KEY` take neither triage nor implement steps.
- **CI** never calls the Claude API. Unit and integration tests use a fake model.
- **The triage eval** runs only by hand: Actions → triage-eval → Run workflow
  (about two cents per run with Haiku), or `pnpm eval:triage` locally.
- **GitHub** is only written to while the orchestrator runs with a GitHub App
  configured; otherwise comments wait in the outbox.

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
apps/dashboard             read-only views of the record (Next.js)
gates/gates.yaml           policy: what is enforced (pinned to the code by a test) and what is planned
prompts/                   versioned prompts (CODEOWNERS-protected)
deploy/                    Dockerfile and docker compose stack
docs/                      design and architecture decision records
```

## License

[MIT](LICENSE)
