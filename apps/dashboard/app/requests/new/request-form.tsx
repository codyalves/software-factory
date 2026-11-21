'use client';

import { useActionState } from 'react';
import { fileRequestAction, type RequestFormState } from '../../actions';

const EMPTY: RequestFormState = {
  error: null,
  values: { title: '', description: '', criteria: '', dependsOn: '' },
};

export function RequestForm() {
  const [state, action, pending] = useActionState(fileRequestAction, EMPTY);
  const v = state.values;
  // Remounting with the submitted values keeps what was typed when a request is refused.
  return (
    <form key={JSON.stringify(v)} action={action} className="form">
      <label className="field">
        <span>Title</span>
        <input
          name="title"
          required
          maxLength={200}
          defaultValue={v.title}
          placeholder="Show opening hours in the footer"
        />
      </label>
      <label className="field">
        <span>Description</span>
        <span className="hint">Why it matters and any context, as prose.</span>
        <textarea name="description" rows={4} defaultValue={v.description} />
      </label>
      <label className="field">
        <span>Acceptance criteria</span>
        <span className="hint">One per line. Each must be something a test can check.</span>
        <textarea
          name="criteria"
          rows={6}
          required
          defaultValue={v.criteria}
          placeholder={'The footer lists each day with its opening hours\nClosed days say "Closed"'}
        />
      </label>
      <label className="field">
        <span>Depends on</span>
        <span className="hint">Issue numbers that must ship first, if any.</span>
        <input name="dependsOn" inputMode="numeric" defaultValue={v.dependsOn} placeholder="21, 22" />
      </label>
      {state.error ? (
        <div className="form-error" role="alert">
          <p>{state.error}</p>
          {state.vague && state.vague.length > 0 ? (
            <ul>
              {state.vague.map((v) => (
                <li key={v.criterion}>
                  <strong>{v.criterion}</strong>: {v.why}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {state.canOverride ? (
        <label className="field-check">
          <input type="checkbox" name="override" />
          File anyway (triage will still check it, and may stop it)
        </label>
      ) : null}
      <div className="actions">
        <button type="submit" className="button" disabled={pending}>
          {pending ? 'Filing…' : 'File request'}
        </button>
      </div>
    </form>
  );
}
