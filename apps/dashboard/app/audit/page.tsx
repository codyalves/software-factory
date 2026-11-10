import type { Metadata } from 'next';
import { AuditThread } from '@/components/audit-thread';
import { reports } from '@/lib/data';
import { utc } from '@/lib/format';

export const metadata: Metadata = { title: 'Audit log' };

export default async function AuditPage() {
  const audit = await reports().auditSummary(100);
  const intact = audit.problems.length === 0;

  return (
    <>
      <header className="page-head">
        <h1>Audit log</h1>
        <p className="lede">
          Every state change, decision, check and message the factory makes is appended to one chain. Each
          event stores a SHA-256 hash of its contents and the event before it, and the database refuses edits
          and deletions.
        </p>
      </header>

      <div className={`seal${intact ? '' : ' broken'}`} role="status">
        <span className="seal-mark" aria-hidden="true">
          {intact ? '✓' : '!'}
        </span>
        <div>
          <strong>
            {intact
              ? `The chain verifies: all ${audit.events} events recomputed just now.`
              : `The chain does not verify: ${audit.problems.length} ${audit.problems.length === 1 ? 'problem' : 'problems'}.`}
          </strong>
          {audit.firstAt && audit.lastAt ? (
            <span className="muted">
              From {utc(audit.firstAt)} to {utc(audit.lastAt)}. Latest hash{' '}
              <span className="mono">{audit.headHash?.slice(0, 24)}</span>
            </span>
          ) : (
            <span className="muted">No events yet.</span>
          )}
        </div>
      </div>

      {!intact ? (
        <div className="table-wrap" style={{ marginBottom: '2rem' }}>
          <table className="ledger">
            <thead>
              <tr>
                <th scope="col">Event</th>
                <th scope="col">Problem</th>
              </tr>
            </thead>
            <tbody>
              {audit.problems.map((p) => (
                <tr key={`${p.seq}-${p.problem}`}>
                  <td>{p.seq}</td>
                  <td className="fail">{p.problem}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <h2 style={{ marginBottom: '1rem' }}>Latest {audit.recent.length} events</h2>
      <AuditThread events={audit.recent} showRun withDate />
    </>
  );
}
