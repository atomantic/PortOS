import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { expectAuthorizedWorkflows } from './hostControlTestHarness.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-review-authority-') }));
afterAll(cleanupTempDataRoots);

// Review facade resolution (CoS task approval among it), triage and Ask promotion
// are plain writes under the default-deny gate (#16018), whose principal matrix
// lives in services/authGate.test.js. This suite keeps the router's authorized
// workflow: CoS approval and Ask-to-task promotion reach their sinks unchanged.
const auth = vi.hoisted(() => ({ enabled: false }));
const effects = vi.hoisted(() => ({
  resolveQueueItem: vi.fn(async () => ({ resolved: true })),
  promoteAskQueueItem: vi.fn(async () => ({ promoted: true })),
  triageQueueItem: vi.fn(async () => ({ triaged: true })),
}));
vi.mock('../services/auth.js', async (importOriginal) => ({
  ...await importOriginal(), isAuthEnabled: vi.fn(async () => auth.enabled),
}));
vi.mock('../services/settings.js', () => ({
  settingsEvents: new EventEmitter(), getSettings: vi.fn(async () => ({})),
}));
vi.mock('../services/instanceIdentity.js', () => ({ loadData: vi.fn(async () => ({ peers: [] })) }));
vi.mock('../services/review.js', () => ({ reviewEvents: { emit: vi.fn() } }));
vi.mock('../services/reviewQueue.js', () => ({
  buildQueue: vi.fn(), MAX_REVIEW_QUEUE_SNOOZE_MS: 30 * 24 * 60 * 60 * 1000, ...effects,
}));
const mounts = [['/api/review', (await import('./review.js')).default]];

beforeEach(() => {
  vi.clearAllMocks();
  auth.enabled = false;
});

describe('Review facade behind the default-deny gate (#16114)', () => {
  it('still approves a CoS task and promotes an Ask into a task for a local operator and a delegated agent session', async () => {
    await expectAuthorizedWorkflows({ auth, mounts, workflows: [
      ['post', '/api/review/queue/resolve', { id: 'cos:example-task', operation: 'approve' }, effects.resolveQueueItem, 200],
      ['post', '/api/review/queue/promote-ask', { id: 'ask:example-conversation', target: 'task' }, effects.promoteAskQueueItem, 200],
    ] });
    expect(effects.resolveQueueItem).toHaveBeenLastCalledWith('cos:example-task', 'approve');
  });
});
