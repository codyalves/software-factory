import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ForgeIssue } from '@factory/domain';

/** Label that opts an issue into the factory. */
export const FACTORY_LABEL = 'factory';

/**
 * Checks the X-Hub-Signature-256 header (HMAC-SHA256 of the raw body) in
 * constant time.
 */
export function isSignatureValid(
  secret: string,
  body: Uint8Array,
  signatureHeader: string | undefined,
): boolean {
  if (!secret) {
    throw new Error('webhook secret must not be empty');
  }

  const prefix = 'sha256=';
  if (!signatureHeader?.startsWith(prefix)) {
    return false;
  }

  const hex = signatureHeader.slice(prefix.length);
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    return false;
  }

  const expected = createHmac('sha256', secret).update(body).digest();
  return timingSafeEqual(expected, Buffer.from(hex, 'hex'));
}

interface IssuesEvent {
  action?: string;
  label?: { name?: string };
  issue?: { number?: number; title?: string; body?: string | null; labels?: { name?: string }[] };
  repository?: { full_name?: string };
}

/**
 * Returns the issue when an "issues" event should start a run: the issue was
 * opened with the factory label, or the label was just added.
 */
export function parseIssueEvent(eventName: string | undefined, body: Uint8Array): ForgeIssue | null {
  if (eventName !== 'issues') {
    return null;
  }

  const event = JSON.parse(Buffer.from(body).toString('utf8')) as IssuesEvent;
  const issue = event.issue;
  const repo = event.repository?.full_name;
  if (!issue || typeof issue.number !== 'number' || !repo) {
    return null;
  }

  const labels = (issue.labels ?? []).map((label) => label.name ?? '');
  const triggered =
    (event.action === 'opened' && labels.includes(FACTORY_LABEL)) ||
    (event.action === 'labeled' && event.label?.name === FACTORY_LABEL);

  if (!triggered) {
    return null;
  }

  return {
    repo,
    number: issue.number,
    title: issue.title ?? '',
    body: issue.body ?? '',
    labels,
  };
}
