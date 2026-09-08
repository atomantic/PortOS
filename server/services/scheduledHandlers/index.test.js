import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SCHEDULED_HANDLER_MODULES,
  countScheduledHandlerPending,
  runScheduledHandler,
} from './index.js';

afterEach(() => vi.restoreAllMocks());

// This boundary owns failures from both lazy module initialization and handler
// execution; callers rely on a result to continue draining the remaining work.
describe.each([
  ['probe', countScheduledHandlerPending, 'countPending', { count: 0, detail: 'probe failed: unavailable' }],
  ['run', runScheduledHandler, 'run', { dispatched: false, reason: 'handler failed: unavailable' }],
])('scheduled handler %s', (_label, invoke, method, failure) => {
  const taskType = 'universe-bible-describe';

  it.each(['module load', 'synchronous execution', 'asynchronous execution'])('contains failure during %s', async (phase) => {
    const error = new Error('unavailable');
    const loader = vi.spyOn(SCHEDULED_HANDLER_MODULES, taskType);
    if (phase === 'module load') loader.mockRejectedValue(error);
    else loader.mockResolvedValue({
      [method]: phase === 'synchronous execution'
        ? () => { throw error; }
        : () => Promise.reject(error),
    });

    await expect(invoke({ taskType })).resolves.toEqual(failure);
  });

  it('preserves the handler result and invocation options', async () => {
    const result = method === 'run' ? { dispatched: true, summary: 'Started' } : { count: 2, context: { ids: ['entry-1'] } };
    const handler = vi.fn().mockResolvedValue(result);
    vi.spyOn(SCHEDULED_HANDLER_MODULES, taskType).mockResolvedValue({ [method]: handler });
    const options = { params: { maxEntries: 2 }, job: { model: 'example-model' }, family: { id: 'example-family' } };
    if (method === 'run') Object.assign(options, { context: { ids: ['entry-1'] }, force: true });

    await expect(invoke({ taskType, ...options })).resolves.toBe(result);
    expect(handler).toHaveBeenCalledWith(options);
  });

  it('declines inherited registry keys without loading a handler', async () => {
    const loader = vi.spyOn(SCHEDULED_HANDLER_MODULES, taskType);
    const message = 'unknown scheduled handler: constructor';
    await expect(invoke({ taskType: 'constructor' })).resolves.toEqual(
      method === 'run' ? { dispatched: false, reason: message } : { count: 0, detail: message },
    );
    expect(loader).not.toHaveBeenCalled();
  });
});
