import Link from 'next/link';
import { LiveRefresh } from '@/components/live-refresh';
import { SubmitButton } from '@/components/submit-button';
import { backlogView, type LatestRun } from '@/lib/backlog-view';
import {
  controlConfig,
  currentLogin,
  currentOwner,
  currentProject,
  openTargetIssues,
  readSite,
  recentSessions,
  sessionSteps,
} from '@/lib/control';
import { factoryStatus, reports } from '@/lib/data';
import { issueUrl, usd, utc } from '@/lib/format';
import { elapsed, plainState, STAGES, stageOf } from '@/lib/home-view';
import { plannerAvailable } from '@/lib/planner';
import { projectName } from '@/lib/projects';
import { read } from '@/lib/read';
import {
  approvalInProgress,
  type StatusRun,
  sessionProject,
  splitSessions,
  statusView,
} from '@/lib/status-view';
import { targetSite } from '@/lib/targets';
import { approveRunAction, setProjectAction, startSessionAction, stopSessionAction } from './actions';
import { PlanWorkspace } from './plan-workspace';

type Search = {
  searchParams: Promise<{ planned?: string; started?: string; stopped?: string; approved?: string }>;
};

const DEPLOY_WORDS = {
  success: 'the latest change is live',
  failure: 'the latest deploy failed',
  pending: 'the latest change is deploying',
  none: 'no deploy reported',
} as const;

/** One piece of work in the session pane: what it is, where it is, and anything to do about it. */
function Work({ run, note, children }: { run: StatusRun; note?: string; children?: React.ReactNode }) {
  const plain = plainState(run.state);
  const stage = stageOf(run.state);
  return (
    <li className="work">
      <span className={`work-dot tone-${plain.tone}`} aria-hidden="true" />
      <div className="work-body">
        <Link href={`/runs/${run.id}`} className="work-title">
          #{run.issueNumber} {run.title}
        </Link>
        <span className={`work-state tone-${plain.tone}`}>
          {plain.words}
          {stage !== null && run.implementAttempts > 1 ? `, attempt ${run.implementAttempts}` : ''}
          {note ? <span className="muted"> {note}</span> : null}
        </span>
        {stage !== null ? (
          <ol className="stages" aria-label="Progress">
            {STAGES.map((name, i) => (
              <li
                key={name}
                className={i < stage ? 'done' : i === stage ? 'on' : undefined}
                aria-current={i === stage ? 'step' : undefined}
              >
                {name}
              </li>
            ))}
          </ol>
        ) : null}
      </div>
      {children}
    </li>
  );
}

/** A GitHub read that failed: said plainly, with GitHub's own words one click away. */
function Unread({ what, error }: { what: string; error: string | undefined }) {
  return (
    <details className="unread">
      <summary>Could not read {what} from GitHub.</summary>
      <span className="mono">{error ?? 'unknown error'}</span>
    </details>
  );
}

/**
 * Home: choose a project (the rail), say what it should do next, start a
 * session, and watch it. The left pane is asking; the right pane is the
 * session, always in view. Everything here is also on the fuller pages
 * (backlog, status, runs); this is the path through them.
 */
export default async function HomePage({ searchParams }: Search) {
  const notice = await searchParams;
  const config = controlConfig();
  const [owner, login, status, allRuns] = await Promise.all([
    currentOwner(),
    currentLogin(),
    factoryStatus(),
    reports().listRuns({ limit: 200 }),
  ]);
  const repo = config ? await currentProject(config) : null;
  const sessions = config ? await read(recentSessions(config).then(splitSessions)) : null;
  const active = sessions?.ok ? sessions.value.active : null;
  const last = sessions?.ok ? sessions.value.last : null;
  const steps =
    config && active?.status === 'in_progress'
      ? await sessionSteps(config, active.id).catch(() => null)
      : null;

  // Sessions share one slot across projects. One running on another project
  // is said plainly, with a way over to it, rather than shown as this one's.
  const working = active ? sessionProject(steps?.names ?? [], allRuns, active.startedAt) : null;
  const elsewhere = working && repo && working !== repo ? working : null;
  const runs = repo ? allRuns.filter((r) => r.repo === repo) : allRuns;
  const view = statusView(runs, elsewhere ? null : (active?.startedAt ?? null), {
    sessionKnown: sessions?.ok === true,
    outcomeLimit: 5,
  });
  const site = repo ? targetSite(repo) : null;

  const [issues, github] = await Promise.all([
    config && repo ? read(openTargetIssues(config, repo)) : Promise.resolve(null),
    config && repo && site ? read(readSite(config, repo, site)) : Promise.resolve(null),
  ]);
  const latest = new Map<number, LatestRun>();
  for (const r of runs) {
    if (!latest.has(r.issueNumber)) {
      latest.set(r.issueNumber, { id: r.id, state: r.state, pullRequestUrl: r.pullRequestUrl });
    }
  }
  const backlog = issues?.ok ? backlogView(issues.value, latest) : null;
  const ready = backlog ? backlog.next.length : 0;
  const here = active && !elsewhere ? active : null;
  const finished = view.session.filter((r) => r.state !== 'Reviewing');
  const earlier = view.outcomes.filter((r) => r.state !== 'Reviewing');
  const deploy = github?.ok ? github.value.commits[0]?.deploy : undefined;
  const name = repo ? projectName(repo) : 'the site';
  // An approval runs in the same slot as a session, but it is not one: it
  // ships one held change, so it is shown on that change, not as a session.
  const approving = here?.workflow === 'factory-approve';
  const approvingId = approving ? approvalInProgress(steps?.names ?? []) : null;
  const heldNumbers = new Set(view.held.map((r) => r.issueNumber));
  const waitingOn = (issueNumber: number) =>
    (backlog?.blocked ?? []).filter((b) => b.on.includes(issueNumber)).map((b) => b.number);
  const openPulls = github?.ok ? new Set(github.value.pulls.map((pull) => pull.url)) : null;
  const shown = view.current.length + finished.length + view.unfinished.length;

  return (
    <>
      <header className="page-head home-head">
        <h1>{repo ? name : 'Software factory'}</h1>
        {site?.production ? (
          <p className="lede">
            <a href={site.production.url}>{new URL(site.production.url).host}</a>
            {deploy ? <span className="muted">: {DEPLOY_WORDS[deploy]}</span> : null}
          </p>
        ) : null}
        <LiveRefresh active={active !== null || view.current.length > 0} everyMs={10_000} />
      </header>

      {notice.planned ? (
        <p className="notice" role="status">
          Added to the queue: {notice.planned.split(',').filter(Boolean).length} issue(s). Start a session to
          build them.
        </p>
      ) : null}
      {notice.started ? (
        <p className="notice" role="status">
          Session requested. GitHub starts it within a minute, and it shows on the right.
        </p>
      ) : null}
      {notice.stopped ? (
        <p className="notice" role="status">
          Session stopped. Work it left unfinished runs again in the next session.
        </p>
      ) : null}
      {notice.approved && /^\d+$/.test(notice.approved) ? (
        <p className="notice" role="status">
          Approval sent for #{notice.approved}. The factory records it and merges the change once its checks
          pass.
        </p>
      ) : null}

      <div className="home">
        <div className="home-ask">
          <section className="pane" aria-labelledby="ask">
            <h2 id="ask">What should {name} do next?</h2>
            {!config || !repo ? (
              <p className="muted">
                The control panel is not set up on this dashboard, so it can show the record but not take
                requests or start sessions (docs/dashboard.md).
              </p>
            ) : !owner ? (
              <p className="muted">
                {login ? (
                  <>
                    Signed in as {login}, who is not an owner of this factory, so this account can only read.
                  </>
                ) : (
                  <>
                    <a href="/auth/login">Sign in with GitHub</a> as an owner to ask for work and start
                    sessions.
                  </>
                )}
              </p>
            ) : !plannerAvailable() ? (
              <p className="muted">
                Describing work in plain words needs <span className="mono">ANTHROPIC_API_KEY</span> on the
                dashboard. Until then, <Link href="/requests/new">write one issue yourself</Link>.
              </p>
            ) : (
              <PlanWorkspace repo={repo} />
            )}
          </section>

          <section className="pane" aria-labelledby="queue">
            <div className="pane-head">
              <h2 id="queue">Queue</h2>
              <span className="muted">
                {backlog ? `${ready} ready` : ''}
                {repo ? (
                  <>
                    {backlog ? ' · ' : ''}
                    <Link href="/backlog">Details</Link>
                  </>
                ) : null}
              </span>
            </div>
            {!config || !repo ? (
              <p className="muted">The queue is read from GitHub, which needs the control panel.</p>
            ) : !issues?.ok ? (
              <Unread what="the queue" error={issues?.error} />
            ) : !backlog || backlog.running.length + backlog.next.length + backlog.blocked.length === 0 ? (
              <p className="muted">Nothing is queued. Describe something above to add work.</p>
            ) : (
              <ol className="queue">
                {backlog.running.map((row) => (
                  <li key={row.number}>
                    <a href={issueUrl(repo, row.number)}>#{row.number}</a> {row.title}{' '}
                    <span className="tone-now">building now</span>
                  </li>
                ))}
                {backlog.next.map((row) => (
                  <li key={row.number}>
                    <a href={issueUrl(repo, row.number)}>#{row.number}</a> {row.title}
                  </li>
                ))}
                {backlog.blocked.map((row) => (
                  <li key={row.number} className="queue-waiting">
                    <a href={issueUrl(repo, row.number)}>#{row.number}</a> {row.title}{' '}
                    <span className="muted">
                      waits on {row.on.map((n) => `#${n}`).join(', ')}
                      {row.on.some((n) => heldNumbers.has(n)) ? ', which needs your approval' : ''}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>

        <div className="home-watch">
          {view.held.length > 0 ? (
            <section className="pane pane-attention" aria-labelledby="approvals">
              <div className="pane-head">
                <h2 id="approvals">Needs your approval</h2>
                <span className="muted">{view.held.length} waiting</span>
              </div>
              <p className="muted">
                The factory finished these and every check passed, but it rated them high risk, so it will not
                ship them without you. Approving ships the change; nothing needs doing on GitHub.
              </p>
              <ol className="works">
                {view.held.map((r) => {
                  const blocks = waitingOn(r.issueNumber);
                  const closed =
                    openPulls !== null && r.pullRequestUrl !== null && !openPulls.has(r.pullRequestUrl);
                  const underway = approvingId === r.id;
                  return (
                    <li key={r.id} className="work">
                      <span className="work-dot tone-wait" aria-hidden="true" />
                      <div className="work-body">
                        <Link href={`/runs/${r.id}`} className="work-title">
                          #{r.issueNumber} {r.title}
                        </Link>
                        <span className="work-state">
                          {underway ? (
                            <span className="tone-now">Approved: merging once its checks pass.</span>
                          ) : closed ? (
                            <span className="muted">
                              Its pull request is no longer open on GitHub. Approving updates the record to
                              match.
                            </span>
                          ) : (
                            <span className="muted">Ready to ship when you approve.</span>
                          )}
                          {blocks.length > 0 ? (
                            <span className="tone-wait">
                              {' '}
                              Holding up {blocks.map((n) => `#${n}`).join(', ')}.
                            </span>
                          ) : null}{' '}
                          <Link href={`/runs/${r.id}`}>Why it was held</Link>
                        </span>
                      </div>
                      {owner && !underway ? (
                        <form action={approveRunAction}>
                          <input type="hidden" name="runId" value={r.id} />
                          <input type="hidden" name="from" value="home" />
                          <SubmitButton pending="Approving…" className="button button-soft">
                            {closed ? 'Update record' : 'Approve and ship'}
                          </SubmitButton>
                        </form>
                      ) : null}
                    </li>
                  );
                })}
              </ol>
              {!owner ? <p className="muted">Sign in as an owner to approve.</p> : null}
            </section>
          ) : null}

          <section className="pane home-session" aria-labelledby="session">
            <div className="pane-head">
              <h2 id="session">Session</h2>
              <span className="muted">
                {usd(status.spentTodayUsd)} of {usd(status.dailyBudgetUsd)} today ·{' '}
                <Link href="/status">Details</Link>
              </span>
            </div>

            {!sessions ? (
              <p className="muted">Sessions are read from GitHub, which needs the control panel.</p>
            ) : !sessions.ok ? (
              <Unread what="sessions" error={sessions.error} />
            ) : elsewhere ? (
              <form action={setProjectAction} className="session-now">
                <p>
                  A session is running on <strong>{elsewhere}</strong>, so none can start here until it ends.
                </p>
                <input type="hidden" name="back" value="/" />
                <button type="submit" name="project" value={elsewhere} className="button button-soft">
                  Switch to {projectName(elsewhere)}
                </button>
              </form>
            ) : here && approving ? (
              <div className="session-now">
                <p>
                  <strong className="tone-now">
                    {here.status === 'in_progress' ? 'Shipping an approved change' : 'Approval queued'}
                  </strong>
                  <span className="muted">
                    {' '}
                    {here.status === 'in_progress'
                      ? 'This takes a minute or two. A session can start when it is done.'
                      : 'GitHub starts it within a minute.'}
                  </span>
                </p>
              </div>
            ) : here ? (
              <div className="session-now">
                <p>
                  <strong className="tone-now">
                    {here.status === 'in_progress'
                      ? `Running for ${elapsed(here.startedAt, Date.now())}`
                      : 'Starting: GitHub picks it up within a minute'}
                  </strong>
                  {here.status === 'in_progress' && view.current.length === 0 ? (
                    <span className="muted">
                      {' '}
                      Between issues: choosing the next one, or waiting on a deploy and testing the live site.
                    </span>
                  ) : null}
                </p>
                {owner ? (
                  <form action={stopSessionAction}>
                    <input type="hidden" name="runId" value={here.id} />
                    <input type="hidden" name="from" value="home" />
                    <SubmitButton pending="Stopping…" className="button button-quiet">
                      Stop session
                    </SubmitButton>
                  </form>
                ) : null}
              </div>
            ) : (
              <div className="session-now">
                <p className="muted">
                  Not running.{last ? ` The last session ended ${utc(last.updatedAt)}.` : ''}
                </p>
                {owner ? (
                  <form action={startSessionAction} className="session-start">
                    <input type="hidden" name="from" value="home" />
                    <SubmitButton pending="Starting…" disabled={ready === 0}>
                      Start session
                    </SubmitButton>
                    <span className="muted">
                      {ready > 0
                        ? `Builds the ${ready} ready, in order.`
                        : view.held.length > 0 && (backlog?.blocked.length ?? 0) > 0
                          ? 'Nothing is ready: the queue is waiting on a change that needs your approval.'
                          : 'Nothing is ready to build.'}
                    </span>
                    <details>
                      <summary>Limits</summary>
                      <label className="field-inline">
                        Issues, at most
                        <input type="number" name="maxRuns" min={1} max={20} defaultValue={5} />
                      </label>
                      <label className="field-inline">
                        Daily budget, USD
                        <input
                          type="number"
                          name="dailyBudget"
                          min={0.5}
                          max={20}
                          step={0.5}
                          defaultValue={3}
                        />
                      </label>
                    </details>
                  </form>
                ) : null}
              </div>
            )}

            {shown > 0 ? (
              <ol className="works">
                {view.current.map((r) => (
                  <Work key={r.id} run={r} />
                ))}
                {finished.map((r) => (
                  <Work key={r.id} run={r} />
                ))}
                {view.unfinished.map((r) => (
                  <Work key={r.id} run={r} note="Left unfinished; the next session runs it again." />
                ))}
              </ol>
            ) : null}

            {earlier.length > 0 ? (
              <>
                <h3 className="works-earlier">{here ? 'Before this session' : 'Latest results'}</h3>
                <ol className="works">
                  {earlier.map((r) => (
                    <Work key={r.id} run={r} note={utc(r.updatedAt)} />
                  ))}
                </ol>
              </>
            ) : shown === 0 && view.held.length === 0 ? (
              <p className="muted">Nothing has been built{repo ? ` on ${name}` : ''} yet.</p>
            ) : null}
          </section>
        </div>
      </div>
    </>
  );
}
