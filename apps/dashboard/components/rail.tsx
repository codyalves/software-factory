import Link from 'next/link';
import { setProjectAction } from '@/app/actions';
import { controlConfig, currentLogin, currentProject } from '@/lib/control';
import { factoryStatus, reports } from '@/lib/data';
import { usd } from '@/lib/format';
import { projectName } from '@/lib/projects';
import { Nav } from './nav';

/** The left rail: where you are, and the factory's state right now. */
export async function Rail() {
  const [status, audit, login] = await Promise.all([
    factoryStatus(),
    reports().auditSummary(1),
    currentLogin(),
  ]);
  const intact = audit.problems.length === 0;
  const config = controlConfig();
  const project = config ? await currentProject(config) : null;
  return (
    <aside className="rail">
      <Link href="/" className="rail-name">
        Software factory
        <span>Run records</span>
      </Link>
      {config && project && config.projects.length > 1 ? (
        <form action={setProjectAction} className="rail-projects" aria-label="Project">
          <input type="hidden" name="back" value="/" />
          <span className="rail-projects-label">Project</span>
          {config.projects.map((p) => (
            <button key={p} type="submit" name="project" value={p} aria-pressed={p === project} title={p}>
              {projectName(p)}
            </button>
          ))}
        </form>
      ) : null}
      <Nav />
      <dl className="rail-status">
        <div>
          <dt>Factory</dt>
          <dd>{status.paused ? 'Paused' : 'Running'}</dd>
        </div>
        <div>
          <dt>Spent today</dt>
          <dd>
            {usd(status.spentTodayUsd)} of {usd(status.dailyBudgetUsd)}
          </dd>
        </div>
        <div>
          <dt>Audit chain</dt>
          <dd className="rail-seal">
            <Link href="/audit" className={intact ? 'pass' : 'fail'}>
              {intact ? `Intact, ${audit.events} events` : `${audit.problems.length} problems`}
            </Link>
          </dd>
        </div>
      </dl>
      {config ? (
        <div className="rail-user">
          {login ? (
            <form action="/auth/logout" method="post">
              Signed in as {login}{' '}
              <button type="submit" className="link-button">
                Sign out
              </button>
            </form>
          ) : (
            <a href="/auth/login">Sign in with GitHub</a>
          )}
        </div>
      ) : null}
    </aside>
  );
}
