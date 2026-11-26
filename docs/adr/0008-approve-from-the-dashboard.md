# 8. The owner approves held work from the dashboard

## Status

Accepted.

## Context

ADR 0007 holds high-risk work for the owner: the run stops in Reviewing with
its pull request open on the target. Nothing in the factory moved a run out
of Reviewing. The owner was expected to merge the pull request on the target
by hand, which had three problems:

- It contradicts ADR 0007's own consequence, "the owner approves pull
  requests on the factory, not on the target". The owner does not work in the
  target's pull requests.
- The record never learned of it. The run stayed "held for review" after the
  work had shipped, and who approved it was not in the audit log.
- Issues that depend on a held one stay blocked, so one hold stops a backlog.

## Decision

**Approval is a factory transition, started from the dashboard.** An owner
presses Approve on the status page. Like every dashboard action it goes
through GitHub: it dispatches the `factory-approve` workflow with the run id
and the owner's login. The dashboard's database login stays read-only.

**The orchestrator applies it.** `approveHeldRun`
(`apps/orchestrator/src/delivery.ts`) moves that one run Reviewing -> Merging,
a transition the state machine already allowed, and in the same transaction
appends `delivery.approved` with the approver, queues the merge request in the
outbox and queues the merge step. From Merging the run ships exactly as an
auto-merged one does: GitHub merges once the target's required checks pass,
the merge step watches, and the run ends Merged or Escalated with a reason.

**Approving twice is safe.** The transition only applies to a run that is in
Reviewing, so a second click or a second workflow changes nothing. Approving a
run whose pull request was already merged by hand settles the record: the
merge request finds it merged and the watch reports the merge commit.

**The merge policy is unchanged.** `AUTO_MERGE_RISK_LEVELS` and
`gates/gates.yaml` still hold high risk. This changes only where and how the
owner releases it.

## Consequences

- The owner never needs the target's pull requests; the audit log names who
  approved each held change.
- An approval shares the factory's one slot (the `factory-run` concurrency
  group), so it waits for a running session and a session waits for it.
- The approval workflow needs the persistent database
  (`FACTORY_DATABASE_URL`): a throwaway one would not hold the run.
- A paused factory sends nothing, so the approval lifts the pause for its own
  merge and puts it back, with its reason, afterwards.
- Not done here: the production check the backlog runner makes after each
  shipped change (`postDeployDecision`) does not run after an approved merge.
  A person approved it, but the live site is not re-tested until the next
  session ships something.
- Triage still decides what is held, from the issue text. A false alarm
  ("shows a price" read as payments) now costs the owner one click instead of
  a trip to GitHub, but it still stops the backlog until that click.
