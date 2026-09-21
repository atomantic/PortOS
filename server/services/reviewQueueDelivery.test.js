import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

const mock = vi.hoisted(() => ({ buildQueue: vi.fn(), getNotifications: vi.fn(), getPostConfig: vi.fn() }));
vi.mock('./meatspacePost.js', () => ({ getPostConfig: mock.getPostConfig }));
vi.mock('./cosState.js', () => ({ getDomainAutonomyMode: vi.fn().mockResolvedValue('execute') }));
vi.mock('./domainUsage.js', () => ({
  getDomainBudgetStatus: vi.fn().mockResolvedValue({ withinBudget: true }),
  recordDomainUsage: vi.fn().mockResolvedValue(),
}));
vi.mock('./memoryBackend.js', () => ({ peekMemory: vi.fn().mockResolvedValue(null) }));
vi.mock('./reviewQueue.js', () => ({ buildQueue: mock.buildQueue }));
vi.mock('./notifications.js', () => ({ getNotifications: mock.getNotifications }));
vi.mock('../lib/fileUtils.js', async (original) => makePathsProxy(await original(), {
  dataRoot: () => lazyTempDataRoot('action-delivery-'),
}));

import { claimActionDelivery, claimQueueDelivery } from './reviewQueueDelivery.js';
import { forwardNotification } from './telegramForward.js';
import { listReviewQueueTriage, resetReviewQueueTriageStore } from './reviewQueueTriageStore.js';

const action = { id: 'health:disk', occurrence: 'incident-1', revision: 'v1', severity: 'high' };
beforeEach(async () => {
  resetReviewQueueTriageStore();
  await rm(join(lazyTempDataRoot('action-delivery-'), 'review-queue-triage.json'), { force: true });
  mock.getNotifications.mockResolvedValue([]);
  mock.getPostConfig.mockResolvedValue({ reminder: { enabled: true } });
  mock.buildQueue.mockResolvedValue({ items: [] });
});
afterAll(cleanupTempDataRoots);

describe('durable action delivery', () => {
  it('deduplicates correlated forwards across transports/reloads without changing legacy forwarding or type gates', async () => {
    const sendMessage = vi.fn().mockResolvedValue({});
    const deps = { cachedForwardTypes: [], sendMessage };
    const notice = { type: 'memory_approval', title: 'Review memory', link: '/cos/memory', metadata: { memoryId: 'example-memory' } };
    mock.buildQueue.mockResolvedValue({ items: [{ id: 'memory:example-memory', occurrence: null, severity: 'high' }] });
    await forwardNotification(notice, { ...deps, cachedForwardTypes: ['briefing_ready'] });
    expect(await listReviewQueueTriage()).toEqual([]);
    await forwardNotification(notice, deps);
    resetReviewQueueTriageStore();
    await forwardNotification(notice, deps);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    mock.buildQueue.mockResolvedValue({ items: [{ id: 'memory:example-memory', occurrence: null, severity: 'critical' }] });
    await forwardNotification(notice, deps);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    const legacy = { type: 'agent_warning', title: 'Legacy context', metadata: {} };
    await forwardNotification(legacy, deps);
    await forwardNotification(legacy, deps);
    expect(sendMessage).toHaveBeenCalledTimes(4);
  });

  it('claims once across tabs and reloads, ignores text revisions, and advances one generation only on escalation', async () => {
    const claims = await Promise.all([claimActionDelivery(action, 'toast'), claimActionDelivery(action, 'toast')]);
    expect(claims.map(result => result.claimed)).toEqual([true, false]);
    resetReviewQueueTriageStore();
    expect(await claimActionDelivery({ ...action, revision: 'v2' }, 'toast')).toEqual({ claimed: false, generation: 0 });
    expect(await claimActionDelivery({ ...action, severity: 'critical' }, 'toast')).toEqual({ claimed: true, generation: 1 });
    expect(await claimActionDelivery(action, 'toast')).toEqual({ claimed: false, generation: 1 });
    expect(await claimActionDelivery({ ...action, severity: 'critical' }, 'telegram')).toEqual({ claimed: true, generation: 1 });
    const markers = await listReviewQueueTriage();
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ deliveryGeneration: 1, delivery: { channels: { toast: 1, telegram: 1 } } });
    expect(markers[0]).not.toHaveProperty('title');
    expect(await claimActionDelivery({ ...action, occurrence: 'incident-2' }, 'toast')).toEqual({ claimed: true, generation: 0 });
  });

  it('allows product toasts only after an opted-in reminder for the same occurrence, and rechecks snooze/completion', async () => {
    const product = { id: 'product:daily-post', source: 'product', occurrence: '2026-09-20', severity: 'high' };
    mock.buildQueue.mockResolvedValue({ items: [product] });
    expect(await claimQueueDelivery(product.id)).toEqual({ claimed: false });
    mock.getNotifications.mockResolvedValue([{
      type: 'daily_post_reminder', metadata: { actionId: product.id, occurrence: '2026-09-19' },
    }]);
    expect(await claimQueueDelivery(product.id)).toEqual({ claimed: false });
    mock.getNotifications.mockResolvedValue([{
      type: 'daily_post_reminder', metadata: { actionId: product.id, occurrence: product.occurrence },
    }]);
    expect(await claimQueueDelivery(product.id)).toEqual({ claimed: true, generation: 0 });
    mock.getPostConfig.mockResolvedValue({ reminder: { enabled: false } });
    expect(await claimQueueDelivery(product.id)).toEqual({ claimed: false });
    mock.getPostConfig.mockResolvedValue({ reminder: { enabled: true } });
    resetReviewQueueTriageStore();
    expect(await claimQueueDelivery(product.id)).toEqual({ claimed: false, generation: 0 });
    mock.buildQueue.mockResolvedValue({ items: [] });
    expect(await claimQueueDelivery(product.id, 'telegram')).toEqual({ claimed: false });
  });

  it('does not claim delivery when the queue is unavailable', async () => {
    mock.buildQueue.mockRejectedValue(new Error('queue unavailable'));
    await expect(claimQueueDelivery(action.id)).rejects.toThrow('queue unavailable');
    expect(await listReviewQueueTriage()).toEqual([]);
  });
});
