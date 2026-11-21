import type { Metadata } from 'next';
import Link from 'next/link';
import { StateStamp } from '@/components/stamps';
import { type BacklogRow, backlogView } from '@/lib/backlog-view';
import {
  activeSessions,
  type ControlConfig,
  controlConfig,
  currentOwner,
  latestRunsByIssue,
  openTargetIssues,
} from '@/lib/control';
import { factoryStatus } from '@/lib/data';
import { issueUrl, usd, utc } from '@/lib/format';
import { startSessionAction, stopSessionAction } from '../actions';

export const metadata: Metadata = { title: 'Backlog' };

async function readGitHub(config: ControlConfig) {
  const [issues, runs, sessions] = await Promise.all([
    openTargetIssues(config),
    latestRunsByIssue(config.targetRepo),
    activeSessions(config),
  ]);
  return { issues, runs, sessions };
}

type Search = { searchParams: Promise<{ filed?: string; started?: string; stopped?: string }> };

function Issue({ row, repo }: { row: BacklogRow; repo: string }) {
  return (
    <>
      <a href={issueUrl(repo, row.number)}>#{row.number}</a> {row.title}
    </>
  );
}

function LastRun({ row }: { row: BacklogRow }) {
  if (!row.run) return <span className="muted">Not run yet</span>;
  return (
    <>
      <Link href={`/runs/${row.run.id}`}>
        <StateStamp state={row.run.state} />
      </Link>
      {row.run.pullRequestUrl ? (
        <>
          {' '}
          <a href={row.run.pullRequestUrl}>pull request #{row.run.pullRequestUrl.split('/').pop()}</a>
        </>
      ) : null}
    </>
  );
}

export default async function BacklogPage({ searchParams }: Search) {
  const config = controlConfig();
  const notice = await searchParams;

  if (!config) {
    return (
      <>
        <header className="page-head">
          <h1>Backlog</h1>
        </header>
        <div className="empty">
          The control panel is not set up on this dashboard yet, so it cannot read the backlog or start the
          factory. The settings it needs are in <span className="mono">docs/dashboard.md</span>.
        </div>
      </>
    );
  }

  const [owner, status] = await Promise.all([currentOwner(), factoryStatus()]);
  let github: Awaited<ReturnType<typeof readGitHub>>;
  try {
    github = await readGitHub(config);
  } catch (error) {
    return (
      <>
        <header className="page-head">
          <h1>Backlog</h1>
        </header>
        <div className="empty">
          The dashboard could not read the backlog from GitHub:{' '}
          {error instanceof Error ? error.message : 'unknown error'}. Check the App's permissions and
          installation (docs/dashboard.md).
        </div>
      </>
    );
  }
  const { issues, runs, sessions } = github;
  const view = backlogView(issues, runs);
  const session = sessions[0] ?? null;

  return (
    <>
      <header className="page-head">
        <h1>Backlog</h1>
        <p className="lede">
          Open issues on <a href={`https://github.com/${config.targetRepo}/issues`}>{config.targetRepo}</a>,
          in the order the factory takes them. An issue is ready when it carries the{' '}
          <span className="mono">factory:ready</span> label; one that says “Depends on #N” waits for #N to
          close.
        </p>
      </header>

      {notice.filed ? (
        <p className="notice">
          Filed <a href={issueUrl(config.targetRepo, Number(notice.filed))}>#{notice.filed}</a>. It is ready
          for the next session.
        </p>
      ) : null}
      {notice.started ? <p className="notice">Session requested. GitHub starts it within a minute.</p> : null}
      {notice.stopped ? (
        <p className="notice">
          Session stopped. Any run it left unfinished is cancelled, and run again, when the next session
          starts.
        </p>
      ) : null}

      <section className="panel-box" aria-labelledby="session">
        <h2 id="session">Session</h2>
        <dl className="fields">
          <div>
            <dt>Now</dt>
            <dd>
              {session ? (
                <a href={session.url}>
                  {session.workflow}{' '}
                  {session.status === 'queued' ? 'queued' : `running since ${utc(session.startedAt)}`}
                </a>
              ) : (
                'Not running'
              )}
            </dd>
          </div>
          <div>
            <dt>Spent today</dt>
            <dd>
              {usd(status.spentTodayUsd)} of {usd(status.dailyBudgetUsd)}
            </dd>
          </div>
        </dl>
        {!owner ? (
          <p className="muted">
            <a href="/auth/login">Sign in with GitHub</a> as an owner to file requests and start or stop the
            factory.
          </p>
        ) : session ? (
          <form action={stopSessionAction} className="actions">
            <input type="hidden" name="runId" value={session.id} />
            <button type="submit" className="button button-quiet">
              Stop session
            </button>
            <span className="muted">
              Stops now. A run in progress is left unfinished; the next session cancels it and runs it again.
            </span>
          </form>
        ) : (
          <form action={startSessionAction} className="actions">
            <label className="field-inline">
              Issues, at most
              <input type="number" name="maxRuns" min={1} max={20} defaultValue={5} />
            </label>
            <label className="field-inline">
              Daily budget, USD
              <input type="number" name="dailyBudget" min={0.5} max={20} step={0.5} defaultValue={3} />
            </label>
            <button type="submit" className="button" disabled={view.next.length === 0}>
              Start session
            </button>
            {view.next.length === 0 ? <span className="muted">Nothing is ready to run.</span> : null}
          </form>
        )}
      </section>

      <section aria-labelledby="queue">
        <h2 id="queue">Up next</h2>
        {view.running.length + view.next.length === 0 ? (
          <div className="empty">
            Nothing is ready.{' '}
            {owner ? <Link href="/requests/new">File a request</Link> : 'File an issue labeled factory:ready'}{' '}
            to give the factory work.
          </div>
        ) : (
          <div className="table-wrap">
            <table className="ledger">
              <thead>
                <tr>
                  <th scope="col" className="num">
                    Order
                  </th>
                  <th scope="col">Issue</th>
                  <th scope="col">Last run</th>
                </tr>
              </thead>
              <tbody>
                {view.running.map((row) => (
                  <tr key={row.number}>
                    <td className="num">Now</td>
                    <td>
                      <Issue row={row} repo={config.targetRepo} />
                    </td>
                    <td>
                      <LastRun row={row} />
                    </td>
                  </tr>
                ))}
                {view.next.map((row, i) => (
                  <tr key={row.number}>
                    <td className="num">{i + 1}</td>
                    <td>
                      <Issue row={row} repo={config.targetRepo} />
                    </td>
                    <td>
                      <LastRun row={row} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {view.blocked.length > 0 ? (
        <section aria-labelledby="blocked">
          <h2 id="blocked">Waiting</h2>
          <p className="lede">Ready, but waiting for issues that are open and not in the queue.</p>
          <ul className="plain-list">
            {view.blocked.map((row) => (
              <li key={row.number}>
                <Issue row={row} repo={config.targetRepo} />{' '}
                <span className="muted">waits on {row.on.map((n) => `#${n}`).join(', ')}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {view.owner.length > 0 ? (
        <section aria-labelledby="owner">
          <h2 id="owner">For the owner</h2>
          <p className="lede">
            Work the factory tried and could not ship on its own: held for review, escalated, rejected or
            cancelled. Re-add <span className="mono">factory:ready</span> to an issue to try it again.
          </p>
          <div className="table-wrap">
            <table className="ledger">
              <thead>
                <tr>
                  <th scope="col">Issue</th>
                  <th scope="col">Last run</th>
                </tr>
              </thead>
              <tbody>
                {view.owner.map((row) => (
                  <tr key={row.number}>
                    <td>
                      <Issue row={row} repo={config.targetRepo} />
                    </td>
                    <td>
                      <LastRun row={row} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </>
  );
}
