import type { RunSummary } from '@factory/db';
import { describe, expect, it, vi } from 'vitest';
import { runIntakeLoop } from './intake-loop.ts';

const run = (id: string): RunSummary => ({ id, requirementId: 'q', state: 'Triage', implementAttempts: 0 });

describe('intake loop', () => {
  it('drains waiting runs, then idles until stopped', async () => {
    const controller = new AbortController();
    const advanceNext = vi
      .fn()
      .mockResolvedValueOnce(run('a'))
      .mockResolvedValueOnce(run('b'))
      .mockImplementation(async () => {
        controller.abort();
        return null;
      });
    const log = { info: vi.fn(), error: vi.fn() };

    await runIntakeLoop({ runs: { advanceNext }, idleDelayMs: 10_000, signal: controller.signal, log });

    expect(advanceNext).toHaveBeenCalledTimes(3);
    expect(log.info).toHaveBeenCalledWith('run a moved to Triage');
    expect(log.info).toHaveBeenCalledWith('run b moved to Triage');
  });

  it('keeps going after a failed iteration', async () => {
    const controller = new AbortController();
    const advanceNext = vi
      .fn()
      .mockRejectedValueOnce(new Error('database restarting'))
      .mockImplementation(async () => {
        controller.abort();
        return null;
      });
    const log = { info: vi.fn(), error: vi.fn() };

    await runIntakeLoop({ runs: { advanceNext }, idleDelayMs: 1, signal: controller.signal, log });

    expect(log.error).toHaveBeenCalledOnce();
    expect(advanceNext).toHaveBeenCalledTimes(2);
  });
});
