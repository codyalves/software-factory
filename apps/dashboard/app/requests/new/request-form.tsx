'use client';

import { useActionState } from 'react';
import { fileRequestAction } from '../../actions';

export function RequestForm() {
  const [state, action, pending] = useActionState(fileRequestAction, { error: null });
  return (
    <form action={action} className="form">
      <label className="field">
        <span>Title</span>
        <input name="title" required maxLength={200} placeholder="Show opening hours in the footer" />
      </label>
      <label className="field">
        <span>Description</span>
        <span className="hint">Why it matters and any context, as prose.</span>
        <textarea name="description" rows={4} />
      </label>
      <label className="field">
        <span>Acceptance criteria</span>
        <span className="hint">One per line. Each must be something a test can check.</span>
        <textarea
          name="criteria"
          rows={6}
          required
          placeholder={'The footer lists each day with its opening hours\nClosed days say "Closed"'}
        />
      </label>
      <label className="field">
        <span>Depends on</span>
        <span className="hint">Issue numbers that must ship first, if any.</span>
        <input name="dependsOn" inputMode="numeric" placeholder="21, 22" />
      </label>
      {state.error ? (
        <p className="form-error" role="alert">
          {state.error}
        </p>
      ) : null}
      <div className="actions">
        <button type="submit" className="button" disabled={pending}>
          {pending ? 'Filing…' : 'File request'}
        </button>
      </div>
    </form>
  );
}
