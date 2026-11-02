/**
 * Scores triage against the hand-labeled golden set using the real Claude API.
 * Run by hand only (the triage-eval workflow, or locally). Costs about two
 * cents per run with Haiku. Prints a Markdown report; exits 1 on an unsafe
 * outcome (planned when it should not be, or risk rated too low) or an error.
 *
 *   ANTHROPIC_API_KEY=... node apps/workers/src/eval-triage.ts [--out results.json]
 *
 * Env: TRIAGE_MODEL (claude-haiku-5-5), TRIAGE_PROMPT (triage.v2),
 * CONFIDENCE_THRESHOLD (0.8), GOLDEN_SET (evals/triage/golden.json).
 */
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import Anthropic from '@anthropic-ai/sdk';
import { ClaudeDecisionModel, loadPrompt } from '@factory/decisions';
import { DEFAULT_CONFIDENCE_THRESHOLD, TRIAGE_QUESTIONS, triageOutcome } from '@factory/domain';
import { caseMaterial, type GoldenCase, labelProblems, loadGoldenSet } from './evals/golden.ts';
import { type CaseRun, renderReport, summarize } from './evals/score.ts';

const { values: args } = parseArgs({ options: { out: { type: 'string' } } });

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error('ANTHROPIC_API_KEY is not set');
  process.exit(2);
}

const model = process.env.TRIAGE_MODEL || 'claude-haiku-5-5';
const promptName = process.env.TRIAGE_PROMPT || 'triage.v2';
const threshold = Number(process.env.CONFIDENCE_THRESHOLD || DEFAULT_CONFIDENCE_THRESHOLD);
const cases = await loadGoldenSet(process.env.GOLDEN_SET || 'evals/triage/golden.json');

const badLabels = cases.flatMap((c) => labelProblems(c, threshold));
if (badLabels.length > 0) {
  console.error(`The golden set disagrees with the triage rules:\n${badLabels.join('\n')}`);
  process.exit(2);
}

const prompt = await loadPrompt(process.env.PROMPTS_DIR || 'prompts', promptName);
const engine = new ClaudeDecisionModel({
  // A manual script, not the factory: let the SDK ride out a rate limit.
  client: new Anthropic({ apiKey, maxRetries: 3 }),
  model,
  prompt,
});

let spentUsd = 0;
const onUsage = (usage: { usd: number }) => {
  spentUsd += usage.usd;
};

async function runCase(golden: GoldenCase): Promise<CaseRun> {
  const material = caseMaterial(golden);
  const decisions = await Promise.all(TRIAGE_QUESTIONS.map((q) => engine.decide(q, material, { onUsage })));
  return { golden, decisions, outcome: triageOutcome(decisions, threshold) };
}

const runs: CaseRun[] = [];
const errors: string[] = [];
const CONCURRENCY = 3;
for (let i = 0; i < cases.length; i += CONCURRENCY) {
  const batch = cases.slice(i, i + CONCURRENCY);
  const settled = await Promise.allSettled(batch.map(runCase));
  settled.forEach((result, j) => {
    if (result.status === 'fulfilled') runs.push(result.value);
    else
      errors.push(
        `${batch[j]?.id}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
      );
  });
}

const summary = summarize(runs, threshold);
console.log(renderReport(summary, { model, prompt: prompt.version, threshold, spentUsd, errors }));

if (args.out) {
  await writeFile(
    args.out,
    `${JSON.stringify(
      {
        model,
        prompt: prompt.version,
        threshold,
        spentUsd,
        summary,
        errors,
        cases: runs.map((r) => ({ id: r.golden.id, outcome: r.outcome, decisions: r.decisions })),
      },
      null,
      2,
    )}\n`,
  );
}

process.exit(summary.unsafe > 0 || errors.length > 0 ? 1 : 0);
