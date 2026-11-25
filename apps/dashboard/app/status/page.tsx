import type { RunReport } from '@factory/db';
import type { Metadata } from 'next';
import Link from 'next/link';
import { AuditThread, isBookkeeping } from '@/components/audit-thread';
import { LiveRefresh } from '@/components/live-refresh';
import { StateStamp } from '@/components/stamps';
import { controlConfig, currentProject, readSite, recentSessions, sessionStep } from '@/lib/control';
import { factoryStatus, reports } from '@/lib/data';
import { shortSha, usd, utc } from '@/lib/format';
import { type CheckState, type StatusRun, splitSessions, statusView } from '@/lib/status-view';
import { targetSite } from '@/lib/targets';

export const metadata: Metadata = { title: 'Status' };

const CHECK_WORDS: Readonly<Record<CheckState, string>> = {
  success: 'Passing',
  failure: 'Failing',
  pending: 'Running',
  none: 'None reported',
};

const DEPLOY_WORDS: Readonly<Record<CheckState, string>> = {
  success: 'Deployed',
  failure: 'Deploy failed',
  pending: 'Deploying',
  none: 'Not reported',
};

/** How many runs get their latest events shown; each costs a full read of its record. */
const DETAILED_RUNS = 3;
const EVENTS_PER_RUN = 5;

type Read<T> = { ok: true; value: T } | { ok: false; error: string };

/** A GitHub read that may fail without taking the rest of the page with it. */
async function read<T>(promise: Promise<T>): Promise<Read<T>> {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'unknown error' };
  }
}

function Check({ state, words }: { state: CheckState; words: Readonly<Record<CheckState, string>> }) {
  const tone = state === 'success' ? 'pass' : state === 'failure' ? 'fail' : 'muted';
  return <span className={tone}>{words[state]}</span>;
}

function RunCard({ run, report, anyRepo }: { run: StatusRun; report: RunReport | null; anyRepo: boolean }) {
  const attempt = report?.attempts.at(-1);
  const failed = attempt?.gates.filter((g) => !g.passed) ?? [];
  const events = (report?.events ?? [])
    .filter((e) => !isBookkeeping(e.type))
    .slice(-EVENTS_PER_RUN)
    .reverse();
  return (
    <article className="attempt status-run">
      <header>
        <h3>
          <Link href={`/runs/${run.id}`}>
            {anyRepo ? `${run.repo}#${run.issueNumber}` : `#${run.issueNumber}`} {run.title}
          </Link>
        </h3>
        <StateStamp state={run.state} />
        <span className="muted">Last change {utc(run.updatedAt)}</span>
      </header>
      <dl className="fields">
        <div>
          <dt>Attempts</dt>
          <dd>{run.implementAttempts}</dd>
        </div>
        <div>
          <dt>Latest checks</dt>
          <dd>
            {!attempt || attempt.gates.length === 0 ? (
              <span className="muted">Not checked yet</span>
            ) : failed.length === 0 ? (
              <span className="pass">All {attempt.gates.length} passed</span>
            ) : (
              <span className="fail">Failed: {failed.map((g) => g.gate).join(', ')}</span>
            )}
          </dd>
        </div>
        <div>
          <dt>Pull request</dt>
          <dd>
            {run.pullRequestUrl ? (
              <a href={run.pullRequestUrl}>#{run.pullRequestUrl.split('/').pop()}</a>
            ) : (
              <span className="muted">None yet</span>
            )}
          </dd>
        </div>
        <div>
          <dt>Spent</dt>
          <dd>{usd(run.spentUsd)}</dd>
        </div>
      </dl>
      {events.length > 0 ? (
        <>
          <p className="status-run-caption muted">
            Latest events, newest first. The <Link href={`/runs/${run.id}`}>run record</Link> has all of them.
          </p>
          <AuditThread events={events} />
        </>
      ) : null}
    </article>
  );
}

export default async function StatusPage() {
  const config = controlConfig();
  const repo = config ? await currentProject(config) : null;
  const [status, allRuns, sessions] = await Promise.all([
    factoryStatus(),
    reports().listRuns({ limit: 200 }),
    config ? read(recentSessions(config).then(splitSessions)) : Promise.resolve(null),
  ]);
  const runs = repo ? allRuns.filter((r) => r.repo === repo) : allRuns;
  const active = sessions?.ok ? sessions.value.active : null;
  const last = sessions?.ok ? sessions.value.last : null;
  // Without a session reading (no control panel, or GitHub did not answer), a
  // moving run cannot be told from one left behind, so it is shown as moving.
  const view = statusView(runs, sessions?.ok ? (active?.startedAt ?? null) : new Date(0).toISOString());
  const site = repo ? targetSite(repo) : null;
  const detailed = [...view.current, ...view.unfinished].slice(0, DETAILED_RUNS);

  const [step, github, reportList] = await Promise.all([
    config && active?.status === 'in_progress'
      ? sessionStep(config, active.id).catch(() => null)
      : Promise.resolve(null),
    config && repo && site ? read(readSite(config, repo, site)) : Promise.resolve(null),
    Promise.all(detailed.map((r) => reports().runReport(r.id))),
  ]);
  const reportFor = new Map(detailed.map((r, i) => [r.id, reportList[i] ?? null]));
  const runByPull = new Map(runs.flatMap((r) => (r.pullRequestUrl ? [[r.pullRequestUrl, r] as const] : [])));
  const head = github?.ok ? github.value.commits[0] : undefined;

  return (
    <>
      <header className="page-head">
        <h1>Status</h1>
        <p className="lede">
          What the factory is doing {repo ? `on ${repo} ` : ''}right now, and what is on the site. Start or
          stop a session from the <Link href="/backlog">backlog</Link>.
        </p>
        <LiveRefresh active={active !== null || view.current.length > 0} everyMs={15_000} />
      </header>

      <section className="panel-box" aria-labelledby="factory">
        <h2 id="factory">Factory</h2>
        <dl className="fields">
          <div>
            <dt>Session</dt>
            <dd>
              {active ? (
                <a href={active.url}>
                  {active.workflow}{' '}
                  {active.status === 'in_progress' ? `running since ${utc(active.startedAt)}` : 'queued'}
                </a>
              ) : !sessions ? (
                <span className="muted">Unknown: the control panel is not set up</span>
              ) : !sessions.ok ? (
                <span className="fail">GitHub did not answer: {sessions.error}</span>
              ) : (
                'Not running'
              )}
            </dd>
          </div>
          {active ? (
            <div>
              <dt>Step</dt>
              <dd>{step ?? <span className="muted">Between steps</span>}</dd>
            </div>
          ) : last ? (
            <div>
              <dt>Last session</dt>
              <dd>
                <a href={last.url}>Ended {utc(last.updatedAt)}</a>
                {last.conclusion && last.conclusion !== 'success'
                  ? `, ${last.conclusion.replace('_', ' ')}`
                  : ''}
              </dd>
            </div>
          ) : null}
          <div>
            <dt>Spent today</dt>
            <dd>
              {usd(status.spentTodayUsd)} of {usd(status.dailyBudgetUsd)}
            </dd>
          </div>
          <div>
            <dt>New work</dt>
            <dd>{status.paused ? 'Paused' : 'Accepted'}</dd>
          </div>
        </dl>
        {active ? (
          <p className="muted">
            Sessions share one slot across projects; the step names the project this one is working through.
          </p>
        ) : null}
      </section>

      <section aria-labelledby="now">
        <h2 id="now">Working on now</h2>
        {view.current.length === 0 ? (
          <div className="empty">
            {active
              ? 'The session is running, but no run on this project has changed since it started.'
              : 'Nothing is being built right now.'}
          </div>
        ) : (
          view.current.map((r) => (
            <RunCard key={r.id} run={r} report={reportFor.get(r.id) ?? null} anyRepo={!repo} />
          ))
        )}
      </section>

      {view.unfinished.length > 0 ? (
        <section aria-labelledby="unfinished">
          <h2 id="unfinished">Left unfinished</h2>
          <p className="lede">
            Started, and no session is working on them: a session ended or was stopped first. The next session
            cancels each one and runs its issue again.
          </p>
          {view.unfinished.map((r) => (
            <RunCard key={r.id} run={r} report={reportFor.get(r.id) ?? null} anyRepo={!repo} />
          ))}
        </section>
      ) : null}

      <section aria-labelledby="site">
        <h2 id="site">On the site</h2>
        {!config || !repo || !site ? (
          <div className="empty">
            The control panel is not set up on this dashboard, so it cannot read the site from GitHub (see
            docs/dashboard.md).
          </div>
        ) : !github?.ok ? (
          <div className="empty">
            The dashboard could not read {repo} from GitHub: {github?.error ?? 'unknown error'}.
          </div>
        ) : (
          <>
            <dl className="fields">
              <div>
                <dt>Live site</dt>
                <dd>
                  {site.production ? (
                    <a href={site.production.url}>{new URL(site.production.url).host}</a>
                  ) : (
                    <span className="muted">No production URL in gates/targets.json</span>
                  )}
                </dd>
              </div>
              <div>
                <dt>Latest on {site.baseBranch}</dt>
                <dd>
                  {head ? (
                    <>
                      <a href={head.url} className="mono">
                        {shortSha(head.sha)}
                      </a>{' '}
                      {utc(head.at)}
                    </>
                  ) : (
                    <span className="muted">No commits found</span>
                  )}
                </dd>
              </div>
              <div>
                <dt>Production deploy</dt>
                <dd>{head ? <Check state={head.deploy} words={DEPLOY_WORDS} /> : null}</dd>
              </div>
              <div>
                <dt>Checks on {site.baseBranch}</dt>
                <dd>{head ? <Check state={head.checks} words={CHECK_WORDS} /> : null}</dd>
              </div>
            </dl>

            <h3 className="status-sub">Open pull requests</h3>
            {github.value.pulls.length === 0 ? (
              <p className="muted">None open.</p>
            ) : (
              <div className="table-wrap">
                <table className="ledger">
                  <thead>
                    <tr>
                      <th scope="col">Pull request</th>
                      <th scope="col">Checks</th>
                      <th scope="col">Factory run</th>
                      <th scope="col">Opened</th>
                    </tr>
                  </thead>
                  <tbody>
                    {github.value.pulls.map((p) => {
                      const run = runByPull.get(p.url);
                      return (
                        <tr key={p.number}>
                          <td>
                            <a href={p.url}>#{p.number}</a> {p.title}
                            {p.draft ? <span className="muted"> (draft)</span> : null}
                            <div className="muted mono">{p.branch}</div>
                          </td>
                          <td>
                            <Check state={p.checks} words={CHECK_WORDS} />
                          </td>
                          <td>
                            {run ? (
                              <Link href={`/runs/${run.id}`}>
                                <StateStamp state={run.state} />
                              </Link>
                            ) : (
                              <span className="muted">Not from a run</span>
                            )}
                          </td>
                          <td className="muted">{utc(p.openedAt)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            <h3 className="status-sub">Latest commits on {site.baseBranch}</h3>
            <div className="table-wrap">
              <table className="ledger">
                <thead>
                  <tr>
                    <th scope="col">Commit</th>
                    <th scope="col">Checks</th>
                    <th scope="col">Production deploy</th>
                    <th scope="col">Committed</th>
                  </tr>
                </thead>
                <tbody>
                  {github.value.commits.map((c) => (
                    <tr key={c.sha}>
                      <td>
                        <a href={c.url} className="mono">
                          {shortSha(c.sha)}
                        </a>{' '}
                        {c.headline}
                      </td>
                      <td>
                        <Check state={c.checks} words={CHECK_WORDS} />
                      </td>
                      <td>
                        <Check state={c.deploy} words={DEPLOY_WORDS} />
                      </td>
                      <td className="muted">{utc(c.at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      <section className="feed" aria-labelledby="outcomes">
        <h2 id="outcomes">Latest outcomes</h2>
        {view.outcomes.length === 0 ? (
          <div className="empty">No run has finished{repo ? ` on ${repo}` : ''} yet.</div>
        ) : (
          <ol className="feed-list">
            {view.outcomes.map((r) => (
              <li key={r.id}>
                <StateStamp state={r.state} />
                <Link href={`/runs/${r.id}`}>
                  {repo ? `#${r.issueNumber}` : `${r.repo}#${r.issueNumber}`} {r.title}
                </Link>
                <span className="muted">{utc(r.updatedAt)}</span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </>
  );
}
