import type { Decision, DecisionQuestion } from './decisions.ts';

export const ISSUE_TYPES = ['bug', 'feature', 'chore'] as const;
export const YES_NO = ['yes', 'no'] as const;
export const RISK_TIERS = ['low', 'medium', 'high'] as const;

export type IssueType = (typeof ISSUE_TYPES)[number];
export type RiskTier = (typeof RISK_TIERS)[number];

/**
 * Risk is not asked as one judgment call. Each question asks whether the work
 * touches one specific thing; code combines the answers into a tier. Small
 * yes/no questions are easier to answer well, and every tier can be traced to
 * the facts that produced it.
 */
export const RISK_QUESTIONS = {
  auth: {
    name: 'risk_auth',
    tier: 'high',
    instructions:
      'Would doing this work change authentication, authorization, sessions, secrets, API keys or who can access what? Answer "yes" if the issue would plausibly require it, even if it does not say so.',
    options: YES_NO,
  },
  data: {
    name: 'risk_data',
    tier: 'high',
    instructions:
      'Would doing this work change the database schema, migrate, rewrite or delete stored data, or change how personal data is collected, stored or shared? Answer "yes" if the issue would plausibly require it, even if it does not say so.',
    options: YES_NO,
  },
  payments: {
    name: 'risk_payments',
    tier: 'high',
    instructions:
      'Would doing this work touch payments, billing, pricing or invoices? Answer "yes" if the issue would plausibly require it, even if it does not say so.',
    options: YES_NO,
  },
  platform: {
    name: 'risk_platform',
    tier: 'high',
    instructions:
      'Would doing this work add, remove or upgrade a dependency, or change the build, CI, deployment, hosting infrastructure or quality gates? Using storage, services or libraries the product already has does not count. Answer "yes" if the issue would plausibly require it, even if it does not say so.',
    options: YES_NO,
  },
  existingBehavior: {
    name: 'risk_existing_behavior',
    tier: 'medium',
    instructions:
      'Would doing this work change or remove behavior that users or other code already rely on, including what an AI chatbot answers? Answer "no" if it only adds something new, or only changes copy, styling or tests.',
    options: YES_NO,
  },
} as const satisfies Record<string, DecisionQuestion & { tier: Exclude<RiskTier, 'low'> }>;

/**
 * Whether the factory should work on this at all. The only triage question
 * that can stop work before the spec check: an unsure answer goes to a person.
 */
export const ACTIONABLE_QUESTION = {
  name: 'actionable',
  instructions:
    'Is this actionable software work for this product: a change someone could make to its code, tests, content or styling? Answer "no" if it is not software work, is not about this product, is spam, or asks for something unsafe or harmful, such as weakening security, hiding access or exfiltrating data.',
  options: YES_NO,
} as const satisfies DecisionQuestion;

/**
 * What kind of work it is. Recorded for reporting only: bugs, features and
 * chores all go through the same loop, so an unsure type never stops work.
 */
export const ISSUE_TYPE_QUESTION = {
  name: 'issue_type',
  instructions:
    'What kind of work is this issue? "bug" if something does not work as intended; "feature" if it adds to or changes what the product does or how it looks; "chore" if it is upkeep users do not see, such as tests, refactoring or dependencies. When two fit, give the closer one.',
  options: ISSUE_TYPES,
} as const satisfies DecisionQuestion;

export const SPEC_READY_QUESTION = {
  name: 'spec_ready',
  instructions:
    'Could a competent engineer build this and check each stated expectation with tests, without going back to the author? "yes" if the goal and the expected behavior are clear; details an engineer would normally decide (exact colors, which library, how a job is scheduled) do not make it unready. "no" if the goal, the expected behavior, or how to tell it works is missing or ambiguous.',
  options: YES_NO,
} as const satisfies DecisionQuestion;

/** Every question triage asks, in a stable order: actionable, type, spec, then each risk factor. */
export const TRIAGE_QUESTIONS: readonly DecisionQuestion[] = [
  ACTIONABLE_QUESTION,
  ISSUE_TYPE_QUESTION,
  SPEC_READY_QUESTION,
  ...Object.values(RISK_QUESTIONS),
];

export type TriageNext = 'Planning' | 'Rejected' | 'Escalated';

export interface TriageOutcome {
  readonly next: TriageNext;
  /** Risk after fallbacks; drives the merge policy later. */
  readonly riskTier: RiskTier;
  /** The risk questions answered (or treated as) "yes", which set the tier. */
  readonly riskFactors: readonly string[];
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
 * Low-confidence fallbacks: an unsure "actionable" escalates to a person,
 * an unsure issue type is recorded and changes nothing, an unsure spec
 * counts as not ready, and an unsure "no" to a risk question counts as
 * "yes". The tier is the highest tier among the "yes" answers.
 */
export function triageOutcome(decisions: readonly Decision[], threshold: number): TriageOutcome {
  const find = (question: DecisionQuestion): { choice: string; confident: boolean } => {
    const decision = decisions.find((d) => d.question === question.name);
    if (!decision || !(question.options as readonly string[]).includes(decision.choice)) {
      throw new Error(`triage is missing a valid answer to ${question.name}`);
    }
    return { choice: decision.choice, confident: decision.probability >= threshold };
  };

  const actionable = find(ACTIONABLE_QUESTION);
  const issueType = find(ISSUE_TYPE_QUESTION);
  const specReady = find(SPEC_READY_QUESTION);

  const fallbacks: string[] = [];
  const riskFactors: string[] = [];
  let riskTier: RiskTier = 'low';
  for (const question of Object.values(RISK_QUESTIONS)) {
    const answer = find(question);
    if (answer.choice === 'no' && !answer.confident) {
      fallbacks.push(`${question.name} no below confidence threshold; treated as yes`);
    } else if (answer.choice === 'no') {
      continue;
    }
    riskFactors.push(question.name);
    if (question.tier === 'high' || riskTier === 'low') {
      riskTier = question.tier;
    }
  }

  if (!issueType.confident) {
    fallbacks.push(`issue_type ${issueType.choice} below confidence threshold; recorded only`);
  }

  if (actionable.choice === 'no' && actionable.confident) {
    return {
      next: 'Rejected',
      riskTier,
      riskFactors,
      reason: 'triage rejected the issue as not actionable',
      fallbacks,
      comment:
        'The software factory will not work on this issue: triage judged it not actionable, not software work, or unsafe. A maintainer can relabel it if that is wrong.',
    };
  }

  if (!actionable.confident) {
    fallbacks.push(`actionable ${actionable.choice} below confidence threshold; escalated`);
    return {
      next: 'Escalated',
      riskTier,
      riskFactors,
      reason: 'unclear whether this is actionable software work',
      fallbacks,
      comment:
        'The software factory could not tell with confidence whether this is software work it should do, so a maintainer needs to look at it before work starts.',
    };
  }

  if (specReady.choice === 'no' || !specReady.confident) {
    if (specReady.choice === 'yes') {
      fallbacks.push('spec_ready yes below confidence threshold; treated as no');
    }
    return {
      next: 'Escalated',
      riskTier,
      riskFactors,
      reason: 'acceptance criteria are not specific and testable',
      fallbacks,
      comment:
        'The software factory needs clearer acceptance criteria before it can start. Please list each expected behavior as a testable statement (for example: "Given ..., when ..., then ..."), then remove and re-add the `factory` label.',
    };
  }

  return {
    next: 'Planning',
    riskTier,
    riskFactors,
    reason: `triaged as ${issueType.choice}, ${riskTier} risk${riskFactors.length > 0 ? ` (${riskFactors.join(', ')})` : ''}`,
    fallbacks,
    comment: null,
  };
}
