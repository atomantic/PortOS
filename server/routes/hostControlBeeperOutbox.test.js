import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { DEV_PROXY_CLIENT_ADDRESS_HEADER } from '../../lib/portosAuthCore.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';
import { derivePeerAuthToken, PEER_AUTH_HEADER, PEER_INSTANCE_HEADER } from '../lib/peerHttpClient.js';

const auth = vi.hoisted(() => ({ enabled: false }));
vi.mock('../lib/fileUtils.js', async (original) =>
  makePathsProxy(await original(), { dataRoot: () => lazyTempDataRoot('portos-beeper-authority-') }));
afterAll(cleanupTempDataRoots);
vi.mock('../services/auth.js', async (original) => ({
  ...await original(), isAuthEnabled: vi.fn(async () => auth.enabled), verifyPassword: vi.fn(async () => true),
}));
vi.mock('../services/settings.js', () => ({
  settingsEvents: new EventEmitter(), getSettings: vi.fn(async () => ({})), updateSettingsWith: vi.fn(),
}));
vi.mock('../services/instanceIdentity.js', () => ({
  loadData: vi.fn(async () => ({ peers: [{
    id: 'example-peer', instanceId: 'example-instance', enabled: true, syncSecret: 'a'.repeat(32),
  }] })),
}));
vi.mock('../services/beeperStatus.js', () => ({ getBeeperStatus: vi.fn(), checkBeeperConnection: vi.fn() }));
vi.mock('../services/beeperOAuth.js', () => ({
  completeBeeperOAuth: vi.fn(), connectWithPastedToken: vi.fn(), disconnectBeeper: vi.fn(), startBeeperOAuth: vi.fn(),
}));
vi.mock('../services/beeperSync.js', () => ({
  runBeeperSweep: vi.fn(), createBeeperConversation: vi.fn(), normalizeMessageRow: vi.fn(), upsertMirroredMessage: vi.fn(),
}));
vi.mock('../services/beeperConversations.js', () => ({
  listConversations: vi.fn(), getConversation: vi.fn(), listMessages: vi.fn(), listNetworks: vi.fn(),
  markConversationSeen: vi.fn(), purgeConversation: vi.fn(), setConversationArchived: vi.fn(), setConversationLowPriority: vi.fn(),
}));
vi.mock('../services/beeperAttachments.js', () => ({
  backfillAttachments: vi.fn(), ensureAttachmentBytes: vi.fn(), getAttachment: vi.fn(), getAttachmentSummary: vi.fn(), setAttachmentKeep: vi.fn(),
}));
vi.mock('../services/beeperClient.js', async (original) => ({
  ...await original(), sendMessage: vi.fn(), getMessage: vi.fn(), listMessagesPage: vi.fn(),
}));

// Exercise the real route → outbox state machine; only storage and transport
// are synthetic. Refusals must leave durable intent and send accounting intact.
const rows = new Map();
const CONVERSATION_ID = '11111111-1111-4111-8111-111111111111';
const query = vi.fn(async (sql, params = []) => {
  if (/SELECT id, source_chat_id/.test(sql)) return { rows: [{ id: CONVERSATION_ID, sourceChatId: 'example-chat' }] };
  if (/INSERT INTO beeper_outbox/.test(sql)) {
    const row = { id: randomUUID(), conversationId: params[0], chatId: params[1], body: params[2], state: 'approved' };
    rows.set(row.id, row);
    return { rows: [{ ...row }], rowCount: 1 };
  }
  if (/SELECT 1 FROM/.test(sql)) return { rows: [], rowCount: 0 };
  if (/^SELECT/.test(sql)) {
    const result = /WHERE id =/.test(sql) ? [rows.get(params[0])].filter(Boolean) : [...rows.values()];
    return { rows: result.map((row) => ({ ...row })), rowCount: result.length };
  }
  const row = rows.get(params[0]);
  if (/SET state = 'sending'/.test(sql)) {
    if (row?.state !== 'approved') return { rows: [], rowCount: 0 };
    row.state = 'sending';
    return { rows: [{ id: row.id }], rowCount: 1 };
  }
  if (/SET state = 'awaiting-confirmation'/.test(sql)) {
    Object.assign(row, { state: 'awaiting-confirmation', pendingMessageId: params[1] });
    return { rows: [{ ...row }], rowCount: 1 };
  }
  if (/SET state = 'failed'/.test(sql)) {
    Object.assign(row, { state: 'failed', errorCode: params[1] });
    return { rows: [], rowCount: 1 };
  }
  if (/DELETE FROM beeper_outbox/.test(sql)) {
    rows.delete(params[0]);
    return { rows: [], rowCount: 1 };
  }
  throw new Error(`Unexpected synthetic outbox query: ${sql.slice(0, 50)}`);
});
vi.mock('../lib/db.js', () => ({ query: (...args) => query(...args), withTransaction: vi.fn() }));

import { authGate, hostControlRouteGate } from '../services/authGate.js';
import { createSession } from '../services/auth.js';
import { BeeperApiError, sendMessage } from '../services/beeperClient.js';
import {
  BREAKER_MAX_CONSECUTIVE_FAILURES, cancelPendingConfirmations, clearOutboxBreaker,
  configureOutboxRuntime, getOutboxBreakerState, resetOutboxRuntime,
} from '../services/beeperOutbox.js';
import beeperRoutes from './beeper.js';

const appFor = (address = '192.0.2.10') => {
  const app = express();
  app.use((req, _res, next) => {
    Object.defineProperty(req.socket, 'remoteAddress', { value: address });
    next();
  });
  app.use(authGate, hostControlRouteGate, express.json());
  app.use('/api/beeper', beeperRoutes);
  app.use(errorMiddleware);
  return app;
};
const post = (app, path, body = {}, headers = {}) => {
  const pending = request(app).post(`/api/beeper/${path}`);
  for (const [name, value] of Object.entries(headers)) pending.set(name, value);
  return pending.send(body);
};
const approve = (app, headers) => post(app, 'outbox', { conversationId: CONVERSATION_ID, body: 'Synthetic message' }, headers);
const peerHeaders = {
  [PEER_AUTH_HEADER]: derivePeerAuthToken('a'.repeat(32), 'example-instance'),
  [PEER_INSTANCE_HEADER]: 'example-instance',
};

beforeEach(() => {
  auth.enabled = false;
  rows.clear();
  vi.clearAllMocks();
  clearOutboxBreaker();
  configureOutboxRuntime({ setTimeout: () => 1, clearTimeout: () => {} });
  vi.mocked(sendMessage).mockResolvedValue({ pendingMessageId: 'example-pending' });
});
afterEach(() => { cancelPendingConfirmations(); resetOutboxRuntime(); });

describe('Beeper outbox operator authority (#11417)', () => {
  it('refuses remote approval before creating sendable intent', async () => {
    const app = appFor();
    const refused = await approve(app);
    expect([refused.status, refused.body.code]).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
    expect(query).not.toHaveBeenCalled();
    expect(rows.size).toBe(0);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('refuses sending an existing approved row, preserving data-only history and discard', async () => {
    const app = appFor();
    const approved = await approve(appFor('127.0.0.1'));
    query.mockClear();
    const sent = await post(app, `outbox/${approved.body.id}/send`, { confirmFirstContact: true });
    expect([sent.status, sent.body.code]).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
    expect(query).not.toHaveBeenCalled();
    expect(rows.get(approved.body.id).state).toBe('approved');
    expect(sendMessage).not.toHaveBeenCalled();
    expect(getOutboxBreakerState().sendsInWindow).toBe(0);

    // History and declining unsent local intent do not authorize a send.
    expect((await request(app).get(`/api/beeper/outbox?conversationId=${CONVERSATION_ID}`)).body.entries).toHaveLength(1);
    expect((await request(app).delete(`/api/beeper/outbox/${approved.body.id}`)).status).toBe(204);
    expect(rows.size).toBe(0);
  });

  it.each(['local', 'operator', 'agent'])('preserves %s approval, first-contact confirmation and one-attempt delivery', async (principal) => {
    const headers = {};
    const app = appFor(principal === 'operator' ? '192.0.2.10' : '127.0.0.1');
    if (principal !== 'local') {
      const session = await createSession(principal === 'agent' ? { label: 'agent' } : {});
      headers[principal === 'agent' ? 'Authorization' : 'Cookie'] = principal === 'agent'
        ? `Bearer ${session.token}` : `portos_auth=${session.token}`;
      auth.enabled = true;
    }
    const approved = await approve(app, headers);
    expect(approved.status).toBe(201);
    expect(rows.get(approved.body.id).state).toBe('approved');
    const path = `outbox/${approved.body.id}/send`;
    const missingConfirmation = await post(app, path, {}, headers);
    expect([missingConfirmation.status, missingConfirmation.body.code]).toEqual([409, 'FIRST_CONTACT_CONFIRMATION_REQUIRED']);
    expect(sendMessage).not.toHaveBeenCalled();
    const sent = await post(app, path, { confirmFirstContact: true }, headers);
    expect(sent.status).toBe(200);
    expect(rows.get(approved.body.id).state).toBe('awaiting-confirmation');
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith('example-chat', { text: 'Synthetic message' });
    const repeated = await post(app, path, { confirmFirstContact: true }, headers);
    expect([repeated.status, repeated.body.code]).toEqual([409, 'OUTBOX_INVALID_STATE']);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('refuses forwarded local hints, anonymous auth-on, Basic and scoped-peer callers', async () => {
    const path = 'outbox/22222222-2222-4222-8222-222222222222/send';
    const proxy = await post(appFor('127.0.0.1'), path, { confirmFirstContact: true }, { [DEV_PROXY_CLIENT_ADDRESS_HEADER]: '192.0.2.10' });
    expect([proxy.status, proxy.body.code]).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
    auth.enabled = true;
    for (const [headers, expected] of [
      [{}, [401, 'AUTH_REQUIRED']],
      [{ Authorization: `Basic ${Buffer.from('portos:synthetic-password').toString('base64')}` }, [403, 'HOST_CONTROL_FORBIDDEN']],
      [peerHeaders, [403, 'PEER_SCOPE_FORBIDDEN']],
    ]) {
      const response = await post(appFor(), path, { confirmFirstContact: true }, headers);
      expect([response.status, response.body.code]).toEqual(expected);
    }
    expect(query).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('requires authority to clear a tripped breaker without weakening recovery or retry rules', async () => {
    const local = appFor('127.0.0.1');
    vi.mocked(sendMessage).mockRejectedValue(new BeeperApiError('Synthetic rejection', { status: 400, code: 'SEND_FAILED' }));
    for (let index = 0; index < BREAKER_MAX_CONSECUTIVE_FAILURES; index++) {
      const entry = await approve(local);
      expect((await post(local, `outbox/${entry.body.id}/send`, { confirmFirstContact: true })).status).toBe(502);
      expect(rows.get(entry.body.id).state).toBe('failed');
    }
    const tripped = getOutboxBreakerState();
    expect(tripped.tripped).toBe(true);
    const reset = await post(appFor(), 'outbox/breaker/clear');
    expect([reset.status, reset.body.code]).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
    expect(getOutboxBreakerState()).toEqual(tripped);
    expect((await post(local, 'outbox/breaker/clear')).body.tripped).toBe(false);
    expect(sendMessage).toHaveBeenCalledTimes(BREAKER_MAX_CONSECUTIVE_FAILURES);
  });
});
