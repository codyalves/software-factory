import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { isSignatureValid, parseIssueEvent } from './webhook.ts';

const SECRET = 'test-secret';
const bytes = (text: string) => new TextEncoder().encode(text);
const sign = (body: Uint8Array) => `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;

describe('isSignatureValid', () => {
  it('accepts a valid signature', () => {
    const body = bytes('{"zen":"Keep it logically awesome."}');

    expect(isSignatureValid(SECRET, body, sign(body))).toBe(true);
  });

  it.each([undefined, '', 'sha1=abc', 'sha256=not-hex', `sha256=${'0'.repeat(64)}`])(
    'rejects a missing or wrong signature: %s',
    (header) => {
      expect(isSignatureValid(SECRET, bytes('{}'), header)).toBe(false);
    },
  );

  it('rejects a modified body', () => {
    const signature = sign(bytes('{"amount":1}'));

    expect(isSignatureValid(SECRET, bytes('{"amount":9}'), signature)).toBe(false);
  });
});

describe('parseIssueEvent', () => {
  it('starts a run for an issue opened with the factory label', () => {
    expect(parseIssueEvent('issues', issueEvent('opened', ['factory', 'bug']))).toEqual({
      repo: 'codyalves/target',
      number: 12,
      title: 'Fix the footer',
      body: '',
      labels: ['factory', 'bug'],
    });
  });

  it('ignores an issue opened without the label', () => {
    expect(parseIssueEvent('issues', issueEvent('opened', ['bug']))).toBeNull();
  });

  it('starts a run when the factory label is added', () => {
    expect(parseIssueEvent('issues', issueEvent('labeled', ['bug', 'factory'], 'factory'))).not.toBeNull();
    expect(parseIssueEvent('issues', issueEvent('labeled', ['bug', 'factory'], 'bug'))).toBeNull();
  });

  it('ignores other events', () => {
    expect(parseIssueEvent('push', bytes('{}'))).toBeNull();
  });
});

function issueEvent(action: string, labels: string[], added?: string): Uint8Array {
  return bytes(
    JSON.stringify({
      action,
      ...(added ? { label: { name: added } } : {}),
      issue: { number: 12, title: 'Fix the footer', body: null, labels: labels.map((name) => ({ name })) },
      repository: { full_name: 'codyalves/target' },
    }),
  );
}
