import { tmpdir } from 'node:os';
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

  it('kills a command that runs past its timeout', async () => {
    const run = await runCommand(['node', '-e', 'setTimeout(() => {}, 60_000)'], tmpdir(), 300, signal);

    expect(run.timedOut).toBe(true);
  });

  it('reports a missing program as a failure, not a crash', async () => {
    const run = await runCommand(['definitely-not-a-program'], tmpdir(), 10_000, signal);

    expect(run.exitCode).not.toBe(0);
  });
});
