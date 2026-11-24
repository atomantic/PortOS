import { describe, expect, it, vi } from 'vitest';
import { registerMediaJobTerminalHooks } from '../bootHookRegistry.js';
import { createMediaJobHookLoader } from './hookRegistry.js';

describe('media job hook registration', () => {
  it('fails loudly when default hooks are requested before boot registration and uses them after', async () => {
    expect(() => createMediaJobHookLoader()).toThrow(/not registered/);
    const ran = vi.fn().mockResolvedValue(undefined);
    registerMediaJobTerminalHooks([[job => Boolean(job.params?.registered), ran]]);
    const prepare = createMediaJobHookLoader();
    await prepare({ params: { registered: true } });
    expect(ran).toHaveBeenCalledTimes(1);
  });

  it('loads only matching modules and retains successful siblings across a retry', async () => {
    const ready = Promise.withResolvers();
    const subscribe = vi.fn(() => ready.promise);
    const intermittent = vi.fn().mockRejectedValueOnce(new Error('module unavailable')).mockResolvedValue(undefined);
    const other = vi.fn();
    const prepare = createMediaJobHookLoader([
      [job => job.params?.example, subscribe],
      [job => job.params?.example, intermittent],
      [job => job.owner === 'other', other],
    ]);
    await prepare({ params: {} });
    expect(subscribe).not.toHaveBeenCalled();
    const job = { params: { example: true } };
    const outcomes = Promise.allSettled([prepare(job), prepare(job)]);
    ready.resolve();
    expect((await outcomes).map(({ reason }) => reason?.code)).toEqual([
      'MEDIA_JOB_HOOK_LOAD_FAILED', 'MEDIA_JOB_HOOK_LOAD_FAILED',
    ]);
    await prepare(job);
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(intermittent).toHaveBeenCalledTimes(2);
    expect(other).not.toHaveBeenCalled();
  });
});
