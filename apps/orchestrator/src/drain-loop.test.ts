import { describe, expect, it, vi } from 'vitest';
import { runDrainLoop } from './drain-loop.ts';

describe('drain loop', () => {
  it('works through waiting items, then idles until stopped', async () => {
    const controller = new AbortController();
    const next = vi
      .fn()
      .mockResolvedValueOnce('run a moved to Triage')
      .mockResolvedValueOnce('run b moved to Triage')
      .mockImplementation(async () => {
        controller.abort();
        return null;
      });
    const log = { info: vi.fn(), error: vi.fn() };

    await runDrainLoop({ name: 'intake', next, idleDelayMs: 10_000, signal: controller.signal, log });

    expect(next).toHaveBeenCalledTimes(3);
    expect(log.info.mock.calls).toEqual([['run a moved to Triage'], ['run b moved to Triage']]);
  });

  it('keeps going after a failed iteration', async () => {
    const controller = new AbortController();
    const next = vi
      .fn()
      .mockRejectedValueOnce(new Error('database restarting'))
      .mockImplementation(async () => {
        controller.abort();
        return null;
      });
    const log = { info: vi.fn(), error: vi.fn() };

    await runDrainLoop({ name: 'intake', next, idleDelayMs: 1, signal: controller.signal, log });

    expect(log.error).toHaveBeenCalledWith('intake iteration failed', expect.any(Error));
    expect(next).toHaveBeenCalledTimes(2);
  });
});
