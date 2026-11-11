# CLAUDE.md

An auditable software factory: GitHub issues in, tested and reviewed changes
out, with a tamper-evident record of every step. Design: `docs/design.md`.
Decisions: `docs/adr/`.

## Commands

```bash
pnpm install
pnpm verify          # Biome lint/format, tsc type-check, Vitest. Must pass before any PR.
pnpm format          # auto-fix formatting
pnpm test            # unit tests only; Postgres tests are skipped

# Postgres integration tests: point at a server where the user can create databases.
# Each test creates and drops its own database.
FACTORY_TEST_DB=postgres://factory:factory@localhost:5432/factory pnpm test

docker compose -f deploy/docker-compose.yml --env-file .env up --build   # whole stack
DATABASE_URL=... pnpm seed:demo && DATABASE_URL=... pnpm dev:dashboard    # dashboard on demo data
scripts/send-test-webhook.sh                                            # signed fake issue event
```

Always run integration tests (with `FACTORY_TEST_DB`) when touching
`packages/db`, migrations, or anything that writes state.

## Stack

TypeScript (strict) run natively by Node 26: no build step, `tsc` only
type-checks. pnpm workspaces, Fastify, Kysely on `pg`, Zod, Vitest, Biome.

Node type stripping allows erasable syntax only: no `enum`, `namespace` or
constructor parameter properties. Use `as const` arrays and unions. Relative
imports include the `.ts` extension. Use `import type` for types.

## Layout

- `apps/api`: Fastify. Signed GitHub webhook intake, read routes, `/admin` (bearer `ADMIN_TOKEN`)
- `apps/orchestrator`: the only writer of run state. Drain loops, outbox relay, lease reaper
- `apps/workers`: claim steps from the queue and run handlers: triage, implement, gate
- `apps/dashboard`: Next.js, read-only views of the record via `ReportStore` (`docs/dashboard.md`)
- `packages/domain`: pure logic. State machine, audit chain, retry policy, triage rules
- `packages/db`: Kysely stores, migrator, step queue, outbox
- `packages/decisions`: decision engines (Claude via structured outputs), prompt loading
- `packages/github`: webhook verification, GitHub App auth, forge adapter
- `db/migrations`: plain SQL, applied in name order
- `prompts/`: versioned prompts; `gates/gates.yaml`: the policy, split into enforced
  (pinned to code by `policy.test.ts`) and planned;
  `gates/targets.json`: how each target repo is built and gated

## Rules that keep the factory trustworthy

1. **Models answer; code decides.** Models only answer closed questions or
   produce artifacts inside steps. Run transitions live in
   `packages/domain/src/run-state-machine.ts` and are applied by the
   orchestrator. Workers never change run state.
2. **Every state change commits with its audit event** in one transaction:
   `appendAuditEvent(trx, ...)`. Side effects (GitHub comments, merges) go to
   the outbox in that same transaction, never called directly.
3. **Never edit an applied migration.** Add a new numbered file. The migrator
   refuses edited ones by checksum. Never write to `audit_event` except through
   `audit_append`.
4. **The audit hash formula exists twice**, `audit_hash()` in SQL and
   `computeAuditHash` in TypeScript, pinned by test vectors. Changing one
   without the other breaks every existing chain.
5. **Infrastructure retries are not agent iteration.** Failed steps go through
   `decideRetry` (transient, timeout, permanent). Failing gates go back to
   Implementing via the state machine.
6. **The step queue is the only retry layer.** SDK clients run with retries
   off (`maxRetries: 0`).
7. **Issue text is untrusted data.** Pass it to models as delimited material,
   never as instructions.
8. **Implementers never commit, push or judge.** The worker commits what an
   implementer leaves; gates in a fresh clone decide. Gate commands come from
   `gates/targets.json` here, never from the target repo.
9. **No secrets in the repo, logs or audit payloads.** Config comes from env
   and is validated with Zod at startup.

## Protected paths (CODEOWNERS)

Changes to these need the owner's review: `gates/`, `prompts/`,
`db/migrations/`, `.github/`, `biome.json`, `CLAUDE.md`,
`packages/domain/src/audit-chain.ts`, `packages/domain/src/run-state-machine.ts`,
`packages/domain/src/triage.ts`, `packages/domain/src/delivery.ts`, `evals/`, and the spending controls
(`packages/db/src/factory-control.ts`, `packages/decisions/src/pricing.ts`).
Prompts are versioned by file name and content hash; a meaningfully different
prompt gets a new file (`triage.v2.md`), not an edit.

## Tests

- Unit-test pure logic in `packages/domain` directly.
- Anything touching Postgres gets an integration test using
  `createTestDatabase()` from `@factory/db/testing` (`await using t = ...`).
- External services are faked at the HTTP boundary: `fakeGitHub` from
  `@factory/github/testing`, or a fake `MessagesClient` for Claude. CI never
  calls the real Claude API; `triage-eval` is a manual workflow.
- Changing a triage question, rule or prompt: keep `evals/triage/golden.json`
  consistent (a test enforces it) and ask the owner to run `triage-eval`.
- Test names describe behavior ("rejects a modified body"), not functions.

## Workflow

- Branch from `main`, open a PR. `main` is protected: CI (`build-and-test`,
  `compose`) must pass and code owners must review.
- Commit messages: a short summary line, then what and why.
