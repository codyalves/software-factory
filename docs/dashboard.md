# The dashboard

A read-only view of the factory's record: what it did with each issue, why,
and the evidence. It is a Next.js app (`apps/dashboard`) that reads Postgres
through `ReportStore` (`packages/db/src/report-store.ts`). It never writes,
pauses or spends.

| Page | Shows |
| --- | --- |
| Runs | Every issue picked up: state, risk, attempts, spend, pull request |
| Run record | One run in order: triage answers and how confident each was, the numbered acceptance criteria, every attempt with its check results and output, measured risk, the criterion-to-test trace, cost by model, and the run's events in the audit chain |
| Traceability | Every requirement, criterion by criterion, with the tests that prove it and the commit they ran on |
| Audit log | Whether the hash chain verifies (recomputed in Postgres on each view), and the latest events |

Everything on a page comes from tables the factory already keeps, so any
figure can be checked against its source.

## Run it locally

```bash
# Demo data: six issues through the real factory with scripted models. Costs nothing.
createdb factory_demo
DATABASE_URL=postgres://localhost/factory_demo pnpm seed:demo

DATABASE_URL=postgres://localhost/factory_demo pnpm dev:dashboard   # http://localhost:3100
```

The demo uses the repository name `demo/juniper-ridge`, so its links do not
point at real work.

## Point it at a real factory database

Give it a role that can only read: run
[`db/roles/dashboard-readonly.sql`](../db/roles/dashboard-readonly.sql) as
the database owner, with your own password. A test applies that exact file
and proves the role can render every view and change nothing. For the hosted
setup (Neon and Vercel), follow [hosting.md](hosting.md).

Set `DASHBOARD_PASSWORD` to require a password (HTTP basic auth, any user
name). Without it the dashboard is open, which suits local use or a public
demo of demo data.

## Design

The pages are set like a regulated batch record rather than an admin panel:
a form-grey sheet, blue-black ink, ballpoint blue for links, and green or red
only for a verdict. Public Sans throughout, monospace only for hashes, SHAs
and test ids. The run record is numbered because a run is a sequence; the
audit trail is drawn as one continuous thread because the chain is one.
