import { type VagueCriterion, vagueCriteria } from './request-check';
import { requestDraft } from './requests';

/**
 * The planner turns one plain-language feature request into a short list of
 * small issues. Claude drafts them (lib/planner.ts); this file decides whether
 * each draft can be filed, and in what order, so nothing reaches the backlog
 * that the request form itself would refuse.
 */
export interface PlannedIssue {
  readonly title: string;
  /** Prose: what and why, naming files or modules where it helps. */
  readonly description: string;
  readonly criteria: readonly string[];
  /** Earlier issues in this plan it needs, by position (0-based). */
  readonly dependsOn: readonly number[];
}

export interface Plan {
  /** One or two sentences: how the work was split, and anything left out. */
  readonly summary: string;
  readonly issues: readonly PlannedIssue[];
}

export const MAX_PLANNED_ISSUES = 8;

/** The JSON schema Claude's answer is constrained to. */
export const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          criteria: { type: 'array', items: { type: 'string' } },
          dependsOn: { type: 'array', items: { type: 'integer' } },
        },
        required: ['title', 'description', 'criteria', 'dependsOn'],
        additionalProperties: false,
      },
    },
  },
  required: ['summary', 'issues'],
  additionalProperties: false,
} as const;

const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string');

/**
 * Reads a plan from untrusted JSON (the model's answer, or a form posting it
 * back). Dependencies may only point backwards, so filing in order always
 * knows every number it needs.
 */
export function parsePlan(json: string): Plan | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const { summary, issues } = raw as { summary?: unknown; issues?: unknown };
  if (typeof summary !== 'string' || !Array.isArray(issues)) return null;
  if (issues.length === 0 || issues.length > MAX_PLANNED_ISSUES) return null;

  const parsed: PlannedIssue[] = [];
  for (const [index, item] of issues.entries()) {
    if (typeof item !== 'object' || item === null) return null;
    const { title, description, criteria, dependsOn } = item as Record<string, unknown>;
    if (typeof title !== 'string' || typeof description !== 'string' || !isStringList(criteria)) return null;
    if (!Array.isArray(dependsOn) || !dependsOn.every((d) => Number.isInteger(d) && d >= 0 && d < index)) {
      return null;
    }
    parsed.push({ title, description, criteria, dependsOn: [...new Set(dependsOn as number[])].sort() });
  }
  return { summary, issues: parsed };
}

export interface PlannedDraftCheck {
  /** Why the request form would refuse it, if it would. */
  readonly error: string | null;
  /** Criteria a test cannot pin down; triage would likely stop on them. */
  readonly vague: readonly VagueCriterion[];
}

/** The same checks a single request gets, for every issue in a plan. */
export function checkPlan(plan: Plan): PlannedDraftCheck[] {
  return plan.issues.map((issue) => {
    // Placeholder numbers: the real ones are only known while filing.
    const draft = requestDraft({
      title: issue.title,
      description: issue.description,
      criteria: issue.criteria.join('\n'),
      dependsOn: issue.dependsOn.map((d) => String(d + 1)).join(' '),
      requestedBy: 'planner',
    });
    return { error: draft.ok ? null : draft.error, vague: vagueCriteria(issue.criteria) };
  });
}

/** True when every issue passes the request form's own rules. */
export function fileable(checks: readonly PlannedDraftCheck[]): boolean {
  return checks.every((c) => c.error === null);
}

/**
 * The "Depends on" input for one planned issue, once the issues before it
 * have been filed: plan positions become real issue numbers, plus any
 * existing issues the whole plan waits on.
 */
export function dependsOnFor(
  issue: PlannedIssue,
  filed: readonly number[],
  existing: readonly number[] = [],
): string {
  const numbers = issue.dependsOn.map((position) => {
    const number = filed[position];
    if (number === undefined) throw new Error(`issue ${position + 1} of the plan has not been filed yet`);
    return number;
  });
  return [...existing, ...numbers].join(' ');
}

/** The plan without one issue; later issues' dependencies shift to keep pointing at the same work. */
export function withoutIssue(issues: readonly PlannedIssue[], removed: number): PlannedIssue[] {
  return issues
    .filter((_, i) => i !== removed)
    .map((issue) => ({
      ...issue,
      dependsOn: issue.dependsOn.filter((d) => d !== removed).map((d) => (d > removed ? d - 1 : d)),
    }));
}

/** Criteria typed one per line, as the list a plan holds. */
export function criteriaLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').trim())
    .filter(Boolean);
}
