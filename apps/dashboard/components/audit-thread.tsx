import Link from 'next/link';
import { clock, STATE_LABEL, utc } from '@/lib/format';

interface ThreadEvent {
  readonly seq: number;
  readonly at: string;
  readonly type: string;
  readonly payload: unknown;
  readonly hash: string;
  readonly runId?: string | null;
}

const field = (payload: unknown, key: string): string => {
  const value =
    payload !== null && typeof payload === 'object' ? (payload as Record<string, unknown>)[key] : undefined;
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
};

/** One line saying what an event recorded, in plain words. */
export function describe(event: ThreadEvent): { what: string; detail: string } {
  const p = event.payload;
  switch (event.type) {
    case 'run.state_changed':
      return {
        what: `${STATE_LABEL[field(p, 'from')] ?? field(p, 'from')} to ${(STATE_LABEL[field(p, 'to')] ?? field(p, 'to')).toLowerCase()}`,
        detail: field(p, 'reason'),
      };
    case 'decision.made':
      return {
        what: `Answered ${field(p, 'question')}: ${field(p, 'choice')}`,
        detail: `${Math.round(Number(field(p, 'probability')) * 100)}% confident, ${field(p, 'engineVersion') || field(p, 'engine')}`,
      };
    case 'triage.completed':
      return { what: 'Triage decided', detail: `${field(p, 'next')}, ${field(p, 'riskTier')} risk` };
    case 'plan.criteria':
      return { what: 'Numbered the acceptance criteria', detail: '' };
    case 'implementation.committed':
      return {
        what: `Attempt ${field(p, 'attempt')} committed`,
        detail: `${field(p, 'commitSha').slice(0, 12)} by ${field(p, 'implementer')}`,
      };
    case 'gating.completed':
      return { what: `Attempt ${field(p, 'attempt')} checked`, detail: '' };
    case 'traceability.recorded':
      return { what: 'Recorded criterion-to-test links', detail: field(p, 'commitSha').slice(0, 12) };
    case 'risk.raised':
      return {
        what: `Risk raised from ${field(p, 'from') || 'none'} to ${field(p, 'to')}`,
        detail: 'measured from the diff',
      };
    case 'outbox.sent':
      return { what: 'Sent to GitHub', detail: field(p, 'kind') };
    case 'outbox.retry_scheduled':
      return { what: 'GitHub call will be retried', detail: field(p, 'error') };
    case 'outbox.failed':
      return { what: 'GitHub call failed for good', detail: field(p, 'error') };
    case 'factory.paused':
      return { what: `Factory paused by ${field(p, 'actor')}`, detail: field(p, 'reason') };
    case 'factory.resumed':
      return { what: `Factory resumed by ${field(p, 'actor')}`, detail: '' };
    case 'factory.budget_changed':
      return { what: `Budget changed by ${field(p, 'actor')}`, detail: '' };
    default:
      return { what: event.type.replace(/[._]/g, ' '), detail: '' };
  }
}

/** Queue mechanics: real and chained, but not what a reader is looking for. */
export function isBookkeeping(type: string): boolean {
  return type.startsWith('step.');
}

function Thread({
  events,
  showRun,
  withDate,
}: {
  events: readonly ThreadEvent[];
  showRun: boolean;
  withDate: boolean;
}) {
  return (
    <ol className={withDate ? 'thread thread-dated' : 'thread'}>
      {events.map((e) => {
        const { what, detail } = describe(e);
        return (
          <li key={e.seq}>
            <span className="when">{withDate ? utc(e.at) : `${clock(e.at)} UTC`}</span>
            <span className="knot" aria-hidden="true" />
            <div>
              <div className="what">{what}</div>
              {detail ? <div className="detail">{detail}</div> : null}
              <div className="link">
                Event {e.seq}, hash <span className="mono">{e.hash.slice(0, 16)}</span>
                {showRun && e.runId ? (
                  <>
                    , <Link href={`/runs/${e.runId}`}>run {e.runId.slice(0, 8)}</Link>
                  </>
                ) : null}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * The chain as a thread: the events that tell the story first, and every
 * event (including queue bookkeeping) one click away, so nothing is hidden.
 */
export function AuditThread({
  events,
  showRun = false,
  withDate = false,
}: {
  events: readonly ThreadEvent[];
  showRun?: boolean;
  withDate?: boolean;
}) {
  const key = events.filter((e) => !isBookkeeping(e.type));
  return (
    <>
      <Thread events={key} showRun={showRun} withDate={withDate} />
      {key.length < events.length ? (
        <details className="all-events">
          <summary>
            Show all {events.length} events, including {events.length - key.length} queue steps
          </summary>
          <Thread events={events} showRun={showRun} withDate={withDate} />
        </details>
      ) : null}
    </>
  );
}
