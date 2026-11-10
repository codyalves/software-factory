# The tester

The tester crawls a running copy of the target app, confirms each problem
with a Playwright test that fails three times out of three, and files the
confirmed ones as issues that carry that test. The dev loop then has to make
the test pass without changing it. Design: [ADR 0006](adr/0006-tester.md).

## What it finds (phase 1)

| Finding | Severity | Repro test checks |
| --- | --- | --- |
| Uncaught page error | high | the page loads with no `pageerror` |
| Console error | medium | the page logs no console errors |
| Failed request (same origin) | high for 5xx, medium for 4xx | the page loads with no failed same-origin requests |
| Broken link | medium | the link target answers below 400 |
| Accessibility (axe, WCAG 2.1 A/AA) | high if critical, medium if serious | the page passes that axe rule |

No model is used, so a run costs nothing.

## Running it

Actions → **tester-run** → Run workflow. It builds the target's `main`,
crawls it and reports in the run summary. Tick **File issues** to file what
it confirms (at most *max issues* per run). Findings already open are skipped.

Locally, against a running target:

```bash
DATABASE_URL=postgres://localhost/factory node apps/tester/src/run-tester.ts \
  --repo codyalves/factory-target-app --base-url http://127.0.0.1:3000 \
  --workdir ../factory-target-app            # add --file to file issues
```

`--workdir` is a checkout of the target with dependencies installed; the
tester runs its repro tests there, with the target's own Playwright setup.

## From finding to fix

1. The tester files an issue labelled `found-by-tester` with the evidence, the
   regression test and one acceptance criterion: the test passes as written.
2. You decide whether it is worth fixing, and if so run **factory-run** on it.
3. At Planning the factory accepts the embedded test because the issue is by
   its own App; the worker commits it to the run's branch before any code.
4. The implementer fixes the app. Changing `tests/regressions/` fails the
   `protected_paths` gate; the target's `e2e` gate runs the test.
5. The PR's trace links the criterion to the regression test.
