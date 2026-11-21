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

## Control panel

With the settings below, the dashboard can also act: sign in with GitHub, file
a request (an issue labeled `factory:ready`), see the backlog in the order the
factory will take it, and start or stop a backlog session. Without them it
stays read-only, and every page still works.

How it stays safe:

- **Reading is public; acting needs an owner.** Sign-in is GitHub OAuth through
  the factory's App. The session is a signed, HTTP-only cookie holding only the
  login; the GitHub token is used once to learn the login and thrown away.
  Only logins in `DASHBOARD_OWNERS` can act, and every action checks that on
  the server.
- **Actions go through GitHub, never the database.** Filing a request creates
  an issue; starting a session dispatches the `factory-backlog` workflow with
  the owner's login as its actor; stopping cancels that workflow run. The
  dashboard's database login stays read-only, and the orchestrator stays the
  only writer of run state.
- **Requests cannot forge the factory's markers.** HTML comments are refused,
  and the description must be prose, so the acceptance criteria are exactly
  the ones listed.

### Set it up

1. **GitHub App** (https://github.com/settings/apps, then the factory's App):
   - **General:** set **Callback URL** to your dashboard's address plus
     `/auth/callback`, for example
     `https://software-factory-ten-smoky.vercel.app/auth/callback`. Under
     **Client secrets**, generate one and keep it for step 2. Note the **Client ID**.
   - **Permissions & events:** set **Actions** to **Read and write**, so the
     panel can start and stop sessions. Save, then accept the new permission
     for the installation.
   - **Install App:** add the `software-factory` repository to the
     installation, next to the target.
2. **Vercel** (the dashboard project, Settings, Environment Variables), then
   redeploy:

   | Variable | Value |
   | --- | --- |
   | `GITHUB_APP_ID` | The App's ID |
   | `GITHUB_APP_PRIVATE_KEY` | The App's private key (the whole `.pem`) |
   | `GITHUB_APP_CLIENT_ID` | The App's Client ID |
   | `GITHUB_APP_CLIENT_SECRET` | The client secret from step 1 |
   | `SESSION_SECRET` | 32 or more random characters, used only to sign sessions |
   | `DASHBOARD_OWNERS` | GitHub logins that may act, comma-separated |
   | `FACTORY_REPO`, `TARGET_REPO` | Optional; default to the factory and its target |

## Design

The pages are set like a regulated batch record rather than an admin panel:
a form-grey sheet, blue-black ink, ballpoint blue for links, and green or red
only for a verdict. Public Sans throughout, monospace only for hashes, SHAs
and test ids. The run record is numbered because a run is a sequence; the
audit trail is drawn as one continuous thread because the chain is one.
