import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCommand } from './gates.ts';

const signal = new AbortController().signal;

// Like a real workspace: a checkout inside its own temp directory.
let parent: string;
let checkout: string;
beforeAll(async () => {
  parent = await mkdtemp(join(tmpdir(), 'gates-test-'));
  checkout = join(parent, 'repo');
  await mkdir(checkout);
});
afterAll(async () => {
  await rm(parent, { recursive: true, force: true });
});

describe('runCommand', () => {
  it('reports the exit code and output', async () => {
    const run = await runCommand(
      ['node', '-e', 'console.log("hi"); process.exit(3)'],
      checkout,
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
        checkout,
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
        checkout,
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
    const run = await runCommand(['node', '-e', 'setTimeout(() => {}, 60_000)'], checkout, 300, signal);

    expect(run.timedOut).toBe(true);
  });

  it('reports a missing program as a failure, not a crash', async () => {
    const run = await runCommand(['definitely-not-a-program'], checkout, 10_000, signal);

    expect(run.exitCode).not.toBe(0);
  });
});
