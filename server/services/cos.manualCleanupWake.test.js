import { expect, it, vi } from 'vitest';

const retry = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('./investigationRetry.js', () => ({ retryTasksResolvedByInvestigation: retry }));
vi.mock('./cosState.js', async original => ({
  ...await original(), ensureDirectories: vi.fn(async () => {}),
  isDaemonRunning: () => true, loadState: vi.fn(async () => { throw new Error('synthetic state unavailable'); }),
}));

const { init } = await import('./cos.js');
const { cosEvents } = await import('./cosEvents.js');
const drain = () => new Promise(resolve => setImmediate(() => setImmediate(resolve)));

it('does not wake investigation retries for cleanup-only settlement, but still wakes ordinary completion', async () => {
  await init().catch(() => {});
  const held = { id: 'cleanup-only', status: 'completed', metadata: { isInvestigation: true } };
  const normal = { id: 'ordinary', status: 'completed', metadata: { isInvestigation: true } };
  cosEvents.emit('tasks:changed', { action: 'updated', task: held, previousStatus: 'in_progress', suppressCompletionWake: true });
  await drain();
  expect(retry).not.toHaveBeenCalled();
  cosEvents.emit('tasks:changed', { action: 'updated', task: normal, previousStatus: 'in_progress' });
  await drain();
  expect(retry).toHaveBeenCalledExactlyOnceWith(normal);
});
