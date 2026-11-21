# ADR 0007: The factory ships to production itself

Status: accepted

## Context

Until now every factory pull request stopped in Reviewing and waited for a
person to merge it. That made the owner the bottleneck for work the gates had
already judged, and it split his attention between two kinds of review: the
factory's code and policy, and each change it produced.

The owner's goal is the opposite: he reviews the factory (its code, its gates
and this policy, all protected by CODEOWNERS) and the factory delivers to the
target continuously while it runs.

## Decision

**Risk decides who merges.** Work that passes every gate goes to Merging when
its final risk (the higher of triage's prediction and what the diff touched)
is low or medium, and to Reviewing, held for the owner, when it is high. The
rule is `deliveryDecision` in `packages/domain/src/delivery.ts`; the levels
are `AUTO_MERGE_RISK_LEVELS`, pinned to `gates/gates.yaml` by `policy.test.ts`.
Changing either needs the owner's review.

**GitHub merges, after the target's own CI.** The factory never merges a pull
request whose checks have not passed. For work in Merging it opens the pull
request and, through the outbox, turns on GitHub auto-merge, so GitHub merges
only once the target branch's required checks pass. If the pull request can
already merge, the factory merges it only after confirming the checks passed.
The target's `main` requires those checks and no human review, so neither the
factory nor anyone else can merge red work.

**Watching is a step; the result is a transition.** A worker step (`merge`)
watches the pull request until GitHub merges it, a check fails, or it is
closed. The orchestrator applies the result: Merging -> Merged, with the merge
commit in the audit log (`delivery.merged`), or Escalated with a comment
saying why (`delivery.failed`). A watch that runs out of time is transient and
retried by the queue like any other step; when its attempts are spent, a
person takes over.

**The state machine allows Gating -> Merging.** For low and medium risk the
merge policy is the review. Reviewing now means one thing: a person must look.

**Working through a backlog.** The `factory-backlog` workflow runs the
oldest open issue labeled `factory:ready` whose "Depends on #N" issues are
closed, waits for it to ship, be held or escalate, and takes the next. It
stops when nothing is ready, at its run limit, or when the daily budget or a
pause stops a run. The owner still decides when it runs.

An issue the factory could not ship (held for review, escalated, rejected or
cancelled) moves from `factory:ready` to `needs-owner`, so the next session
does not run it again; the owner re-adds `factory:ready` to retry. Stopping a
session part-way leaves a run unfinished: the next session cancels it (its
steps are stopped, and the audit log says who and why) and runs the issue
again.

## Consequences

- The owner approves pull requests on the factory, not on the target.
- Every shipped change still traces to its issue, criteria, tests, gates and
  merge commit, in one hash-chained record.
- A wrong merge is now possible without a person in the loop, so the backlog
  runner checks production after each shipped run (`postDeployDecision`): it
  waits for the host's deploy of the merge commit, runs the tester on the
  live site, and if the tester confirms anything new it files the finding,
  reverts the change through the outbox (`pull_request.revert`, merged like
  any factory change) and stops. A deploy that fails or never finishes also
  stops it. Each outcome is in the run's audit log (`delivery.verified` or
  `delivery.check_failed`).
- High-risk work still waits. If held pull requests pile up, that is a signal
  to split issues or adjust risk paths, not to widen the policy quietly.
