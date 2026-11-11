# Hosting: a permanent record and a public dashboard

Without hosting, each factory-run and tester-run job uses a throwaway
database, and the audit log disappears when the job ends. This setup keeps the
record in one Postgres database that every run appends to, and serves the
dashboard from it, read-only, at a public URL.

| Piece | Where | Cost |
| --- | --- | --- |
| Factory database | [Neon](https://neon.com) Free plan: 1 GB storage, 100 compute-hours a month, scales to zero after 5 idle minutes | Free |
| Dashboard | [Vercel](https://vercel.com) Hobby plan, Next.js, Node 26 | Free |
| Factory runs | GitHub Actions, started by hand as before | Free (plus API credit for factory-run) |

Nothing here runs on a schedule: the database only wakes when a run or a
dashboard visitor needs it.

## 1. Create the database (Neon)

1. Sign up at https://neon.com (GitHub sign-in works) and create a project:
   - Name: `software-factory`
   - Postgres version: 16 or newer
   - Region: **AWS US East (N. Virginia)**, next to Vercel's default
     function region, so dashboard pages load quickly.
2. On the project dashboard, click **Connect**. Keep the database `neondb` and
   the owner role. Turn **Connection pooling off** and copy the connection
   string. This is the *direct* string for the factory.

## 2. Give it to the factory (GitHub)

Add a repository secret at
https://github.com/codyalves/software-factory/settings/secrets/actions/new

- Name: `FACTORY_DATABASE_URL`
- Value: the direct connection string from step 1.2

Then run Actions → **check-database**. It creates the tables (migrations),
verifies the audit chain and reports what is stored. It should end with
"Dashboard role: not created yet".

From now on factory-run and tester-run write here; each run's summary ends
with "Database: persistent".

## 3. Create the dashboard's read-only login (Neon)

In Neon, open **SQL Editor** and run the contents of
[`db/roles/dashboard-readonly.sql`](../db/roles/dashboard-readonly.sql),
replacing `CHANGE_ME` with a long random password (a password manager's
generator is ideal; letters and digits only keeps the URL simple). Keep it to
yourself: it goes only into Vercel in step 4.

The role can read every table and recompute the audit chain, and nothing
else; it is also read-only by default, so even a mistaken grant cannot let it
change data. A test applies this exact file and proves both.

Run **check-database** again: it should now say "Dashboard role: reads,
cannot write".

Build the dashboard's connection string: take Neon's connection string with
**Connection pooling on** (the host contains `-pooler`), and replace the user
and password with `factory_dashboard` and your password:

```
postgresql://factory_dashboard:YOUR_PASSWORD@ep-xxxx-pooler.us-east-1.aws.neon.tech/neondb?sslmode=require
```

## 4. Deploy the dashboard (Vercel)

1. Sign up at https://vercel.com with GitHub and choose **Add New → Project**.
   Import `codyalves/software-factory` (grant access to that repository only).
2. Configure:
   - **Root Directory:** `apps/dashboard` (Vercel detects Next.js)
   - **Environment Variables:**
     - `DATABASE_URL`: the read-only, pooled string from step 3
     - `ENABLE_EXPERIMENTAL_COREPACK`: `1` (installs the exact pnpm version
       the repository pins)
     - `DASHBOARD_PASSWORD`: optional; set it to require a password
3. Click **Deploy**. Vercel builds on Node 26, the version the factory uses.

Vercel redeploys whenever `main` changes. The dashboard only reads, so a
deployment can never change the record.

## 5. Fill it

Run **factory-run** on an issue and **tester-run**. Their runs, decisions,
gates, trace links and audit events now accumulate, and the dashboard shows
them. Earlier runs, from before the database existed, are not in it; their
reports are still in each workflow run's summary.

## If something is wrong

- **check-database fails to connect:** the secret is not the direct
  connection string, or has a typo. Copy it again from Neon's Connect dialog.
- **Dashboard shows an error page:** check the Vercel deployment's function
  logs. "permission denied" means the role script was not run, or was run
  before the first check-database created the tables; run it again.
- **The first page load after a quiet day is slow:** the database woke from
  scale-to-zero, which takes a moment. Later loads are fast.
