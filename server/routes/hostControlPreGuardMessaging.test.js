import { EventEmitter } from 'node:events';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { DEV_PROXY_CLIENT_ADDRESS_HEADER } from '../../lib/portosAuthCore.js';
import { derivePeerAuthToken, PEER_AUTH_HEADER, PEER_INSTANCE_HEADER } from '../lib/peerHttpClient.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-messaging-authority-') }));
afterAll(cleanupTempDataRoots);

// Beeper chat writes, Messages sync/refresh/fetch-full (the operator's signed-in
// Outlook/Teams tab) and mail-draft approval, including its PUT and Review-queue
// spellings, need operator authority (#13055). Real routers behind the real
// gates; the Beeper, Messages and Review services are doubled so nothing
// reaches Beeper, a browser tab or the draft store.
const auth = vi.hoisted(() => ({ enabled: false }));
const effects = vi.hoisted(() => ({
  createConversation: vi.fn(async () => ({ id: 'example-conversation' })),
  archive: vi.fn(async () => ({ id: 'example-conversation', isArchived: true })),
  lowPriority: vi.fn(async () => ({ id: 'example-conversation', isLowPriority: true })),
  sync: vi.fn(async () => ({ success: true, newMessages: 0 })),
  getMessage: vi.fn(async () => ({ id: 'example-message' })),
  refresh: vi.fn(async () => ({ success: true })),
  getAccount: vi.fn(async () => ({ id: 'example-account', type: 'outlook', name: 'Example Mail' })),
  getMessages: vi.fn(async () => ({ messages: [{ id: 'example-message', bodyFull: false }] })),
  refreshMany: vi.fn(async () => ({ updated: 1 })),
  updateDraft: vi.fn(async (id, updates) => ({ id, status: 'draft', ...updates })),
  approve: vi.fn(async (id) => ({ id, status: 'approved' })),
  resolveQueueItem: vi.fn(async () => ({ resolved: true })),
}));
vi.mock('../services/auth.js', async (importOriginal) => ({
  ...await importOriginal(),
  isAuthEnabled: vi.fn(async () => auth.enabled),
  verifyPassword: vi.fn(async () => true),
}));
vi.mock('../services/settings.js', () => ({
  settingsEvents: new EventEmitter(), getSettings: vi.fn(async () => ({})), updateSettingsWith: vi.fn(),
}));
vi.mock('../services/instanceIdentity.js', () => ({
  loadData: vi.fn(async () => ({ peers: [{
    id: 'example-peer', instanceId: 'example-instance', enabled: true, syncSecret: 'a'.repeat(32),
  }] })),
}));
vi.mock('../services/beeperSync.js', () => ({
  runBeeperSweep: vi.fn(), createBeeperConversation: effects.createConversation,
}));
vi.mock('../services/beeperConversations.js', () => ({
  listConversations: vi.fn(), getConversation: vi.fn(), listMessages: vi.fn(), listNetworks: vi.fn(),
  markConversationSeen: vi.fn(), purgeConversation: vi.fn(),
  setConversationArchived: effects.archive, setConversationLowPriority: effects.lowPriority,
}));
vi.mock('../services/beeperStatus.js', () => ({ getBeeperStatus: vi.fn(), checkBeeperConnection: vi.fn() }));
vi.mock('../services/beeperOAuth.js', () => ({
  completeBeeperOAuth: vi.fn(), connectWithPastedToken: vi.fn(), disconnectBeeper: vi.fn(), startBeeperOAuth: vi.fn(),
}));
vi.mock('../services/beeperOutbox.js', () => ({
  clearOutboxBreaker: vi.fn(), createOutboxEntry: vi.fn(), discardOutboxEntry: vi.fn(),
  reconcileOutboxEntry: vi.fn(), listOutboxEntries: vi.fn(), sendOutboxEntry: vi.fn(),
}));
vi.mock('../services/beeperAttachments.js', () => ({
  backfillAttachments: vi.fn(), ensureAttachmentBytes: vi.fn(), getAttachment: vi.fn(),
  getAttachmentSummary: vi.fn(), setAttachmentKeep: vi.fn(),
}));
vi.mock('../services/messageSync.js', async (importOriginal) => ({
  ...await importOriginal(),
  syncAccount: effects.sync, getMessage: effects.getMessage, refreshMessage: effects.refresh,
  getMessages: effects.getMessages, refreshMessages: effects.refreshMany,
}));
vi.mock('../services/messageAccounts.js', async (importOriginal) => ({
  ...await importOriginal(), getAccount: effects.getAccount,
}));
vi.mock('../services/messageDrafts.js', async (importOriginal) => ({
  ...await importOriginal(), updateDraft: effects.updateDraft, approveDraft: effects.approve,
}));
vi.mock('../services/review.js', () => ({ reviewEvents: { emit: vi.fn() } }));
vi.mock('../services/reviewQueue.js', () => ({
  buildQueue: vi.fn(), MAX_REVIEW_QUEUE_SNOOZE_MS: 30 * 24 * 60 * 60 * 1000,
  resolveQueueItem: effects.resolveQueueItem, triageQueueItem: vi.fn(), promoteAskQueueItem: vi.fn(),
}));

import { authGate, hostControlBodyGate, hostControlRouteGate } from '../services/authGate.js';
import { createSession } from '../services/auth.js';
import beeperRoutes from './beeper.js';
import messagesRoutes from './messages.js';
import reviewRoutes from './review.js';

const ACCOUNT = '00000000-0000-4000-8000-000000000001';
const DRAFT = '22222222-2222-4222-8222-222222222222';
// Whole-route gates: the case/trailing-slash spelling must be refused too.
const operations = [
  ['post', '/api/beeper/conversations', { accountId: 'example-account', participantId: 'example-participant' }, effects.createConversation, 201],
  ['post', `/api/beeper/conversations/${ACCOUNT}/archive`, { archived: true }, effects.archive, 200],
  ['post', `/api/beeper/conversations/${ACCOUNT}/low-priority`, { lowPriority: true }, effects.lowPriority, 200],
  ['post', `/api/messages/sync/${ACCOUNT}`, {}, effects.sync, 200],
  ['post', `/api/messages/${ACCOUNT}/example-message/refresh`, {}, effects.refresh, 200],
  ['post', `/api/messages/fetch-full/${ACCOUNT}`, { force: false }, effects.refreshMany, 200],
  ['post', `/api/messages/drafts/${DRAFT}/approve`, {}, effects.approve, 200],
];
// Body gates: the same approval reached by a PUT status or a Review-queue row.
const approvals = [
  ['put', `/api/messages/drafts/${DRAFT}`, { status: 'approved' }, effects.updateDraft, 200],
  ['post', '/api/review/queue/resolve', { id: `drafts:${DRAFT}`, operation: 'approve' }, effects.resolveQueueItem, 200],
  ['post', '/api/review/queue/resolve', { id: `DRAFTS:${DRAFT}` }, effects.resolveQueueItem, 200],
];
const gated = [...operations, ...approvals];

const appFor = (address = '192.0.2.10') => {
  const app = express();
  app.use((req, _res, next) => {
    Object.defineProperty(req.socket, 'remoteAddress', { value: address });
    next();
  });
  app.use(authGate, hostControlRouteGate, express.json(), hostControlBodyGate);
  app.use('/api/beeper', beeperRoutes);
  app.use('/api/messages', messagesRoutes);
  app.use('/api/review', reviewRoutes);
  app.use(errorMiddleware);
  return app;
};
const send = (app, [method, path, body], headers = {}) => {
  const pending = request(app)[method](path);
  for (const [name, value] of Object.entries(headers)) pending.set(name, value);
  return pending.send(body);
};
const expectNoEffects = () => {
  for (const [name, effect] of Object.entries(effects)) expect(effect, name).not.toHaveBeenCalled();
};

beforeEach(() => {
  vi.clearAllMocks();
  auth.enabled = false;
});

describe('Beeper chat writes, Messages browser sync and draft approval operator authority (#13055)', () => {
  it('refuses remote password-free callers, spoofed-proxy and URL variants before any effect', async () => {
    for (const operation of gated) {
      const [method, path, body] = operation;
      const targets = operations.includes(operation) ? [path, path.toUpperCase() + '/'] : [path];
      for (const [address, headers] of [
        ['192.0.2.10', {}],
        ['127.0.0.1', { [DEV_PROXY_CLIENT_ADDRESS_HEADER]: '192.0.2.10' }],
        ['192.0.2.10', { [DEV_PROXY_CLIENT_ADDRESS_HEADER]: '127.0.0.1' }],
      ]) {
        for (const target of targets) {
          const response = await send(appFor(address), [method, target, body], headers);
          expect([response.status, response.body.code], `${method} ${target} ${JSON.stringify(body)}`)
            .toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
        }
      }
    }
    expectNoEffects();
  });

  it('requires authentication with a password and denies legacy Basic and scoped-peer credentials', async () => {
    auth.enabled = true;
    for (const operation of gated) {
      for (const [headers, status, code] of [
        [{}, 401, 'AUTH_REQUIRED'],
        [{ Authorization: 'Basic ' + Buffer.from(':example-password').toString('base64') }, 403, 'HOST_CONTROL_FORBIDDEN'],
        [{
          [PEER_AUTH_HEADER]: derivePeerAuthToken('a'.repeat(32), 'example-instance'),
          [PEER_INSTANCE_HEADER]: 'example-instance',
        }, 403, 'PEER_SCOPE_FORBIDDEN'],
      ]) {
        const response = await send(appFor(), operation, headers);
        expect([response.status, response.body.code], `${operation[1]} ${JSON.stringify(operation[2])}`).toEqual([status, code]);
      }
    }
    expectNoEffects();
  });

  it('keeps working for local callers, operator sessions and delegated agent sessions', async () => {
    const operator = await createSession();
    const agent = await createSession({ label: 'agent' });
    for (const [enabled, address, headers] of [
      [false, '127.0.0.1', {}],
      [true, '192.0.2.10', { Cookie: `portos_auth=${operator.token}` }],
      [true, '192.0.2.10', { Authorization: `Bearer ${agent.token}` }],
    ]) {
      auth.enabled = enabled;
      for (const operation of gated) {
        const [, path, body, effect, status] = operation;
        const before = effect.mock.calls.length;
        const response = await send(appFor(address), operation, headers);
        expect(response.status, `${path} ${JSON.stringify(body)}: ${JSON.stringify(response.body)}`).toBe(status);
        expect(effect, path).toHaveBeenCalledTimes(before + 1);
      }
    }
    expect(effects.createConversation).toHaveBeenLastCalledWith({ accountId: 'example-account', participantId: 'example-participant' });
    expect(effects.archive).toHaveBeenLastCalledWith(ACCOUNT, true);
    expect(effects.refreshMany).toHaveBeenLastCalledWith(ACCOUNT, ['example-message']);
    expect(effects.updateDraft).toHaveBeenLastCalledWith(DRAFT, { status: 'approved' });
    expect(effects.resolveQueueItem).toHaveBeenLastCalledWith(`DRAFTS:${DRAFT}`);
  });

  it('leaves draft content edits and non-draft Review rows open to a remote caller', async () => {
    for (const [operation, effect, args] of [
      [['put', `/api/messages/drafts/${DRAFT}`, { body: 'Example reply text' }], effects.updateDraft, [DRAFT, { body: 'Example reply text' }]],
      [['post', '/api/review/queue/resolve', { id: 'memory:example-memory', operation: 'approve' }], effects.resolveQueueItem, ['memory:example-memory', 'approve']],
      [['post', '/api/review/queue/resolve', { id: 'threads:example-thread', operation: 'complete' }], effects.resolveQueueItem, ['threads:example-thread', 'complete']],
    ]) {
      const response = await send(appFor(), operation);
      expect(response.status, `${operation[1]} ${JSON.stringify(response.body)}`).toBe(200);
      expect(effect).toHaveBeenLastCalledWith(...args);
    }
  });
});
