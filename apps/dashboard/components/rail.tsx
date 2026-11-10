import Link from 'next/link';
import { factoryStatus, reports } from '@/lib/data';
import { usd } from '@/lib/format';
import { Nav } from './nav';

/** The left rail: where you are, and the factory's state right now. */
export async function Rail() {
  const [status, audit] = await Promise.all([factoryStatus(), reports().auditSummary(1)]);
  const intact = audit.problems.length === 0;
  return (
    <aside className="rail">
      <Link href="/" className="rail-name">
        Software factory
        <span>Run records</span>
      </Link>
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
    </aside>
  );
}
