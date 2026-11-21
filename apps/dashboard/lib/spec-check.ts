import { access } from 'node:fs/promises';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { ClaudeDecisionModel, loadPrompt } from '@factory/decisions';
import { isConfident, SPEC_READY_QUESTION } from '@factory/domain';

/**
 * The paid half of checking a request: triage's own spec question, asked
 * before the issue is filed, with the same prompt and model triage uses. Only
 * runs when the dashboard has ANTHROPIC_API_KEY; otherwise the request is
 * filed after the free check alone, and triage asks this later as usual.
 */
export interface SpecCheck {
  readonly ready: boolean;
  readonly probability: number;
}

async function promptsDir(): Promise<string | null> {
  // Traced into the deployment by next.config (outputFileTracingIncludes).
  for (const dir of [join(process.cwd(), '..', '..', 'prompts'), join(process.cwd(), 'prompts')]) {
    try {
      await access(dir);
      return dir;
    } catch {}
  }
  return null;
}

export async function specCheck(repo: string, title: string, body: string): Promise<SpecCheck | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const dir = apiKey ? await promptsDir() : null;
  if (!apiKey || !dir) return null;

  const model = new ClaudeDecisionModel({
    // The step queue is the factory's only retry layer; a failed check just lets the request through.
    client: new Anthropic({ apiKey, maxRetries: 0, timeout: 15_000 }),
    model: process.env.TRIAGE_MODEL || 'claude-haiku-5-5',
    prompt: await loadPrompt(dir, process.env.TRIAGE_PROMPT || 'triage.v3'),
  });
  // The same material triage reads, so both judge the same text.
  const material = [`Repository: ${repo}`, `Issue (new): ${title}`, '', body].join('\n');
  const decision = await model.decide(SPEC_READY_QUESTION, material);
  return { ready: decision.choice === 'yes' && isConfident(decision), probability: decision.probability };
}
