import type { Decision, DecisionQuestion } from './decisions.ts';

export const ISSUE_TYPES = ['bug', 'feature', 'chore', 'reject'] as const;
export const SPEC_READY = ['yes', 'no'] as const;
export const RISK_TIERS = ['low', 'medium', 'high'] as const;

export type IssueType = (typeof ISSUE_TYPES)[number];
export type RiskTier = (typeof RISK_TIERS)[number];

export const TRIAGE_QUESTIONS = {
  issueType: {
    name: 'issue_type',
    instructions:
      'What kind of work is this issue? "reject" if it is not actionable, not software work, or asks for something unsafe.',
    options: ISSUE_TYPES,
  },
  specReady: {
    name: 'spec_ready',
    instructions:
      'Can this be implemented and verified as written? "yes" only if every acceptance criterion is specific and testable.',
    options: SPEC_READY,
  },
  riskTier: {
    name: 'risk_tier',
    instructions:
      '"high" if it touches authentication, payments, data migrations, dependencies, CI configuration or quality gates. "medium" if it changes behavior users depend on. "low" for copy, styling, tests or isolated additions.',
    options: RISK_TIERS,
  },
} as const satisfies Record<string, DecisionQuestion>;

export type TriageNext = 'Planning' | 'Rejected' | 'Escalated';

export interface TriageOutcome {
  readonly next: TriageNext;
  /** Risk after fallbacks; drives the merge policy later. */
  readonly riskTier: RiskTier;
  readonly reason: string;
  /** Safe defaults taken because a decision was below the confidence threshold. */
  readonly fallbacks: readonly string[];
  /** Posted on the issue so the author knows what happened and what to do. */
  readonly comment: string | null;
}

/**
 * Turns the triage decisions into the run's next state. Pure and
 * deterministic: models answer the questions, this code decides.
 *
 * Low-confidence fallbacks: an unsure issue type escalates to a human, an
 * unsure spec counts as not ready, an unsure risk tier counts as high.
 */
export function triageOutcome(decisions: readonly Decision[], threshold: number): TriageOutcome {
  const find = (question: DecisionQuestion) => {
    const decision = decisions.find((d) => d.question === question.name);
    if (!decision || !(question.options as readonly string[]).includes(decision.choice)) {
      throw new Error(`triage is missing a valid answer to ${question.name}`);
    }
    return { choice: decision.choice, confident: decision.probability >= threshold };
  };

  const issueType = find(TRIAGE_QUESTIONS.issueType);
  const specReady = find(TRIAGE_QUESTIONS.specReady);
  const risk = find(TRIAGE_QUESTIONS.riskTier);

  const fallbacks: string[] = [];
  let riskTier = risk.choice as RiskTier;
  if (!risk.confident && riskTier !== 'high') {
    fallbacks.push(`risk_tier ${riskTier} below confidence threshold; treated as high`);
    riskTier = 'high';
  }

  if (issueType.choice === 'reject' && issueType.confident) {
    return {
      next: 'Rejected',
      riskTier,
      reason: 'triage rejected the issue as not actionable',
      fallbacks,
      comment:
        'The software factory will not work on this issue: triage judged it not actionable, not software work, or unsafe. A maintainer can relabel it if that is wrong.',
    };
  }

  if (!issueType.confident) {
    fallbacks.push(`issue_type ${issueType.choice} below confidence threshold; escalated`);
    return {
      next: 'Escalated',
      riskTier,
      reason: 'issue type unclear',
      fallbacks,
      comment:
        'The software factory could not confidently classify this issue, so a maintainer needs to look at it before work starts.',
    };
  }

  if (specReady.choice === 'no' || !specReady.confident) {
    if (specReady.choice === 'yes') {
      fallbacks.push('spec_ready yes below confidence threshold; treated as no');
    }
    return {
      next: 'Escalated',
      riskTier,
      reason: 'acceptance criteria are not specific and testable',
      fallbacks,
      comment:
        'The software factory needs clearer acceptance criteria before it can start. Please list each expected behavior as a testable statement (for example: "Given ..., when ..., then ..."), then remove and re-add the `factory` label.',
    };
  }

  return {
    next: 'Planning',
    riskTier,
    reason: `triaged as ${issueType.choice}, ${riskTier} risk`,
    fallbacks,
    comment: null,
  };
}
