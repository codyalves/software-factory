# ADR 0005: The implement-and-gate loop

Status: accepted (M1)

## Context

Once triage sends an issue to Planning, the factory has to change code until
it is good enough, then hand it to a person. The coding agent is capable but
not trustworthy on its own say-so: it can claim success, skip tests, or edit
the checks that judge it. Everything it does must be reproducible from the
record.

## Decision

**Criteria get ids.** Leaving Planning, the orchestrator numbers the issue's
bullet points as acceptance criteria (AC-1, AC-2, ...) and stores them on the
requirement. Triage has already judged them testable. No criteria: escalate.

**One branch per run; one commit per attempt.** The implement step clones the
target, checks out `factory/<issue>-<run>` (continuing the previous attempt's
tip, so later attempts fix rather than restart), lets the implementer edit
files, then the *worker* commits and pushes. The implementer never commits,
pushes or touches run state. Commits carry `Factory-Run`, `Factory-Attempt`
and `Factory-Implementer` trailers.

**Gates judge an exact commit in a fresh clone.** The gate step checks out
the attempt's commit and runs:

| Gate | Fails when |
| --- | --- |
| `changes` | the attempt changed nothing |
| `protected_paths` | it touched a protected path (CI, gate config, dependency manifests) |
| `secret_scan` | an added line looks like a credential (reported by location, never value) |
| `setup` + command gates | a target command (`lint`, `typecheck`, `unit_tests`, ...) exits non-zero or times out |
| `traceability` | a criterion is not named by any test (`it('AC-1: ...')`) |

Target commands come from `gates/targets.json` in the *factory* repository,
under CODEOWNERS, not from the target: an agent working in the target cannot
change how it is judged. Commands run without a shell, in a scrubbed
environment (no tokens or keys), with a timeout that kills the process group.

**Code decides.** `gatingOutcome` is the only judge: all gates green goes to
Reviewing; any red goes back to Implementing with the failures (output tails,
bounded) as feedback; after `MAX_IMPLEMENT_ATTEMPTS` (4) or once the run's
spend reaches its budget, the run escalates with a comment. No model output,
including a future AI review, can turn a red gate green.

**Everything is on record.** Each gate verdict is a `gate_result` row (with
the output) and part of a `gating.completed` audit event. On success the
orchestrator writes `trace_link` rows (requirement, criterion, test, commit)
and queues `pull_request.open` in the outbox; the PR body lists every
criterion with its tests and every gate. Opening is idempotent: a retry finds
the PR an earlier attempt opened.

**Each finished step is applied once.** A looping run accumulates finished
steps of the same kind, so applying a step sets `step.consumed_at` in the
transaction that moves the run.

## The implementer

Claude Code, headless (`prompts/implement.v1.md`), one `claude -p` run per
attempt: `--bare`, `--permission-mode dontAsk` with an allow-list (file
tools and the target's own commands only), `--max-budget-usd` per attempt,
`--strict-mcp-config`, no web tools, a private HOME, and only the API key in
its environment. Hitting the budget is a finished attempt for the gates to
judge; failing to run at all (bad key, outage) is a step failure for the
queue, so attempts are not wasted. Model tiers: Sonnet first, Opus after two
failed attempts.

## Consequences

- Pushing to `factory/*` branches is done by the worker, not through the
  outbox. Those branches are the step's output (like an artifact upload):
  invisible to users until the PR, which does go through the outbox.
- Dependency changes need a person (manifests are protected). That matches
  the risk rules, where a dependency change is high risk.
- Gate commands run as processes on the worker. Running them in a container
  with no network and a read-only factory checkout is the next hardening
  step, before the factory takes issues from anyone but its owner.
- Tests name criteria by id. It is a small convention that buys a
  machine-checkable traceability record, which is the point of the project.
