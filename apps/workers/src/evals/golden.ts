import { readFile } from 'node:fs/promises';
import {
  type Decision,
  RISK_TIERS,
  type RiskTier,
  TRIAGE_QUESTIONS,
  type TriageNext,
  triageOutcome,
} from '@factory/domain';
import { z } from 'zod';

const NEXT = ['Planning', 'Rejected', 'Escalated'] as const satisfies readonly TriageNext[];

const caseSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  title: z.string().min(1),
  body: z.string(),
  /** For each question, every answer a careful reviewer would accept. */
  labels: z.record(z.string(), z.array(z.string()).min(1)),
  next: z.array(z.enum(NEXT)).min(1),
  /** Checked only when the run goes to Planning. */
  tier: z.array(z.enum(RISK_TIERS)).min(1).optional(),
  why: z.string().min(1),
});

const goldenSchema = z.object({
  description: z.string(),
  cases: z.array(caseSchema).min(1),
});

export type GoldenCase = z.infer<typeof caseSchema>;

export async function loadGoldenSet(path: string): Promise<GoldenCase[]> {
  const parsed = goldenSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  return parsed.cases;
}

/** The text a triage worker would send for this issue. */
export function caseMaterial(golden: GoldenCase): string {
  return [`Repository: codyalves/factory-target-app`, `Issue: ${golden.title}`, '', golden.body].join('\n');
}

/**
 * Problems that make a case unusable: a label for an unknown question, an
 * answer that is not an option, a missing question, or labels the triage
 * rules cannot turn into the expected outcome. Checks every combination of
 * accepted answers, each given with full confidence.
 */
export function labelProblems(golden: GoldenCase, threshold: number): string[] {
  const problems: string[] = [];
  const known = new Set(TRIAGE_QUESTIONS.map((q) => q.name));
  for (const name of Object.keys(golden.labels)) {
    if (!known.has(name)) problems.push(`${golden.id}: unknown question ${name}`);
  }
  for (const question of TRIAGE_QUESTIONS) {
    const accepted = golden.labels[question.name];
    if (!accepted) {
      problems.push(`${golden.id}: no label for ${question.name}`);
      continue;
    }
    for (const answer of accepted) {
      if (!(question.options as readonly string[]).includes(answer)) {
        problems.push(`${golden.id}: ${question.name} label "${answer}" is not an option`);
      }
    }
  }
  if (golden.next.includes('Planning') && !golden.tier) {
    problems.push(`${golden.id}: a case that can be planned needs a tier`);
  }
  if (problems.length > 0) return problems;

  for (const combination of combinations(golden)) {
    const outcome = triageOutcome(combination, threshold);
    const answers = combination.map((d) => `${d.question}=${d.choice}`).join(', ');
    if (!golden.next.includes(outcome.next)) {
      problems.push(`${golden.id}: ${answers} routes to ${outcome.next}, not ${golden.next.join('/')}`);
    } else if (outcome.next === 'Planning' && golden.tier && !golden.tier.includes(outcome.riskTier)) {
      problems.push(`${golden.id}: ${answers} rates ${outcome.riskTier}, not ${golden.tier.join('/')}`);
    }
  }
  return problems;
}

/** The lowest tier a case may be rated, or null when tier is not checked. */
export function minimumTier(golden: GoldenCase): RiskTier | null {
  if (!golden.tier) return null;
  return RISK_TIERS.find((tier) => golden.tier?.includes(tier)) ?? null;
}

function* combinations(golden: GoldenCase): Generator<Decision[]> {
  const choices = TRIAGE_QUESTIONS.map((q) => ({ name: q.name, accepted: golden.labels[q.name] ?? [] }));
  function* walk(index: number, picked: Decision[]): Generator<Decision[]> {
    const current = choices[index];
    if (!current) {
      yield picked;
      return;
    }
    for (const choice of current.accepted) {
      yield* walk(index + 1, [
        ...picked,
        {
          question: current.name,
          choice,
          probability: 1,
          engine: 'label',
          engineVersion: '1',
          promptVersion: null,
          questionVersion: null,
        },
      ]);
    }
  }
  yield* walk(0, []);
}
