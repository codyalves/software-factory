import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ReproTest } from '@factory/domain';

export interface Confirmation {
  readonly runs: number;
  readonly failures: number;
  /** True only if the test failed on every run: a real, repeatable problem. */
  readonly confirmed: boolean;
  /** Why it was not confirmed, when it was not. */
  readonly reason: string | null;
}

/** Passed through to the test runner: where browsers live, and network plumbing. */
const PASS_THROUGH = [
  'PATH',
  'PLAYWRIGHT_BROWSERS_PATH',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
] as const;

/**
 * Runs a repro test against the running app, `runs` times with no retries.
 * A finding is filed only if every run fails: a test that sometimes passes
 * is flaky, and a flaky report would send the dev loop chasing noise.
 *
 * `workdir` is a checkout of the target with its dependencies installed and
 * a Playwright config that reads BASE_URL. The test file is removed after.
 */
export async function confirmRepro(
  repro: ReproTest,
  options: { workdir: string; baseUrl: string; runs?: number; timeoutMs?: number; playwrightBin?: string },
): Promise<Confirmation> {
  const runs = options.runs ?? 3;
  const file = join(options.workdir, repro.path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, repro.content);
  try {
    const env: Record<string, string> = {
      CI: '1',
      BASE_URL: options.baseUrl,
      HOME: process.env.HOME ?? '/tmp',
    };
    for (const name of PASS_THROUGH) {
      const value = process.env[name];
      if (value) env[name] = value;
    }
    const run = await exec(
      options.playwrightBin ?? join(options.workdir, 'node_modules', '.bin', 'playwright'),
      ['test', repro.path, `--repeat-each=${runs}`, '--retries=0', '--workers=1', '--reporter=json'],
      options.workdir,
      env,
      options.timeoutMs ?? 300_000,
    );
    const report = parseReport(run.stdout);
    if (!report) {
      return {
        runs,
        failures: 0,
        confirmed: false,
        reason: `the test runner gave no report: ${run.stderr.slice(-500)}`,
      };
    }
    if (report.errors > 0 && report.unexpected === 0) {
      return {
        runs,
        failures: 0,
        confirmed: false,
        reason: 'the test could not run (it has an error of its own)',
      };
    }
    const failures = report.unexpected;
    return {
      runs,
      failures,
      confirmed: failures === runs,
      reason:
        failures === runs
          ? null
          : failures === 0
            ? 'the test passes: not reproducible'
            : `flaky: failed ${failures} of ${runs}`,
    };
  } finally {
    await rm(file, { force: true });
  }
}

function parseReport(stdout: string): { unexpected: number; errors: number } | null {
  const start = stdout.indexOf('{');
  if (start === -1) return null;
  try {
    const json = JSON.parse(stdout.slice(start)) as { stats?: { unexpected?: number }; errors?: unknown[] };
    return { unexpected: json.stats?.unexpected ?? 0, errors: json.errors?.length ?? 0 };
  } catch {
    return null;
  }
}

function exec(
  file: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(file, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => {
      stdout += c.toString('utf8');
    });
    child.stderr.on('data', (c: Buffer) => {
      stderr = (stderr + c.toString('utf8')).slice(-10_000);
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: `${stderr}\n${error.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}
