import { dependencies, READY_LABEL } from '@factory/domain';

/**
 * A request from the dashboard, turned into the issue the factory expects:
 * prose, an optional "Depends on" line, then one bullet per acceptance
 * criterion. Triage then reads it like any other issue.
 */
export interface RequestInput {
  readonly title: string;
  readonly description: string;
  /** One criterion per line. */
  readonly criteria: string;
  /** Issue numbers, separated by spaces or commas. */
  readonly dependsOn: string;
  readonly requestedBy: string;
}

export type RequestDraft =
  | { readonly ok: true; readonly title: string; readonly body: string; readonly labels: string[] }
  | { readonly ok: false; readonly error: string };

const BULLET = /^\s*(?:[-*+]|\d+[.)])\s+/;
const MAX_CRITERIA = 20;

export function requestDraft(input: RequestInput): RequestDraft {
  const title = input.title.trim();
  const description = input.description.trim();
  const fail = (error: string): RequestDraft => ({ ok: false, error });

  if (!title || title.length > 200) return fail('Give the request a title of up to 200 characters.');
  // HTML comments carry the factory's own markers (an embedded regression test,
  // a finding's fingerprint); a request must not be able to forge them.
  if ([title, description, input.criteria].some((t) => t.includes('<!--'))) {
    return fail('HTML comments are not allowed in a request.');
  }
  // Every bullet in an issue becomes an acceptance criterion, so the
  // description has to be prose for the criteria to be exactly what was listed.
  if (description.split(/\r?\n/).some((line) => BULLET.test(line))) {
    return fail('Write the description as prose; put each expected behavior under acceptance criteria.');
  }

  const criteria = input.criteria
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(BULLET, '')
        .replace(/^\[[ xX]\]\s*/, '')
        .trim(),
    )
    .filter(Boolean);
  if (criteria.length === 0) {
    return fail('Add at least one acceptance criterion: something a test can check, one per line.');
  }
  if (criteria.length > MAX_CRITERIA)
    return fail(`Keep it to ${MAX_CRITERIA} criteria or fewer; split bigger work.`);
  if (criteria.some((c) => c.length > 300)) return fail('Keep each criterion under 300 characters.');

  const deps = [...new Set((input.dependsOn.match(/\d+/g) ?? []).map(Number))]
    .filter((n) => n > 0)
    .sort((a, b) => a - b);
  const dependsLine = deps.length > 0 ? `Depends on ${deps.map((n) => `#${n}`).join(', ')}.` : '';

  const body = [
    description,
    dependsLine,
    criteria.map((c) => `- ${c}`).join('\n'),
    `Requested by ${input.requestedBy} from the factory dashboard.`,
  ]
    .filter(Boolean)
    .join('\n\n');

  // The backlog reads dependencies back from the body; make sure it will.
  if (dependencies(body).join() !== deps.join()) {
    return fail('The description mentions other issues in a way that reads as a dependency. Reword it.');
  }
  return { ok: true, title, body, labels: [READY_LABEL] };
}
