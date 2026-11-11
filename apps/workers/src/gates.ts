import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  type AcceptanceCriterion,
  changesGate,
  type GateResult,
  type MeasuredRisk,
  measureRisk,
  protectedPathsGate,
  secretScan,
  type TraceLink,
  testsAddedBy,
  traceabilityGate,
} from '@factory/domain';
import { z } from 'zod';
import { networkEnv } from './env.ts';
import type { Workspace } from './workspace.ts';

const argv = z.array(z.string().min(1)).min(1);

const targetSchema = z.object({
  baseBranch: z.string().min(1).default('main'),
  /** Run before the gates, in order; a failure fails every command gate. */
  setup: z.array(argv).default([]),
  /** Gate name -> command. Each must exit 0. Commands run without a shell. */
  gates: z.record(z.string().regex(/^[a-z][a-z0-9_]*$/), argv),
  /** Paths the implementer may not change. */
  protectedPaths: z.array(z.string().min(1)).default([]),
  /** Changing these raises the measured risk of the work, whatever triage predicted. */
  riskPaths: z
    .object({ high: z.array(z.string().min(1)).default([]), medium: z.array(z.string().min(1)).default([]) })
    .default({ high: [], medium: [] }),
  commandTimeoutMs: z.number().int().positive().default(600_000),
});

export type TargetConfig = z.infer<typeof targetSchema>;

const targetsSchema = z.record(z.string().regex(/^[\w.-]+\/[\w.-]+$/), targetSchema);

/**
 * gates/targets.json: how the factory builds and checks each target repo.
 * It lives in the factory repo (CODEOWNERS-protected), not in the target, so
 * an agent working in the target cannot change how its work is judged.
 */
export async function loadTargets(path: string): Promise<Readonly<Record<string, TargetConfig>>> {
  return targetsSchema.parse(JSON.parse(await readFile(path, 'utf8')));
}

export interface GateRun {
  readonly gates: readonly GateResult[];
  readonly links: readonly TraceLink[];
  /** Risk measured from the paths the change touched. */
  readonly risk: MeasuredRisk;
}

/**
 * Runs every gate against the commit checked out in the workspace. Built-in
 * gates (changes, protected paths, secret scan, traceability) always run; the
 * target's command gates run after its setup.
 */
export async function runGates(input: {
  workspace: Workspace;
  target: TargetConfig;
  criteria: readonly AcceptanceCriterion[];
  baseSha: string;
  headSha: string;
  /** The tester's regression test, committed before the attempt; it counts for traceability. */
  regressionPath?: string | null;
  signal: AbortSignal;
}): Promise<GateRun> {
  const { workspace, target, baseSha, headSha, signal } = input;
  const changed = await workspace.changedPaths(baseSha, headSha);
  const added = await workspace.addedLines(baseSha, headSha);
  const gates: GateResult[] = [
    changesGate(changed),
    protectedPathsGate(changed, target.protectedPaths),
    secretScan(added),
  ];

  let setupFailure: string | null = null;
  for (const command of target.setup) {
    const run = await runCommand(command, workspace.dir, target.commandTimeoutMs, signal);
    if (run.exitCode !== 0) {
      setupFailure = `${command.join(' ')} ${describeExit(run)}`;
      gates.push({ gate: 'setup', passed: false, summary: setupFailure, details: run.output });
      break;
    }
  }

  for (const [gate, command] of Object.entries(target.gates)) {
    if (setupFailure) {
      gates.push({ gate, passed: false, summary: 'not run: setup failed' });
      continue;
    }
    const run = await runCommand(command, workspace.dir, target.commandTimeoutMs, signal);
    gates.push(
      run.exitCode === 0
        ? { gate, passed: true, summary: `${command.join(' ')} passed` }
        : { gate, passed: false, summary: `${command.join(' ')} ${describeExit(run)}`, details: run.output },
    );
  }

  // Only tests this run wrote, plus the regression test it was given, can trace its criteria.
  const tests = testsAddedBy(added).filter((t) => t.path !== input.regressionPath);
  if (input.regressionPath) tests.push(await workspace.testFile(input.regressionPath));
  const trace = traceabilityGate(input.criteria, tests);
  gates.push(trace.result);
  return { gates, links: trace.links, risk: measureRisk(changed, target.riskPaths) };
}

interface CommandRun {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly output: string;
}

function describeExit(run: CommandRun): string {
  return run.timedOut ? 'timed out' : `exited with ${run.exitCode ?? 'a signal'}`;
}

const OUTPUT_LIMIT = 64_000;

/**
 * Runs a gate command in the workspace with a scrubbed environment: no
 * factory secrets, no tokens. Keeps the end of the combined output.
 *
 * Isolation is a process today. Running gates in a container with no
 * network is the next hardening step (docs/adr/0005).
 */
export async function runCommand(
  command: readonly string[],
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<CommandRun> {
  const home = join(dirname(cwd), `${basename(cwd)}-home`);
  await mkdir(home, { recursive: true });
  return new Promise((resolve) => {
    const [file, ...args] = command as [string, ...string[]];
    const child = spawn(file, args, {
      cwd,
      env: {
        ...networkEnv(),
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        // Outside the checkout: tools write caches under HOME, and those must
        // not end up linted, tested or diffed as part of the target.
        HOME: home,
        CI: '1',
        NODE_ENV: 'test',
        LANG: 'C.UTF-8',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    let output = '';
    const append = (chunk: Buffer) => {
      output += chunk.toString('utf8');
      if (output.length > OUTPUT_LIMIT * 2) output = output.slice(-OUTPUT_LIMIT);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);

    let timedOut = false;
    // Kill the whole process group: test runners spawn their own children.
    const kill = () => {
      if (child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {}
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    signal.addEventListener('abort', kill, { once: true });

    const finish = (exitCode: number | null) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', kill);
      resolve({ exitCode, timedOut, output: output.slice(-OUTPUT_LIMIT) });
    };
    child.on('error', (error) => {
      output += `\n${error.message}`;
      finish(127);
    });
    child.on('close', (code) => finish(code));
  });
}
