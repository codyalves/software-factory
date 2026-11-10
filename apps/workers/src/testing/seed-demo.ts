/**
 * Fills a database with realistic runs for the dashboard: real intake, triage
 * rules, implement-and-gate loop, outbox and audit chain, with scripted
 * answers and implementers instead of the Claude API. Costs nothing.
 *
 *   DATABASE_URL=postgres://... node apps/workers/src/testing/seed-demo.ts
 *
 * Uses the repository name demo/juniper-ridge so no link points at real work.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb, migrate } from '@factory/db';
import {
  addMigration,
  addTracedTest,
  CLEAR_ANSWERS,
  createTargetRepo,
  fixYear,
  recordingForge,
  runScenario,
  scripted,
} from './scenario.ts';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set');
  process.exit(2);
}

const REPO = 'demo/juniper-ridge';
const { db, pool, close } = createDb(url);
await migrate(pool, process.env.MIGRATIONS_DIR ?? 'db/migrations');
const root = await mkdtemp(join(tmpdir(), 'seed-demo-'));

try {
  const remote = await createTargetRepo(root);
  // One pretend GitHub for every run, so pull request numbers keep counting up.
  const forge = recordingForge();
  const issue = (number: number, title: string, body: string) => ({
    repo: REPO,
    number,
    title,
    body,
    labels: ['factory'],
  });

  const scenarios = [
    {
      issue: issue(
        1,
        'Footer shows last year in the copyright line',
        'The footer says 2025.\n\n- Given any page, then the footer shows the current year\n- The year comes from the current date at render time',
      ),
      answers: { ...CLEAR_ANSWERS, issue_type: ['bug', 0.92] as const },
      implementer: scripted([addTracedTest], 0.31),
    },
    {
      issue: issue(
        2,
        'Show opening hours on the home page',
        '- The home page lists each day with its opening and closing time\n- Closed days say "closed"\n- Times use a 12-hour clock',
      ),
      answers: CLEAR_ANSWERS,
      // The first attempt writes no tests; the traceability gate sends it back.
      implementer: scripted([fixYear, addTracedTest], 0.42),
    },
    {
      issue: issue(
        3,
        'Store the year each site was founded',
        '- Sites have a founded year\n- The about section shows "Since <year>"',
      ),
      answers: { ...CLEAR_ANSWERS, risk_data: ['no', 0.86] as const },
      // Triage predicted low risk; the diff adds a migration and the risk is raised.
      implementer: scripted([addMigration], 0.55),
    },
    {
      issue: issue(
        4,
        'Footer year should follow the visitor time zone',
        '- The footer year matches the visitor local date\n- Covered by a test at the new year boundary',
      ),
      answers: { ...CLEAR_ANSWERS, risk_existing_behavior: ['no', 0.62] as const },
      // Never writes the tests: four attempts, then a person.
      implementer: scripted([fixYear], 0.38),
    },
    {
      issue: issue(5, 'Write my essay on the French Revolution', 'Need 1500 words by Friday, MLA format.'),
      answers: { ...CLEAR_ANSWERS, issue_type: ['reject', 0.97] as const },
      implementer: scripted([fixYear]),
    },
    {
      issue: issue(6, 'Chatbot should be smarter', 'Customers say the bot gives dumb answers sometimes.'),
      answers: {
        ...CLEAR_ANSWERS,
        spec_ready: ['no', 0.94] as const,
        risk_existing_behavior: ['yes', 0.9] as const,
      },
      implementer: scripted([fixYear]),
    },
  ];

  for (const s of scenarios) {
    const runId = await runScenario({ db, remote, forge, ...s });
    console.log(`#${s.issue.number} ${s.issue.title}: run ${runId}`);
  }
} finally {
  await rm(root, { recursive: true, force: true });
  await close();
}
