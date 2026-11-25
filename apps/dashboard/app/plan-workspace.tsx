'use client';

import Link from 'next/link';
import { useActionState, useState } from 'react';
import { criteriaLines, type PlannedIssue, withoutIssue } from '@/lib/plan';
import { vagueCriteria } from '@/lib/request-check';
import { draftPlanAction, filePlanAction, type PlanState } from './actions';

const START: PlanState = { request: '', plan: null, checks: [], error: null };

/** Step one: describe the feature. Step two: edit the drafted issues and file them. */
export function PlanWorkspace({ repo }: { repo: string }) {
  const [drafted, draft, drafting] = useActionState(draftPlanAction, START);
  return drafted.plan ? (
    // Keyed by the plan so each new draft starts a fresh editor.
    <PlanEditor key={JSON.stringify(drafted.plan)} repo={repo} drafted={drafted} />
  ) : (
    <form action={draft} className="form plan-ask">
      <label className="field">
        <span>Feature</span>
        <span className="hint">
          What visitors should be able to do, in your own words. Mention pages, data or limits you care about.
        </span>
        <textarea
          name="request"
          rows={5}
          required
          minLength={20}
          maxLength={4000}
          defaultValue={drafted.request}
          placeholder="Let people build a deck: add cards from search, change quantities, keep a sideboard, and see the mana curve."
        />
      </label>
      {drafted.error ? (
        <p className="form-error" role="alert">
          {drafted.error}
        </p>
      ) : null}
      <div className="actions">
        <button type="submit" className="button" disabled={drafting}>
          {drafting ? 'Planning… (up to a minute)' : 'Plan it'}
        </button>
        <Link href="/requests/new">Write one issue yourself</Link>
      </div>
    </form>
  );
}

function PlanEditor({ repo, drafted }: { repo: string; drafted: PlanState }) {
  const [filedState, file, filing] = useActionState(filePlanAction, drafted);
  const [issues, setIssues] = useState<PlannedIssue[]>([...(drafted.plan?.issues ?? [])]);
  const [criteriaText, setCriteriaText] = useState(issues.map((i) => i.criteria.join('\n')));

  const update = (index: number, change: Partial<PlannedIssue>) =>
    setIssues((all) => all.map((issue, i) => (i === index ? { ...issue, ...change } : issue)));
  const remove = (index: number) => {
    setIssues((all) => withoutIssue(all, index));
    setCriteriaText((all) => all.filter((_, i) => i !== index));
  };
  const plan = JSON.stringify({ summary: drafted.plan?.summary ?? '', issues });
  const serverChecks = filedState.checks;

  return (
    <form action={file} className="plan">
      <input type="hidden" name="repo" value={repo} />
      <input type="hidden" name="plan" value={plan} />
      <div className="plan-head">
        <p>
          <strong>
            {issues.length} {issues.length === 1 ? 'issue' : 'issues'} for {repo}.
          </strong>{' '}
          {drafted.plan?.summary}
        </p>
        <p className="muted">
          Asked: “{drafted.request}”
          {drafted.usd !== undefined ? ` Planning cost $${drafted.usd.toFixed(3)}.` : ''}
        </p>
      </div>

      <ol className="plan-issues">
        {issues.map((issue, index) => {
          const vague = vagueCriteria(issue.criteria);
          const error = serverChecks[index]?.error;
          const id = `issue-${index}`;
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: issues have no identity but their place in the plan
            <li key={index} className="plan-issue" aria-labelledby={`${id}-n`}>
              <div className="plan-issue-head">
                <span id={`${id}-n`} className="plan-n">
                  Issue {index + 1}
                </span>
                <button type="button" className="link-button" onClick={() => remove(index)}>
                  Remove issue {index + 1}
                </button>
              </div>
              <label className="field">
                <span>Title</span>
                <input
                  value={issue.title}
                  maxLength={200}
                  required
                  onChange={(e) => update(index, { title: e.target.value })}
                />
              </label>
              <label className="field">
                <span>Description</span>
                <textarea
                  rows={3}
                  value={issue.description}
                  onChange={(e) => update(index, { description: e.target.value })}
                />
              </label>
              <label className="field">
                <span>Acceptance criteria</span>
                <span className="hint">One per line; each becomes a test.</span>
                <textarea
                  rows={Math.max(4, issue.criteria.length + 1)}
                  value={criteriaText[index] ?? ''}
                  onChange={(e) => {
                    const text = e.target.value;
                    setCriteriaText((all) => all.map((t, i) => (i === index ? text : t)));
                    update(index, { criteria: criteriaLines(text) });
                  }}
                />
              </label>
              {index > 0 ? (
                <fieldset className="plan-deps">
                  <legend>Builds after</legend>
                  {issues.slice(0, index).map((earlier, d) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: positions are the dependency ids
                    <label key={d} className="field-check">
                      <input
                        type="checkbox"
                        checked={issue.dependsOn.includes(d)}
                        onChange={(e) =>
                          update(index, {
                            dependsOn: e.target.checked
                              ? [...issue.dependsOn, d].sort()
                              : issue.dependsOn.filter((x) => x !== d),
                          })
                        }
                      />
                      Issue {d + 1}: {earlier.title}
                    </label>
                  ))}
                </fieldset>
              ) : null}
              {error ? (
                <p className="form-error" role="alert">
                  {error}
                </p>
              ) : null}
              {vague.length > 0 ? (
                <div className="plan-warn">
                  <p>Triage may stop on these criteria:</p>
                  <ul>
                    {vague.map((v) => (
                      <li key={v.criterion}>
                        <strong>{v.criterion}</strong>: {v.why}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>

      {filedState.error ? (
        <p className="form-error" role="alert">
          {filedState.error}
        </p>
      ) : null}
      <div className="actions">
        <button type="submit" className="button" disabled={filing || issues.length === 0}>
          {filing ? 'Filing…' : `File ${issues.length} ${issues.length === 1 ? 'issue' : 'issues'}`}
        </button>
        <a href="/">Start over</a>
      </div>
      <p className="muted">
        Each issue is filed ready for the factory, with its “Depends on” line, so a session builds them in
        order. Triage still checks every one before work starts.
      </p>
    </form>
  );
}
