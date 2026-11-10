/**
 * The tester: crawls a running copy of the target app, confirms each problem
 * with a test that fails every time, and files the confirmed ones as issues
 * carrying that test. Nothing here uses a model, so a run costs nothing.
 *
 *   node apps/tester/src/run-tester.ts --repo codyalves/factory-target-app \
 *     --base-url http://127.0.0.1:3000 --workdir ../factory-target-app [--file]
 *
 * Without --file it reports what it would file and files nothing.
 * Env: DATABASE_URL; with --file also GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY.
 */
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import {
  AuditStore,
  appendAuditEvent,
  createDb,
  enqueueOutbox,
  FactoryControl,
  migrate,
  OutboxRelay,
} from '@factory/db';
import { type Finding, findingFingerprint, findingIssue } from '@factory/domain';
import { GitHubAppAuth, GitHubForge, parsePrivateKey } from '@factory/github';
import { z } from 'zod';
import { deliverNextOutbox } from '../../orchestrator/src/outbox.ts';
import { type Confirmation, confirmRepro } from './confirm.ts';
import { crawl } from './crawl.ts';
import { reproFor } from './repro.ts';

const { values: args } = parseArgs({
  options: {
    repo: { type: 'string' },
    'base-url': { type: 'string' },
    workdir: { type: 'string' },
    'max-pages': { type: 'string', default: '30' },
    'max-issues': { type: 'string', default: '10' },
    file: { type: 'boolean', default: false },
    actor: { type: 'string', default: process.env.GITHUB_ACTOR ?? 'tester' },
    report: { type: 'string' },
  },
});

const repo = z
  .string()
  .regex(/^[\w.-]+\/[\w.-]+$/)
  .parse(args.repo);
const baseUrl = z.url().parse(args['base-url']);
const workdir = z.string().min(1).parse(args.workdir);
const maxIssues = z.coerce.number().int().min(0).max(50).parse(args['max-issues']);
const env = z
  .object({
    DATABASE_URL: z.url(),
    MIGRATIONS_DIR: z.string().default('db/migrations'),
    GITHUB_APP_ID: z.string().optional(),
    GITHUB_APP_PRIVATE_KEY: z.string().optional(),
  })
  .parse(process.env);

const { db, pool, close } = createDb(env.DATABASE_URL);
await migrate(pool, env.MIGRATIONS_DIR);

let forge: GitHubForge | null = null;
if (args.file) {
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) {
    throw new Error('--file needs GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY');
  }
  forge = new GitHubForge({
    auth: new GitHubAppAuth({
      appId: env.GITHUB_APP_ID,
      privateKey: parsePrivateKey(env.GITHUB_APP_PRIVATE_KEY),
    }),
  });
}

interface Result {
  readonly finding: Finding;
  readonly fingerprint: string;
  readonly path: string;
  readonly confirmation: Confirmation;
  outcome: 'filed' | 'already open' | 'not confirmed' | 'over the limit' | 'would file';
  url?: string;
}

const started = Date.now();
console.error(`crawling ${baseUrl}`);
const { pages, observations } = await crawl(baseUrl, { maxPages: Number(args['max-pages']) });
console.error(`${pages.length} pages, ${observations.length} observations`);

const open = forge ? await forge.openFindings(repo) : [];
const results: Result[] = [];
for (const { finding, repro: spec } of observations) {
  const repro = reproFor(finding, spec);
  const fingerprint = findingFingerprint(finding);
  console.error(`confirming ${repro.path}`);
  const confirmation = await confirmRepro(repro, { workdir, baseUrl });
  const result: Result = { finding, fingerprint, path: repro.path, confirmation, outcome: 'not confirmed' };
  results.push(result);
  if (!confirmation.confirmed) continue;

  const existing = open.find((f) => f.fingerprint === fingerprint);
  if (existing) {
    result.outcome = 'already open';
    result.url = existing.url;
    continue;
  }
  if (results.filter((r) => r.outcome === 'filed' || r.outcome === 'would file').length >= maxIssues) {
    result.outcome = 'over the limit';
    continue;
  }
  result.outcome = forge ? 'filed' : 'would file';

  // The finding and the message that files it commit together.
  await db.transaction().execute(async (trx) => {
    await appendAuditEvent(trx, null, 'tester.finding', {
      repo,
      fingerprint,
      category: finding.category,
      page: finding.page,
      severity: finding.severity,
      repro: repro.path,
      confirmation,
      filed: forge !== null,
    });
    if (forge) {
      const issue = findingIssue(finding, repro, confirmation);
      await enqueueOutbox(trx, null, 'issue.create', { repo, ...issue, fingerprint });
    }
  });
}

if (forge) {
  const control = new FactoryControl(db);
  await control.resume(args.actor ?? 'tester');
  const relay = new OutboxRelay(db);
  for (let sent = await deliverNextOutbox(relay, forge); sent; sent = await deliverNextOutbox(relay, forge)) {
    console.error(sent);
  }
  await control.pause(args.actor ?? 'tester', 'tester run finished');
  const delivered = await db
    .selectFrom('outbox')
    .select(['payload', 'result'])
    .where('kind', '=', 'issue.create')
    .where('sent_at', 'is not', null)
    .execute();
  for (const row of delivered) {
    const fingerprint = (row.payload as { fingerprint?: string }).fingerprint;
    const url = (row.result as { url?: string } | null)?.url;
    const result = results.find((r) => r.fingerprint === fingerprint);
    if (result && url) result.url = url;
  }
}

const chainValid = (await new AuditStore(db).verifyInDatabase()).length === 0;
await close();

const count = (outcome: Result['outcome']) => results.filter((r) => r.outcome === outcome).length;
const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
const report = [
  `## Tester run: ${repo}`,
  '',
  `Crawled ${pages.length} pages of ${baseUrl} in ${Math.round((Date.now() - started) / 1000)} s. No model was used.`,
  '',
  `- Observed: ${results.length}`,
  `- Confirmed (failed ${results[0]?.confirmation.runs ?? 3} of ${results[0]?.confirmation.runs ?? 3} runs): ${results.filter((r) => r.confirmation.confirmed).length}`,
  `- ${forge ? 'Filed' : 'Would file'}: ${forge ? count('filed') : count('would file')}`,
  `- Already open: ${count('already open')}`,
  `- Audit chain: ${chainValid ? 'valid' : '**INVALID**'}`,
  '',
  ...(results.length === 0
    ? [
        'Nothing found: no uncaught errors, console errors, failed requests, broken links or serious accessibility violations.',
      ]
    : [
        '| Finding | Page | Severity | Confirmed | Outcome |',
        '| --- | --- | --- | --- | --- |',
        ...results.map(
          (r) =>
            `| ${cell(r.finding.category)}: ${cell(r.finding.summary)} | ${cell(r.finding.page)} | ${r.finding.severity} | ${r.confirmation.confirmed ? 'yes' : cell(r.confirmation.reason ?? 'no')} | ${r.url ? `[${r.outcome}](${r.url})` : r.outcome} |`,
        ),
      ]),
  '',
  `Pages crawled: ${pages.map((p) => `\`${p}\``).join(', ')}`,
].join('\n');

console.log(report);
if (args.report) await writeFile(args.report, `${report}\n`);
