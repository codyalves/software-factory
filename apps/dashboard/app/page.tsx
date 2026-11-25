import Link from 'next/link';
import { LiveRefresh } from '@/components/live-refresh';
import { StateStamp } from '@/components/stamps';
import { activeSessions, controlConfig, currentLogin, currentOwner, currentProject } from '@/lib/control';
import { reports } from '@/lib/data';
import { utc } from '@/lib/format';
import { plannerAvailable } from '@/lib/planner';
import { projectName } from '@/lib/projects';
import { PlanWorkspace } from './plan-workspace';

const MOVING = new Set(['Intake', 'Triage', 'Planning', 'Implementing', 'Gating', 'Merging']);

/** The workspace: say what the site should do next, review the plan, file it, watch it build. */
export default async function WorkspacePage() {
  const config = controlConfig();
  const [owner, login] = await Promise.all([currentOwner(), currentLogin()]);
  const repo = config ? await currentProject(config) : null;
  const [runs, sessions] = await Promise.all([
    reports().listRuns({ limit: 200 }),
    config && owner ? activeSessions(config).catch(() => []) : Promise.resolve([]),
  ]);
  const recent = runs.filter((r) => r.repo === repo).slice(0, 8);
  const moving = sessions.length > 0 || recent.some((r) => MOVING.has(r.state));

  return (
    <>
      <header className="page-head">
        <h1>{repo ? `What should ${projectName(repo)} do next?` : 'Workspace'}</h1>
        <p className="lede">
          Describe a feature in plain words. The planner splits it into small issues, each with criteria a
          test can check. Edit the plan, file it, and the factory builds it in order.
        </p>
      </header>

      {!config || !repo ? (
        <div className="empty">
          The control panel is not set up on this dashboard yet (see docs/dashboard.md).
        </div>
      ) : !owner ? (
        <div className="empty">
          {login ? (
            <>Signed in as {login}, who is not an owner of this factory, so this account can only read. </>
          ) : (
            <>
              <a href="/auth/login">Sign in with GitHub</a> as an owner to plan work.{' '}
            </>
          )}
          Anyone can read the <Link href="/runs">runs</Link> and the <Link href="/backlog">backlog</Link>.
        </div>
      ) : !plannerAvailable() ? (
        <div className="empty">
          The planner needs <span className="mono">ANTHROPIC_API_KEY</span> on the dashboard. Until then,{' '}
          <Link href="/requests/new">write one issue yourself</Link>.
        </div>
      ) : (
        <PlanWorkspace repo={repo} />
      )}

      {repo ? (
        <section className="feed" aria-labelledby="feed">
          <div className="feed-head">
            <h2 id="feed">Building now</h2>
            <LiveRefresh active={moving} everyMs={10_000} />
          </div>
          {sessions.length > 0 ? (
            <p className="notice">
              A factory session is <a href={sessions[0]?.url}>{sessions[0]?.status.replace('_', ' ')}</a>.
              Stop it from the <Link href="/backlog">backlog</Link>.
            </p>
          ) : null}
          {recent.length === 0 ? (
            <div className="empty">
              Nothing has been built on {repo} yet. File a plan, then start a session from the{' '}
              <Link href="/backlog">backlog</Link>.
            </div>
          ) : (
            <ol className="feed-list">
              {recent.map((r) => (
                <li key={r.id}>
                  <StateStamp state={r.state} />
                  <Link href={`/runs/${r.id}`}>
                    #{r.issueNumber} {r.title}
                  </Link>
                  <span className="muted">{utc(r.updatedAt)}</span>
                </li>
              ))}
            </ol>
          )}
        </section>
      ) : null}
    </>
  );
}
