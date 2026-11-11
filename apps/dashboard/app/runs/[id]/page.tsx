import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { AuditThread } from '@/components/audit-thread';
import { Risk, StateStamp, Verdict } from '@/components/stamps';
import { reports } from '@/lib/data';
import { commitUrl, issueUrl, percent, shortSha, testUrl, usd, utc } from '@/lib/format';

type Params = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const run = await reports().runReport((await params).id);
  return { title: run ? `#${run.issueNumber} ${run.title}` : 'Run not found' };
}

/** Triage questions in plain words. */
const QUESTION: Readonly<Record<string, string>> = {
  issue_type: 'What kind of work is it?',
  spec_ready: 'Can it be built and tested as written?',
  risk_auth: 'Does it touch sign-in or access?',
  risk_data: 'Does it touch stored or personal data?',
  risk_payments: 'Does it touch payments?',
  risk_platform: 'Does it touch dependencies, CI or deployment?',
  risk_existing_behavior: 'Does it change behavior people rely on?',
};

function Step({
  number,
  title,
  lede,
  children,
}: {
  number: number;
  title: string;
  lede?: string;
  children: ReactNode;
}) {
  return (
    <section className="step" aria-labelledby={`step-${number}`}>
      <div className="step-number" aria-hidden="true">
        {number}
      </div>
      <div className="step-body">
        <h2 id={`step-${number}`}>{title}</h2>
        {lede ? <p className="lede">{lede}</p> : null}
        {children}
      </div>
    </section>
  );
}

export default async function RunPage({ params }: Params) {
  const run = await reports().runReport((await params).id);
  if (!run) notFound();

  const last = run.timeline.at(-1);
  const finalAttempt = run.attempts.at(-1);
  const finalRisk = finalAttempt?.risk;
  const sections: { title: string; lede?: string; body: ReactNode }[] = [];

  if (run.decisions.length > 0) {
    sections.push({
      title: 'Triage',
      lede: `${run.decisions[0]?.engineVersion || run.decisions[0]?.engine} answered ${run.decisions.length} closed questions about the issue. Rules in code, not the model, turned the answers into a decision. An answer below ${percent(run.decisions[0]?.threshold ?? 0.8)} confidence takes the cautious default.`,
      body: (
        <>
          <div className="table-wrap">
            <table className="ledger">
              <thead>
                <tr>
                  <th scope="col">Question</th>
                  <th scope="col">Answer</th>
                  <th scope="col" className="num">
                    Confidence
                  </th>
                  <th scope="col">Used as given</th>
                </tr>
              </thead>
              <tbody>
                {run.decisions.map((d) => (
                  <tr key={d.question}>
                    <td>{QUESTION[d.question] ?? d.question}</td>
                    <td>{d.choice}</td>
                    <td className="num">{percent(d.probability)}</td>
                    <td>{d.confident ? 'Yes' : <span className="fail">No, fell back</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {run.triage && run.triage.fallbacks.length > 0 ? (
            <ul className="fallbacks">
              {run.triage.fallbacks.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          ) : null}
        </>
      ),
    });
  }

  if (run.criteria.length > 0) {
    sections.push({
      title: 'Acceptance criteria',
      lede: 'Numbered from the issue, so tests, commits and this record can refer to each one.',
      body: (
        <ol className="criteria">
          {run.criteria.map((c) => (
            <li key={c.id}>
              <span className="ac">{c.id}</span>
              <span>{c.text}</span>
            </li>
          ))}
        </ol>
      ),
    });
  }

  if (run.attempts.length > 0) {
    sections.push({
      title: run.attempts.length === 1 ? 'Attempt' : `${run.attempts.length} attempts`,
      lede: 'Each attempt is a commit on the run’s branch, checked in a fresh copy of the repository. A failed check goes back to the implementer with its output.',
      body: run.attempts.map((a) => {
        const failed = a.gates.filter((g) => !g.passed).length;
        return (
          <article key={a.attempt} className="attempt">
            <header>
              <h3>Attempt {a.attempt}</h3>
              <span className={failed === 0 ? 'pass' : 'fail'}>
                {a.gates.length === 0
                  ? 'Not checked yet'
                  : failed === 0
                    ? `All ${a.gates.length} checks passed`
                    : `${failed} of ${a.gates.length} checks failed`}
              </span>
              {a.commitSha ? (
                <span>
                  {a.committed ? null : <span className="fail">No new commit, still </span>}
                  <a className="mono" href={commitUrl(run.repo, a.commitSha)}>
                    {shortSha(a.commitSha)}
                  </a>
                </span>
              ) : null}
              {a.implementer ? <span className="muted">{a.implementer}</span> : null}
            </header>
            <ul className="gates">
              {a.gates.map((g) => (
                <li key={g.gate}>
                  <Verdict passed={g.passed} /> <span className="name">{g.gate}</span>{' '}
                  <span className="muted">{g.summary}</span>
                  {!g.passed && g.details ? (
                    <details className="output">
                      <summary>Output the implementer was given</summary>
                      <pre>{g.details}</pre>
                    </details>
                  ) : null}
                </li>
              ))}
            </ul>
            {a.risk ? (
              <div className="attempt-risk">
                Risk {a.risk.final}: predicted {a.risk.predicted ?? 'without triage'}, measured{' '}
                {a.risk.measured} from the files changed.
                {a.risk.reasons.length > 0 ? (
                  <ul>
                    {a.risk.reasons.map((r) => (
                      <li key={r}>
                        <code>{r}</code>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
          </article>
        );
      }),
    });
  }

  if (run.trace.some((t) => t.tests.length > 0)) {
    sections.push({
      title: 'Traceability',
      lede: 'Each criterion and the tests that name it, at the commit that passed every check.',
      body: (
        <div className="table-wrap">
          <table className="ledger">
            <thead>
              <tr>
                <th scope="col">Criterion</th>
                <th scope="col">Tests</th>
              </tr>
            </thead>
            <tbody>
              {run.trace.map((t) => (
                <tr key={t.criterionId}>
                  <td>
                    <span className="ac">{t.criterionId}</span> {t.criterion}
                  </td>
                  <td>
                    {t.tests.length === 0 ? (
                      <span className="fail">No test</span>
                    ) : (
                      t.tests.map((test) => (
                        <div key={test.testId}>
                          <a className="mono" href={testUrl(run.repo, test.testId, test.commitSha)}>
                            {test.testId}
                          </a>
                        </div>
                      ))
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ),
    });
  }

  if (run.messages.length > 0 || run.costByModel.length > 0) {
    sections.push({
      title: 'Delivery and cost',
      body: (
        <div className="table-wrap">
          <table className="ledger">
            <tbody>
              {run.messages.map((m) => (
                <tr key={`${m.kind}-${m.url ?? m.status}`}>
                  <td>{m.kind === 'pull_request.open' ? 'Pull request' : 'Comment on the issue'}</td>
                  <td>
                    {m.url ? <a href={m.url}>{m.url.replace('https://github.com/', '')}</a> : null}{' '}
                    {m.status === 'sent' ? null : (
                      <span className={m.status === 'failed' ? 'fail' : 'muted'}>
                        {m.status === 'failed' ? `Failed: ${m.error}` : 'Waiting to send'}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
              {run.costByModel.map((c) => (
                <tr key={c.model}>
                  <td>{c.model}</td>
                  <td>
                    {usd(c.usd)} over {c.calls} {c.calls === 1 ? 'call' : 'calls'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ),
    });
  }

  return (
    <article>
      <header className="record-head">
        <a className="issue-ref" href={issueUrl(run.repo, run.issueNumber)}>
          {run.repo}#{run.issueNumber}
        </a>
        <h1>{run.title}</h1>
        <div>
          <StateStamp state={run.state} />
          {last ? <span className="muted"> {last.reason}</span> : null}
        </div>
      </header>

      <dl className="fields">
        <div>
          <dt>Risk</dt>
          <dd>
            <Risk level={run.riskLevel} />
          </dd>
        </div>
        <div>
          <dt>Spent</dt>
          <dd>
            {usd(run.spentUsd)} of {usd(run.budgetUsd)}
          </dd>
        </div>
        <div>
          <dt>Attempts</dt>
          <dd>{run.implementAttempts} of 4</dd>
        </div>
        <div>
          <dt>Pull request</dt>
          <dd>
            {run.pullRequestUrl ? (
              <a href={run.pullRequestUrl}>#{run.pullRequestUrl.split('/').pop()}</a>
            ) : (
              'None'
            )}
          </dd>
        </div>
        <div>
          <dt>Branch</dt>
          <dd>
            {run.branch ? (
              <a className="mono" href={`https://github.com/${run.repo}/tree/${run.branch}`}>
                {run.branch}
              </a>
            ) : (
              'None'
            )}
          </dd>
        </div>
        <div>
          <dt>Started</dt>
          <dd>{utc(run.createdAt)}</dd>
        </div>
        <div>
          <dt>Run</dt>
          <dd className="mono">{run.id}</dd>
        </div>
        {finalRisk ? (
          <div>
            <dt>Risk, predicted and measured</dt>
            <dd>
              {finalRisk.predicted ?? 'none'} and {finalRisk.measured}
            </dd>
          </div>
        ) : null}
      </dl>

      {sections.map((s, i) => (
        <Step key={s.title} number={i + 1} title={s.title} {...(s.lede ? { lede: s.lede } : {})}>
          {s.body}
        </Step>
      ))}

      <section aria-labelledby="trail">
        <h2 id="trail" style={{ marginBottom: '0.5rem' }}>
          Audit trail
        </h2>
        <p className="lede" style={{ marginBottom: '1.25rem' }}>
          This run’s {run.events.length} events in the factory-wide chain. Each hash covers the event and the
          hash before it, so changing any past event breaks every hash after it.{' '}
          <Link href="/audit">Check the whole chain</Link>.
        </p>
        <AuditThread events={run.events} />
      </section>
    </article>
  );
}
