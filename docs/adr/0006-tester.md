# ADR 0006: A tester that files executable bug reports

Status: accepted (phase 1)

## Context

The dev loop only works on issues people write. A tester agent that explores
the target app and files what it finds would close the loop, but the naive
version fails in three predictable ways:

- **Noise.** Prose bug reports from a model include plausible false positives;
  each costs a dev run, and the dev agent may "fix" something that was fine.
- **Grading its own homework.** If the dev agent can edit the test that
  describes the bug, it can make the test agree with the code.
- **Healing hides bugs.** Tools that repair failing tests will repair a test
  that is failing because the app is broken.

## Decision

**A bug report is a failing test.** The tester files an issue only with a
Playwright test that reproduces the problem, and only if that test failed on
every one of three runs against current `main` (`--repeat-each=3`, no
retries). A test that sometimes passes is flaky and is not filed.

**Phase 1 uses no model.** The crawler records only what a program can
decide: uncaught page errors, console errors (not counting Chrome's lines for
failed requests, which are their own finding), failed same-origin requests,
links that lead nowhere, and serious or critical WCAG 2.1 A/AA violations
from axe-core. Repro tests come from templates, so each checks exactly the
observation.

**One finding, one fingerprint.** A fingerprint (category, page, normalized
signature: numbers, hashes and positions stripped) identifies a problem
across runs and builds. Open issues are matched by fingerprint, so the tester
never files the same problem twice, and a retried filing finds the issue an
earlier attempt created.

**The test is the requirement, and it is protected.** The issue's only
acceptance criterion is that the test passes as written, and the test is
embedded in the issue. At Planning the orchestrator accepts it only if the
issue's author is the factory's own App (`GitHubAppAuth.botLogin()`);
anyone else's embedded test is ignored, with an audit event saying so. The
worker commits the test before the implementer starts, and that commit is the
base the attempt is judged against, so `protected_paths` rejects any change
the implementer makes to `tests/regressions/`. The target's `e2e` gate runs it.

**A person approves the work.** Filed issues are labelled `found-by-tester`
and a severity. The dev loop starts on one only when a person runs it (or
labels it `factory`). Two agents feeding each other without that step is a
cost spiral.

**Everything is on record.** Each confirmed finding is a `tester.finding`
audit event, committed with the outbox message that files it; tester
messages belong to no run (migration 0006).

## Consequences

- The fix is judged by a test the implementer did not write: the gap seen in
  the first live PR, where traceability checked names rather than proof.
- Phase 1 finds only machine-checkable problems. It will miss wrong content,
  broken flows and logic errors; those are phase 2 (an exploratory agent
  using Playwright's planner, held to the same repro contract) and phase 3
  (mutation testing, chatbot red-teaming).
- Every regression test stays in the target forever. That is intended: a
  fixed bug that comes back fails its own test.
