import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Prompt } from '@factory/decisions';
import { z } from 'zod';
import type { Implementer, ImplementInput } from './implementer.ts';
import { StepError } from './step-runner.ts';

export interface ClaudeCodeOptions {
  /** The API key the agent bills to. The only secret it receives. */
  readonly apiKey: string;
  readonly prompt: Prompt;
  /** Model for the first attempts, e.g. claude-sonnet-5-5. */
  readonly model: string;
  /** Model once `escalateAfter` attempts have failed, e.g. claude-opus-5-5. */
  readonly frontierModel: string;
  readonly escalateAfter: number;
  /** Hard cap per attempt, enforced by Claude Code itself. */
  readonly maxBudgetUsd: number;
  /** The claude executable. */
  readonly bin?: string;
}

/** Results that mean the agent hit a limit we set, not that it could not run. */
const LIMIT_SUBTYPES = new Set(['error_max_budget_usd', 'error_max_turns']);

/** Read-only commands the agent may always run, besides the target's gate commands. */
const SAFE_COMMANDS = ['git status', 'git diff', 'git log', 'ls', 'cat', 'pwd'];

const resultSchema = z.object({
  type: z.literal('result'),
  subtype: z.string(),
  is_error: z.boolean(),
  result: z.string().optional(),
  total_cost_usd: z.number().nonnegative().default(0),
  num_turns: z.number().optional(),
  usage: z
    .object({
      input_tokens: z.number().default(0),
      output_tokens: z.number().default(0),
      cache_creation_input_tokens: z.number().default(0),
      cache_read_input_tokens: z.number().default(0),
    })
    .partial()
    .default({}),
});

/** The model for an attempt: escalate to the frontier model after repeated failures (gates.yaml). */
export function modelForAttempt(
  attempt: number,
  options: Pick<ClaudeCodeOptions, 'model' | 'frontierModel' | 'escalateAfter'>,
) {
  return attempt > options.escalateAfter ? options.frontierModel : options.model;
}

/**
 * The tools the agent may use: read and edit files, search, and run exactly
 * the target's own setup and gate commands plus a few read-only ones. No web
 * access, no MCP servers, no other shell commands (dontAsk denies anything
 * not listed instead of prompting).
 */
export function allowedTools(commands: readonly (readonly string[])[]): string[] {
  const shell = [...SAFE_COMMANDS, ...commands.map((argv) => argv.join(' '))];
  return ['Read', 'Edit', 'Write', 'Glob', 'Grep', ...[...new Set(shell)].map((c) => `Bash(${c}:*)`)];
}

export function implementationPrompt(input: ImplementInput): string {
  return [
    `Attempt ${input.attempt} at issue #${input.issue.number} in ${input.issue.repo}.`,
    '',
    '<issue>',
    `Title: ${input.issue.title}`,
    '',
    input.issue.body,
    '</issue>',
    '',
    'Acceptance criteria (each needs a test whose name starts with its id):',
    ...input.criteria.map((c) => `- ${c.id}: ${c.text}`),
    '',
    `Protected paths, do not change: ${input.protectedPaths.join(', ') || 'none'}`,
    `Commands you can run: ${input.commands.map((c) => c.join(' ')).join('; ') || 'none'}`,
    ...(input.feedback
      ? ['', '<previous_attempt_failures>', input.feedback, '</previous_attempt_failures>']
      : []),
  ].join('\n');
}

/**
 * Claude Code, headless, as the implementer. Each attempt is one `claude -p`
 * run in the workspace with: no personal settings, hooks or memory (--bare);
 * an allow-list of tools; a hard per-attempt budget; only the API key in its
 * environment (no GitHub token, so it cannot push). Its cost is metered from
 * the run's own report.
 */
export class ClaudeCodeImplementer implements Implementer {
  readonly name: string;
  readonly #options: ClaudeCodeOptions;

  constructor(options: ClaudeCodeOptions) {
    this.#options = options;
    this.name = `claude-code/${options.model}/${options.prompt.version}`;
  }

  async implement(
    input: ImplementInput,
    context: {
      signal: AbortSignal;
      recordUsage: (usage: { model: string; inputTokens: number; outputTokens: number; usd: number }) => void;
    },
  ): Promise<{ summary: string }> {
    const model = modelForAttempt(input.attempt, this.#options);
    const args = [
      '--print',
      '--bare',
      '--output-format',
      'json',
      '--model',
      model,
      '--max-budget-usd',
      this.#options.maxBudgetUsd.toFixed(2),
      '--permission-mode',
      'dontAsk',
      '--allowedTools',
      ...allowedTools(input.commands),
      '--disallowedTools',
      'WebFetch',
      'WebSearch',
      '--strict-mcp-config',
      '--no-session-persistence',
      '--append-system-prompt',
      this.#options.prompt.text,
    ];

    // A private HOME: no user config, credentials or history leak in or out.
    const home = await mkdtemp(join(tmpdir(), 'claude-home-'));
    try {
      const run = await runAgent(this.#options.bin ?? 'claude', args, implementationPrompt(input), {
        cwd: input.dir,
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          HOME: home,
          ANTHROPIC_API_KEY: this.#options.apiKey,
          CI: '1',
          DISABLE_AUTOUPDATER: '1',
          DISABLE_TELEMETRY: '1',
        },
        signal: context.signal,
      });

      const parsed = parseResult(run.stdout);
      if (!parsed) {
        throw new StepError(
          `claude exited with ${run.exitCode ?? 'a signal'} and no result: ${run.stderr.slice(-2_000)}`,
          {
            failureClass: 'transient',
          },
        );
      }
      const usage = parsed.usage;
      // Billed whatever happened next.
      context.recordUsage({
        model,
        inputTokens:
          (usage.input_tokens ?? 0) +
          (usage.cache_creation_input_tokens ?? 0) +
          (usage.cache_read_input_tokens ?? 0),
        outputTokens: usage.output_tokens ?? 0,
        usd: parsed.total_cost_usd,
      });

      if (parsed.is_error && !LIMIT_SUBTYPES.has(parsed.subtype)) {
        // The agent could not work at all (bad key, API down, overloaded).
        // That is an infrastructure failure for the step queue to retry, not
        // an attempt for the gates to judge.
        const message = `claude failed (${parsed.subtype}): ${(parsed.result ?? run.stderr).slice(0, 2_000)}`;
        throw new StepError(message, {
          failureClass: /api key|authenticat|unauthori[sz]ed|permission|billing|credit/i.test(message)
            ? 'permanent'
            : 'transient',
        });
      }

      // Running out of budget or turns is not a crash: whatever the agent
      // left behind is committed and the gates judge it.
      const stopped = parsed.is_error ? ` (stopped early: ${parsed.subtype})` : '';
      return { summary: `${model}${stopped}: ${parsed.result ?? ''}`.trim() };
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }
}

function parseResult(stdout: string): z.infer<typeof resultSchema> | null {
  // The JSON result is the last line; anything before it is noise.
  const lines = stdout.trim().split('\n').reverse();
  for (const line of lines) {
    try {
      const parsed = resultSchema.safeParse(JSON.parse(line));
      if (parsed.success) return parsed.data;
    } catch {}
  }
  return null;
}

function runAgent(
  bin: string,
  args: readonly string[],
  stdin: string,
  options: { cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal },
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-20_000);
    });
    const kill = () => {
      if (child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {}
      }
    };
    options.signal.addEventListener('abort', kill, { once: true });
    child.on('error', (error) => {
      options.signal.removeEventListener('abort', kill);
      reject(new StepError(`could not start ${bin}: ${error.message}`, { failureClass: 'permanent' }));
    });
    child.on('close', (exitCode) => {
      options.signal.removeEventListener('abort', kill);
      resolve({ exitCode, stdout, stderr });
    });
    child.stdin.end(stdin);
  });
}
