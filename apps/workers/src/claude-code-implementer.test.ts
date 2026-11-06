import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  allowedTools,
  ClaudeCodeImplementer,
  implementationPrompt,
  modelForAttempt,
} from './claude-code-implementer.ts';
import type { ImplementInput } from './implementer.ts';

const prompt = { text: 'You are the implementer.', version: 'implement.v1@abc123abc123' };

let root: string;
let dir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cc-test-'));
  dir = join(root, 'repo');
  await mkdir(dir);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/**
 * A stand-in for the claude CLI: records its arguments, environment and
 * stdin, edits a file like an agent would, and prints `output`.
 */
async function fakeClaude(output: string, exitCode = 0): Promise<string> {
  const bin = join(root, 'claude');
  await writeFile(
    bin,
    [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      "let stdin = '';",
      "process.stdin.on('data', (c) => { stdin += c; });",
      "process.stdin.on('end', () => {",
      "  fs.writeFileSync('.call.json', JSON.stringify({ args: process.argv.slice(2), env: process.env, stdin }));",
      "  fs.writeFileSync('year.js', 'export const footerYear = () => new Date().getFullYear();\\n');",
      `  process.stdout.write(${JSON.stringify(output)});`,
      `  process.exit(${exitCode});`,
      '});',
    ].join('\n'),
  );
  await chmod(bin, 0o755);
  return bin;
}

const success = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'Fixed the year; AC-1 covered by year.test.js.',
  total_cost_usd: 0.4213,
  num_turns: 9,
  usage: {
    input_tokens: 1200,
    output_tokens: 3400,
    cache_creation_input_tokens: 5000,
    cache_read_input_tokens: 40000,
  },
});

function input(overrides: Partial<ImplementInput> = {}): ImplementInput {
  return {
    dir,
    issue: {
      repo: 'codyalves/target',
      number: 7,
      title: 'Footer shows last year',
      body: '- The footer shows the current year',
    },
    criteria: [{ id: 'AC-1', text: 'The footer shows the current year' }],
    attempt: 1,
    feedback: null,
    commands: [
      ['pnpm', 'install', '--frozen-lockfile'],
      ['pnpm', 'test'],
    ],
    protectedPaths: ['.github/**', 'package.json'],
    ...overrides,
  };
}

function implementer(bin: string) {
  return new ClaudeCodeImplementer({
    apiKey: 'sk-ant-test-key',
    prompt,
    model: 'claude-sonnet-5-5',
    frontierModel: 'claude-opus-5-5',
    escalateAfter: 2,
    maxBudgetUsd: 1.25,
    bin,
  });
}

const context = () => ({ signal: new AbortController().signal, recordUsage: vi.fn() });

async function recordedCall() {
  return JSON.parse(await readFile(join(dir, '.call.json'), 'utf8')) as {
    args: string[];
    env: Record<string, string>;
    stdin: string;
  };
}

describe('ClaudeCodeImplementer', () => {
  it('runs headless with a budget cap, an allow-list and only the API key', async () => {
    process.env.GITHUB_TOKEN = 'ghs_should_not_leak';
    try {
      const ctx = context();
      const result = await implementer(await fakeClaude(success)).implement(input(), ctx);

      expect(result.summary).toBe('claude-sonnet-5-5: Fixed the year; AC-1 covered by year.test.js.');
      const call = await recordedCall();
      expect(call.args).toEqual(
        expect.arrayContaining(['--print', '--bare', '--no-session-persistence', '--strict-mcp-config']),
      );
      const flag = (name: string) => call.args[call.args.indexOf(name) + 1];
      expect(flag('--model')).toBe('claude-sonnet-5-5');
      expect(flag('--max-budget-usd')).toBe('1.25');
      expect(flag('--permission-mode')).toBe('dontAsk');
      expect(call.args).toContain('Bash(pnpm test:*)');
      expect(call.args).not.toContain('Bash');
      expect(call.env.ANTHROPIC_API_KEY).toBe('sk-ant-test-key');
      expect(call.env.GITHUB_TOKEN).toBeUndefined();
      expect(call.env.HOME).not.toBe(process.env.HOME);
    } finally {
      delete process.env.GITHUB_TOKEN;
    }
  });

  it('meters the run from its own cost report, counting cache tokens as input', async () => {
    const ctx = context();

    await implementer(await fakeClaude(success)).implement(input(), ctx);

    expect(ctx.recordUsage).toHaveBeenCalledWith({
      model: 'claude-sonnet-5-5',
      inputTokens: 46_200,
      outputTokens: 3_400,
      usd: 0.4213,
    });
  });

  it('hands the issue over as delimited data, with criteria, limits and earlier failures', async () => {
    await implementer(await fakeClaude(success)).implement(
      input({ attempt: 2, feedback: '### Gate failed: traceability' }),
      context(),
    );

    const { stdin } = await recordedCall();
    expect(stdin).toContain('<issue>\nTitle: Footer shows last year');
    expect(stdin).toContain('- AC-1: The footer shows the current year');
    expect(stdin).toContain('Protected paths, do not change: .github/**, package.json');
    expect(stdin).toContain('<previous_attempt_failures>\n### Gate failed: traceability');
  });

  it('switches to the frontier model after repeated failures', async () => {
    await implementer(await fakeClaude(success)).implement(input({ attempt: 3 }), context());

    const { args } = await recordedCall();
    expect(args[args.indexOf('--model') + 1]).toBe('claude-opus-5-5');
  });

  it('treats running out of budget as a finished attempt for the gates to judge', async () => {
    const ctx = context();
    const stopped = JSON.stringify({
      type: 'result',
      subtype: 'error_max_budget_usd',
      is_error: true,
      total_cost_usd: 1.25,
      usage: { input_tokens: 10, output_tokens: 10 },
    });

    const result = await implementer(await fakeClaude(stopped, 1)).implement(input(), ctx);

    expect(result.summary).toContain('stopped early: error_max_budget_usd');
    expect(ctx.recordUsage).toHaveBeenCalledWith(expect.objectContaining({ usd: 1.25 }));
  });

  it('fails the step instead of spending an attempt when claude cannot work at all', async () => {
    const invalidKey = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: true,
      result: 'Invalid API key · Fix external API key',
      total_cost_usd: 0,
      usage: {},
    });
    const overloaded = JSON.stringify({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      result: 'API Error: 529 overloaded',
      total_cost_usd: 0.01,
      usage: {},
    });

    await expect(
      implementer(await fakeClaude(invalidKey, 1)).implement(input(), context()),
    ).rejects.toMatchObject({
      failureClass: 'permanent',
    });
    const ctx = context();
    await expect(implementer(await fakeClaude(overloaded, 1)).implement(input(), ctx)).rejects.toMatchObject({
      failureClass: 'transient',
    });
    // Anything already spent is still metered.
    expect(ctx.recordUsage).toHaveBeenCalledWith(expect.objectContaining({ usd: 0.01 }));
  });

  it('fails the step, retryably, when claude dies without a result', async () => {
    await expect(implementer(await fakeClaude('', 137)).implement(input(), context())).rejects.toMatchObject({
      failureClass: 'transient',
    });
  });

  it('fails the step permanently when claude is not installed', async () => {
    await expect(
      implementer(join(root, 'missing-claude')).implement(input(), context()),
    ).rejects.toMatchObject({
      failureClass: 'permanent',
    });
  });
});

describe('helpers', () => {
  it('escalates the model only after the configured number of attempts', () => {
    const options = { model: 'sonnet', frontierModel: 'opus', escalateAfter: 2 };
    expect([1, 2, 3, 4].map((a) => modelForAttempt(a, options))).toEqual([
      'sonnet',
      'sonnet',
      'opus',
      'opus',
    ]);
  });

  it('allows file tools and exactly the listed commands', () => {
    expect(allowedTools([['node', '--test']])).toEqual([
      'Read',
      'Edit',
      'Write',
      'Glob',
      'Grep',
      'Bash(git status:*)',
      'Bash(git diff:*)',
      'Bash(git log:*)',
      'Bash(ls:*)',
      'Bash(cat:*)',
      'Bash(pwd:*)',
      'Bash(node --test:*)',
    ]);
  });

  it('leaves out the failures section on a first attempt', () => {
    expect(implementationPrompt(input())).not.toContain('previous_attempt_failures');
  });
});
