'use client';

import type { ReactNode } from 'react';
import { useFormStatus } from 'react-dom';

/**
 * A form's submit button that answers the click: while the action is on its
 * way it is disabled and says so, so a press is never met with silence and
 * cannot be sent twice.
 */
export function SubmitButton({
  children,
  pending,
  className = 'button',
  disabled = false,
}: {
  children: ReactNode;
  /** What the button says while the action runs, e.g. "Approving…". */
  pending: string;
  className?: string;
  disabled?: boolean;
}) {
  const status = useFormStatus();
  return (
    <button
      type="submit"
      className={className}
      disabled={disabled || status.pending}
      aria-busy={status.pending}
    >
      {status.pending ? pending : children}
    </button>
  );
}
