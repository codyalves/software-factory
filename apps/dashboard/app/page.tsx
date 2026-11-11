import Link from 'next/link';
import { Risk, StateStamp } from '@/components/stamps';
import { reports } from '@/lib/data';
import { usd, utc } from '@/lib/format';

export default async function RunsPage() {
  const runs = await reports().listRuns({ limit: 200 });
  const shipped = runs.filter((r) => r.pullRequestUrl).length;
  const spent = runs.reduce((sum, r) => sum + r.spentUsd, 0);

  return (
    <>
      <header className="page-head">
        <h1>Runs</h1>
        <p className="lede">
          {runs.length === 0
            ? 'Every issue the factory picks up gets a run, recorded here step by step.'
            : `${runs.length} ${runs.length === 1 ? 'issue' : 'issues'} picked up, ${shipped} turned into a pull request, ${usd(spent)} spent in total.`}
        </p>
      </header>

      {runs.length === 0 ? (
        <div className="empty">
          No runs yet. Start one from the factory-run workflow with an issue number, and its record will
          appear here.
        </div>
      ) : (
        <div className="table-wrap">
          <table className="ledger">
            <thead>
              <tr>
                <th scope="col">Issue</th>
                <th scope="col">State</th>
                <th scope="col">Risk</th>
                <th scope="col" className="num">
                  Attempts
                </th>
                <th scope="col" className="num">
                  Spent
                </th>
                <th scope="col">Pull request</th>
                <th scope="col">Last change</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Link href={`/runs/${r.id}`}>{r.title}</Link>
                    <div className="muted">
                      {r.repo}#{r.issueNumber}
                    </div>
                  </td>
                  <td>
                    <StateStamp state={r.state} />
                  </td>
                  <td>
                    <Risk level={r.riskLevel} />
                  </td>
                  <td className="num">{r.implementAttempts}</td>
                  <td className="num">{usd(r.spentUsd)}</td>
                  <td>
                    {r.pullRequestUrl ? (
                      <a href={r.pullRequestUrl}>#{r.pullRequestUrl.split('/').pop()}</a>
                    ) : (
                      <span className="muted">None</span>
                    )}
                  </td>
                  <td className="muted">{utc(r.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
