import { EventEmitter } from 'node:events';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { expectAuthorizedWorkflows } from './hostControlTestHarness.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-messaging-authority-') }));
afterAll(cleanupTempDataRoots);

// Every write here is gated by the default-deny policy (#16018); the refusal and
// principal matrix live in services/authGate.test.js and server/test/guards/modules/hostControlCoverage.test.js.
// This suite proves each mounted router still runs behind the real gates for a
// local operator and a delegated agent session. The Beeper, Messages and Review
// services are doubled so nothing reaches Beeper, a browser tab or the draft store.
const auth = vi.hoisted(() => ({ enabled: false }));
const effects = vi.hoisted(() => ({
  archive: vi.fn(async () => ({ id: 'example-conversation', isArchived: true })),
  approve: vi.fn(async (id) => ({ id, status: 'approved' })),
  resolveQueueItem: vi.fn(async () => ({ resolved: true })),
}));
vi.mock('../services/auth.js', async (importOriginal) => ({
  ...await importOriginal(),
  isAuthEnabled: vi.fn(async () => auth.enabled),
}));
vi.mock('../services/settings.js', () => ({
  settingsEvents: new EventEmitter(), getSettings: vi.fn(async () => ({})), updateSettingsWith: vi.fn(),
}));
vi.mock('../services/beeperConversations.js', () => ({ setConversationArchived: effects.archive }));
vi.mock('../services/messageDrafts.js', async (importOriginal) => ({ ...await importOriginal(), approveDraft: effects.approve }));
// Service graphs the mounted routers import; their handlers are not reached.
vi.mock('../services/beeperSync.js', () => ({}));
vi.mock('../services/beeperStatus.js', () => ({}));
vi.mock('../services/beeperOAuth.js', () => ({}));
vi.mock('../services/beeperOutbox.js', () => ({}));
vi.mock('../services/beeperAttachments.js', () => ({}));
vi.mock('../services/messageSync.js', () => ({}));
vi.mock('../services/messageAccounts.js', () => ({}));
vi.mock('../services/review.js', () => ({ reviewEvents: { emit: vi.fn() } }));
vi.mock('../services/reviewQueue.js', () => ({
  buildQueue: vi.fn(), MAX_REVIEW_QUEUE_SNOOZE_MS: 30 * 24 * 60 * 60 * 1000,
  resolveQueueItem: effects.resolveQueueItem, triageQueueItem: vi.fn(), promoteAskQueueItem: vi.fn(),
}));


const ACCOUNT = '00000000-0000-4000-8000-000000000001';
const DRAFT = '22222222-2222-4222-8222-222222222222';
// One write per router: [method, path, body, effect, success status].
const workflows = [
  ['post', `/api/beeper/conversations/${ACCOUNT}/archive`, { archived: true }, effects.archive, 200],
  ['post', `/api/messages/drafts/${DRAFT}/approve`, {}, effects.approve, 200],
  ['post', '/api/review/queue/resolve', { id: `drafts:${DRAFT}`, operation: 'approve' }, effects.resolveQueueItem, 200],
];

const mounts = [
  ['/api/beeper', (await import('./beeper.js')).default],
  ['/api/messages', (await import('./messages.js')).default],
  ['/api/review', (await import('./review.js')).default],
];

beforeEach(() => {
  vi.clearAllMocks();
  auth.enabled = false;
});

describe('Beeper, Messages and Review routers behind the default-deny gate (#16114)', () => {
  it('still run for a local operator and a delegated agent session', async () => {
    await expectAuthorizedWorkflows({ auth, mounts, workflows });
    expect(effects.archive).toHaveBeenLastCalledWith(ACCOUNT, true);
    expect(effects.approve).toHaveBeenLastCalledWith(DRAFT);
    expect(effects.resolveQueueItem).toHaveBeenLastCalledWith(`drafts:${DRAFT}`, 'approve');
  });
});
