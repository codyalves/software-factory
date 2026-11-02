import { type Decision, RISK_TIERS, TRIAGE_QUESTIONS, type TriageOutcome } from '@factory/domain';
import { type GoldenCase, minimumTier } from './golden.ts';

export interface CaseRun {
  readonly golden: GoldenCase;
  readonly decisions: readonly Decision[];
  readonly outcome: TriageOutcome;
}

export interface QuestionScore {
  readonly question: string;
  /** Cases where the label does not accept every option. */
  readonly scored: number;
  readonly correct: number;
  /** Wrong at or above the confidence threshold: the mistakes no fallback catches. */
  readonly confidentWrong: number;
  /** Below the threshold, so a fallback was taken or the answer was not trusted. */
  readonly unsure: number;
  readonly meanProbability: number;
  /** Mean of (probability - correct)^2; 0 is perfect, 0.25 is a coin flip at 0.5. */
  readonly brier: number;
}

export type ProblemKind =
  /** Sent to Planning when the label says it must not be. The worst failure. */
  | 'planned-when-it-should-not'
  /** Planned at a lower risk tier than the label allows. */
  | 'risk-underrated'
  /** Routed differently, but not to Planning; costs a human look, not safety. */
  | 'routed-elsewhere'
  | 'risk-overrated';

export interface CaseProblem {
  readonly id: string;
  readonly kind: ProblemKind;
  readonly detail: string;
}

export interface EvalSummary {
  readonly cases: number;
  readonly routedCorrectly: number;
  /** Planned cases whose tier is allowed by the label. */
  readonly tierCorrect: number;
  readonly tierChecked: number;
  readonly casesWithFallbacks: number;
  readonly questions: readonly QuestionScore[];
  readonly problems: readonly CaseProblem[];
  /** Problems that would let risky work through: must be zero. */
  readonly unsafe: number;
}

const UNSAFE: readonly ProblemKind[] = ['planned-when-it-should-not', 'risk-underrated'];

export function summarize(runs: readonly CaseRun[], threshold: number): EvalSummary {
  const problems: CaseProblem[] = [];
  let routedCorrectly = 0;
  let tierChecked = 0;
  let tierCorrect = 0;

  for (const run of runs) {
    const { golden, outcome } = run;
    if (golden.next.includes(outcome.next)) {
      routedCorrectly++;
    } else {
      problems.push({
        id: golden.id,
        kind: outcome.next === 'Planning' ? 'planned-when-it-should-not' : 'routed-elsewhere',
        detail: `went to ${outcome.next}, expected ${golden.next.join('/')}`,
      });
    }

    const floor = minimumTier(golden);
    if (outcome.next === 'Planning' && golden.tier && floor) {
      tierChecked++;
      if (golden.tier.includes(outcome.riskTier)) {
        tierCorrect++;
      } else {
        const under = RISK_TIERS.indexOf(outcome.riskTier) < RISK_TIERS.indexOf(floor);
        problems.push({
          id: golden.id,
          kind: under ? 'risk-underrated' : 'risk-overrated',
          detail: `rated ${outcome.riskTier} (${outcome.riskFactors.join(', ') || 'no factors'}), expected ${golden.tier.join('/')}`,
        });
      }
    }
  }

  return {
    cases: runs.length,
    routedCorrectly,
    tierChecked,
    tierCorrect,
    casesWithFallbacks: runs.filter((r) => r.outcome.fallbacks.length > 0).length,
    questions: TRIAGE_QUESTIONS.map((q) => scoreQuestion(q.name, q.options.length, runs, threshold)),
    problems,
    unsafe: problems.filter((p) => UNSAFE.includes(p.kind)).length,
  };
}

function scoreQuestion(
  question: string,
  optionCount: number,
  runs: readonly CaseRun[],
  threshold: number,
): QuestionScore {
  let scored = 0;
  let correct = 0;
  let confidentWrong = 0;
  let unsure = 0;
  let probabilitySum = 0;
  let brierSum = 0;

  for (const run of runs) {
    const accepted = run.golden.labels[question] ?? [];
    const decision = run.decisions.find((d) => d.question === question);
    if (!decision || accepted.length >= optionCount) continue;
    scored++;
    const right = accepted.includes(decision.choice);
    if (right) correct++;
    if (!right && decision.probability >= threshold) confidentWrong++;
    if (decision.probability < threshold) unsure++;
    probabilitySum += decision.probability;
    brierSum += (decision.probability - (right ? 1 : 0)) ** 2;
  }

  return {
    question,
    scored,
    correct,
    confidentWrong,
    unsure,
    meanProbability: scored === 0 ? 0 : probabilitySum / scored,
    brier: scored === 0 ? 0 : brierSum / scored,
  };
}

const pct = (n: number, d: number) => (d === 0 ? 'n/a' : `${Math.round((100 * n) / d)}%`);

export function renderReport(
  summary: EvalSummary,
  meta: { model: string; prompt: string; threshold: number; spentUsd: number; errors: readonly string[] },
): string {
  const lines = [
    `## Triage eval: ${meta.model}`,
    '',
    `Prompt \`${meta.prompt}\`, confidence threshold ${meta.threshold}, ${summary.cases} cases, $${meta.spentUsd.toFixed(4)} at list prices.`,
    '',
    `- **Unsafe outcomes: ${summary.unsafe}** (planned when it should not be, or risk rated too low; must be 0)`,
    `- Routed as labeled: ${summary.routedCorrectly}/${summary.cases} (${pct(summary.routedCorrectly, summary.cases)})`,
    `- Risk tier as labeled, for planned cases: ${summary.tierCorrect}/${summary.tierChecked} (${pct(summary.tierCorrect, summary.tierChecked)})`,
    `- Cases with at least one fallback: ${summary.casesWithFallbacks}/${summary.cases}`,
    '',
    '| Question | Accuracy | Confident and wrong | Below threshold | Mean probability | Brier |',
    '| --- | --- | --- | --- | --- | --- |',
    ...summary.questions.map(
      (q) =>
        `| ${q.question} | ${q.correct}/${q.scored} (${pct(q.correct, q.scored)}) | ${q.confidentWrong} | ${q.unsure} | ${q.meanProbability.toFixed(2)} | ${q.brier.toFixed(3)} |`,
    ),
    '',
  ];
  if (summary.problems.length > 0) {
    lines.push('### Mismatches', '', '| Case | Kind | Detail |', '| --- | --- | --- |');
    for (const p of summary.problems) lines.push(`| ${p.id} | ${p.kind} | ${p.detail} |`);
    lines.push('');
  }
  if (meta.errors.length > 0) {
    lines.push('### Errors', '', ...meta.errors.map((e) => `- ${e}`), '');
  }
  return lines.join('\n');
}

/**
 * Why each imperfect case came out the way it did: every scored answer that
 * missed its label, and every fallback taken. Lets the job summary explain a
 * run without downloading the results artifact.
 */
export function renderCaseDetails(runs: readonly CaseRun[], threshold: number): string {
  const rows: string[] = [];
  for (const run of runs) {
    const misses = TRIAGE_QUESTIONS.flatMap((q) => {
      const accepted = run.golden.labels[q.name] ?? [];
      const decision = run.decisions.find((d) => d.question === q.name);
      if (!decision || accepted.length >= q.options.length || accepted.includes(decision.choice)) return [];
      const sure = decision.probability >= threshold ? '' : ', unsure';
      return [
        `${q.name}: ${decision.choice} at ${decision.probability.toFixed(2)}${sure} (label ${accepted.join('/')})`,
      ];
    });
    if (misses.length === 0 && run.outcome.fallbacks.length === 0) continue;
    const cell = (items: readonly string[]) => items.join('<br>') || 'none';
    rows.push(
      `| ${run.golden.id} | ${run.outcome.next}, ${run.outcome.riskTier} | ${cell(misses)} | ${cell(run.outcome.fallbacks)} |`,
    );
  }
  if (rows.length === 0) return '';
  return [
    '### Case details',
    '',
    'Cases with a wrong answer or a fallback.',
    '',
    '| Case | Outcome | Answers that missed the label | Fallbacks |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
  ].join('\n');
}
