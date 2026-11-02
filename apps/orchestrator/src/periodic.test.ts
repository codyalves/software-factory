import { describe, expect, it, vi } from 'vitest';
import { runPeriodically } from './periodic.ts';

describe('runPeriodically', () => {
  it('keeps running after a failure and stops on signal', async () => {
    const controller = new AbortController();
    const log = { error: vi.fn() };
    let calls = 0;

    await runPeriodically(
      'test task',
      async () => {
        calls++;
        if (calls === 1) throw new Error('boom');
        if (calls === 3) controller.abort();
      },
      { intervalMs: 1, signal: controller.signal, log },
    );

    expect(calls).toBe(3);
    expect(log.error).toHaveBeenCalledWith('test task failed', expect.any(Error));
  });
});
