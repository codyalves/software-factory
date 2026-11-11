import type { Metadata } from 'next';
import Link from 'next/link';
import { Risk, StateStamp } from '@/components/stamps';
import { reports } from '@/lib/data';
import { issueUrl, testUrl } from '@/lib/format';

export const metadata: Metadata = { title: 'Traceability' };

export default async function TracePage() {
  const matrix = await reports().traceMatrix();
  const criteria = matrix.flatMap((r) => r.criteria);
  const covered = criteria.filter((c) => c.tests.length > 0).length;

  return (
    <>
      <header className="page-head">
        <h1>Traceability</h1>
        <p className="lede">
          Every requirement the factory has worked on, broken into its acceptance criteria, with the tests
          that prove each one and the commit they ran on.
          {criteria.length > 0 ? ` ${covered} of ${criteria.length} criteria are covered by a test.` : ''}
        </p>
      </header>

      {matrix.length === 0 ? (
        <div className="empty">No requirements yet. They appear here once the factory picks up an issue.</div>
      ) : (
        <div className="table-wrap">
          <table className="ledger">
            <thead>
              <tr>
                <th scope="col">Requirement</th>
                <th scope="col">Criterion</th>
                <th scope="col">Tests</th>
                <th scope="col">Commit</th>
              </tr>
            </thead>
            <tbody>
              {matrix.flatMap((req) => {
                const rows = req.criteria.length > 0 ? req.criteria : [null];
                return rows.map((c, i) => (
                  <tr key={`${req.requirementId}-${c?.criterionId ?? 'none'}`}>
                    {i === 0 ? (
                      <td rowSpan={rows.length}>
                        <a href={issueUrl(req.repo, req.issueNumber)}>
                          {req.repo}#{req.issueNumber}
                        </a>
                        <div>{req.title}</div>
                        <div
                          style={{ marginTop: '0.4rem', display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}
                        >
                          {req.latestState ? <StateStamp state={req.latestState} /> : null}
                          <Risk level={req.riskLevel} />
                        </div>
                        {req.latestRunId ? (
                          <div style={{ marginTop: '0.4rem' }}>
                            <Link href={`/runs/${req.latestRunId}`}>Run record</Link>
                            {req.pullRequestUrl ? (
                              <>
                                {', '}
                                <a href={req.pullRequestUrl}>
                                  pull request #{req.pullRequestUrl.split('/').pop()}
                                </a>
                              </>
                            ) : null}
                          </div>
                        ) : null}
                      </td>
                    ) : null}
                    {c ? (
                      <>
                        <td>
                          <span className="ac">{c.criterionId}</span> {c.criterion}
                        </td>
                        <td>
                          {c.tests.length === 0 ? (
                            <span className="fail">No test yet</span>
                          ) : (
                            c.tests.map((t) => (
                              <div key={t.testId}>
                                <a className="mono" href={testUrl(req.repo, t.testId, t.commitSha)}>
                                  {t.testId}
                                </a>
                              </div>
                            ))
                          )}
                        </td>
                        <td className="mono">{c.tests[0]?.commitSha.slice(0, 12) ?? ''}</td>
                      </>
                    ) : (
                      <td colSpan={3} className="muted">
                        No criteria: the run stopped before planning.
                      </td>
                    )}
                  </tr>
                ));
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
