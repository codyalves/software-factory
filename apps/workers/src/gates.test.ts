import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCommand } from './gates.ts';

const signal = new AbortController().signal;

describe('runCommand', () => {
  it('reports the exit code and output', async () => {
    const run = await runCommand(
      ['node', '-e', 'console.log("hi"); process.exit(3)'],
      tmpdir(),
      10_000,
      signal,
    );

    expect(run).toEqual({ exitCode: 3, timedOut: false, output: 'hi\n' });
  });

  it('runs without the factory secrets in its environment', async () => {
    process.env.FACTORY_TEST_SECRET = 'do-not-leak';
    try {
      const run = await runCommand(
        ['node', '-e', 'console.log(process.env.FACTORY_TEST_SECRET ?? "absent")'],
        tmpdir(),
        10_000,
        signal,
      );
      expect(run.output.trim()).toBe('absent');
    } finally {
      delete process.env.FACTORY_TEST_SECRET;
    }
  });

  it('keeps proxy settings so installs work behind a corporate proxy', async () => {
    const saved = process.env.HTTPS_PROXY;
    process.env.HTTPS_PROXY = 'http://proxy.example:3128';
    try {
      const run = await runCommand(
        ['node', '-e', 'console.log(process.env.HTTPS_PROXY)'],
        tmpdir(),
        10_000,
        signal,
      );
      expect(run.output.trim()).toBe('http://proxy.example:3128');
    } finally {
      if (saved === undefined) delete process.env.HTTPS_PROXY;
      else process.env.HTTPS_PROXY = saved;
    }
  });

  it('gives the command a HOME outside the checkout, so caches never land in the repo', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'home-test-'));
    const repo = join(parent, 'repo');
    await mkdir(repo);
    try {
      const run = await runCommand(['node', '-e', 'console.log(process.env.HOME)'], repo, 10_000, signal);

      const home = run.output.trim();
      expect(home).toBe(join(parent, 'repo-home'));
      expect(home.startsWith(`${repo}/`)).toBe(false);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('kills a command that runs past its timeout', async () => {
    const run = await runCommand(['node', '-e', 'setTimeout(() => {}, 60_000)'], tmpdir(), 300, signal);

    expect(run.timedOut).toBe(true);
  });

  it('reports a missing program as a failure, not a crash', async () => {
    const run = await runCommand(['definitely-not-a-program'], tmpdir(), 10_000, signal);

    expect(run.exitCode).not.toBe(0);
  });
});
