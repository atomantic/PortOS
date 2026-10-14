import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';
import { DEV_PROXY_CLIENT_ADDRESS_HEADER } from '../../lib/portosAuthCore.js';
import { derivePeerAuthToken, PEER_AUTH_HEADER, PEER_INSTANCE_HEADER } from '../lib/peerHttpClient.js';

vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-x-authority-') }));
afterAll(cleanupTempDataRoots);

const auth = vi.hoisted(() => ({ enabled: false }));
vi.mock('../services/auth.js', async (importOriginal) => ({
  ...await importOriginal(),
  isAuthEnabled: vi.fn(async () => auth.enabled),
  verifyPassword: vi.fn(async () => true),
}));

vi.mock('../services/settings.js', () => ({
  settingsEvents: new EventEmitter(),
  getSettings: vi.fn(async () => ({})),
}));

vi.mock('../services/instanceIdentity.js', () => ({
  loadData: vi.fn(async () => ({ peers: [{
    id: 'example-peer', instanceId: 'example-instance', enabled: true, syncSecret: 'a'.repeat(32),
  }] })),
}));

const openXHandoff = vi.hoisted(() => vi.fn());
vi.mock('../services/xBrowser.js', () => ({
  openXHandoff,
  fixedXUrl: vi.fn(() => 'https://x.com/example_user'),
  verifyFinalXOrigin: vi.fn(),
  verifyFinalXPath: vi.fn(),
}));

const executeXBrowserRead = vi.hoisted(() => vi.fn());
vi.mock('../integrations/x/index.js', () => ({
  executeXBrowserRead,
}));

const storage = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../lib/db.js', () => ({
  query: storage.query,
  withTransaction: async (callback) => callback({ query: storage.query }),
}));

import { authGate, hostControlRouteGate } from '../services/authGate.js';
import { createSession } from '../services/auth.js';
import xRoutes from './x.js';

const account = {
  id: '00000000-0000-4000-8000-000000000001',
  label: 'Main X Account',
  username: 'example_user',
  enabled: true,
  notes: '',
  profile_snapshot: {},
  last_sync_at: null,
  last_error: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

const draftId = '00000000-0000-4000-8000-000000000002';
let draft;

const seedDraft = (state = 'pending_review', approvedAt = null) => ({
  id: draftId,
  account_id: account.id,
  account_label: account.label,
  username: account.username,
  body: 'Hello world from X draft',
  state,
  review_note: '',
  result: {},
  approved_at: approvedAt,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
});

beforeEach(() => {
  vi.clearAllMocks();
  auth.enabled = false;
  draft = seedDraft();

  storage.query.mockImplementation(async (sql, params = []) => {
    if (/SELECT \* FROM x_accounts WHERE id=\$1/.test(sql)) {
      return { rows: [account], rowCount: 1 };
    }
    if (/SELECT \* FROM x_accounts/.test(sql)) {
      return { rows: [account], rowCount: 1 };
    }
    if (/SELECT d\.\*.*a\.enabled\s+FROM x_drafts/s.test(sql)) {
      return { rows: [{ ...draft, enabled: account.enabled }], rowCount: 1 };
    }
    if (/SELECT d\.\*.*FROM x_drafts.*WHERE d\.id=\$1/s.test(sql)) {
      return { rows: [draft], rowCount: 1 };
    }
    if (/SELECT d\.\*.*FROM x_drafts.*WHERE d\.account_id=\$1/s.test(sql)) {
      return { rows: [draft], rowCount: 1 };
    }
    if (sql.includes('SELECT * FROM x_posts')) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes('INSERT INTO x_drafts')) {
      draft = {
        id: params[0],
        account_id: params[1],
        account_label: account.label,
        username: account.username,
        body: params[2],
        state: 'pending_review',
        review_note: '',
        result: {},
        approved_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      return { rows: [draft], rowCount: 1 };
    }
    if (sql.includes('UPDATE x_drafts SET state=$2,review_note')) {
      if (draft.state !== params[3]) return { rows: [], rowCount: 0 };
      draft = {
        ...draft,
        state: params[1],
        review_note: params[2],
        approved_at: params[1] === 'approved' ? new Date().toISOString() : draft.approved_at,
        updated_at: new Date().toISOString(),
      };
      return { rows: [draft], rowCount: 1 };
    }
    if (sql.includes("UPDATE x_drafts SET state='opened'")) {
      if (draft.state !== 'approved') return { rows: [], rowCount: 0 };
      draft = {
        ...draft,
        state: 'opened',
        result: params[1],
        updated_at: new Date().toISOString(),
      };
      return { rows: [draft], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO x_posts')) {
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('UPDATE x_accounts SET profile_snapshot=$2')) {
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });

  openXHandoff.mockResolvedValue({
    pageId: 'page-1',
    url: 'https://x.com/compose/post?text=Hello',
  });

  executeXBrowserRead.mockImplementation(async (target) => {
    if (target === 'profile') return { profile: { username: account.username }, posts: [] };
    if (target === 'latest') return { posts: [] };
    if (target === 'people') return { exactMatch: true, handles: [account.username] };
    return {};
  });
});

const appFor = (address = '192.0.2.10') => {
  const app = express();
  app.use((req, _res, next) => {
    Object.defineProperty(req.socket, 'remoteAddress', { value: address });
    next();
  });
  app.use(authGate, hostControlRouteGate, express.json());
  app.use('/api/x', xRoutes);
  app.use(errorMiddleware);
  return app;
};

const post = (app, path, body = {}, headers = {}) => {
  const pending = request(app).post(path);
  for (const [name, value] of Object.entries(headers)) pending.set(name, value);
  return pending.send(body);
};

describe('X (Twitter) review, browser handoff and sync authority', () => {
  it.each([
    ['remote without auth', false, '192.0.2.10', {}, 403, 'HOST_CONTROL_FORBIDDEN'],
    ['forwarded remote without auth', false, '127.0.0.1', { [DEV_PROXY_CLIENT_ADDRESS_HEADER]: '192.0.2.10' }, 403, 'HOST_CONTROL_FORBIDDEN'],
    ['anonymous with auth', true, '192.0.2.10', {}, 401, 'AUTH_REQUIRED'],
    ['Basic password', true, '192.0.2.10', { Authorization: `Basic ${Buffer.from(':example-password').toString('base64')}` }, 403, 'HOST_CONTROL_FORBIDDEN'],
    ['scoped peer', true, '192.0.2.10', {
      [PEER_AUTH_HEADER]: derivePeerAuthToken('a'.repeat(32), 'example-instance'), [PEER_INSTANCE_HEADER]: 'example-instance',
    }, 403, 'PEER_SCOPE_FORBIDDEN'],
  ])('refuses %s for draft review, compose open, destination open and sync', async (_name, enabled, address, headers, status, code) => {
    auth.enabled = enabled;
    const app = appFor(address);

    const review = await post(app, `/api/x/drafts/${draft.id}/review`, { state: 'approved' }, headers);
    expect(review.status, JSON.stringify(review.body)).toBe(status);
    expect(review.body.code).toBe(code);
    expect(draft.state).toBe('pending_review');

    draft = seedDraft('approved', new Date().toISOString());
    const openDraft = await post(app, `/api/x/drafts/${draft.id}/open`, {}, headers);
    expect(openDraft.status, JSON.stringify(openDraft.body)).toBe(status);
    expect(openDraft.body.code).toBe(code);

    const openAccount = await post(app, `/api/x/accounts/${account.id}/open`, { kind: 'profile' }, headers);
    expect(openAccount.status, JSON.stringify(openAccount.body)).toBe(status);
    expect(openAccount.body.code).toBe(code);

    const sync = await post(app, `/api/x/accounts/${account.id}/sync`, {}, headers);
    expect(sync.status, JSON.stringify(sync.body)).toBe(status);
    expect(sync.body.code).toBe(code);

    expect(openXHandoff).not.toHaveBeenCalled();
    expect(executeXBrowserRead).not.toHaveBeenCalled();
  });

  it('protects Express case and trailing-slash aliases and rejected reviews too', async () => {
    const app = appFor();
    const review = await post(app, `/API/X/DRAFTS/${draft.id}/REVIEW/`, { state: 'rejected' });
    const openDraft = await post(app, `/API/X/DRAFTS/${draft.id}/OPEN/`);
    const openAccount = await post(app, `/API/X/ACCOUNTS/${account.id}/OPEN/`, { kind: 'profile' });
    const sync = await post(app, `/API/X/ACCOUNTS/${account.id}/SYNC/`);

    expect(review.status).toBe(403);
    expect(openDraft.status).toBe(403);
    expect(openAccount.status).toBe(403);
    expect(sync.status).toBe(403);
    expect(openXHandoff).not.toHaveBeenCalled();
    expect(executeXBrowserRead).not.toHaveBeenCalled();
  });

  it.each([
    ['local'], ['operator session'], ['delegated agent'],
  ])('preserves %s review, compose open, destination open and sync through real consumer', async (principal) => {
    const headers = {};
    if (principal !== 'local') {
      const session = await createSession({ label: principal === 'delegated agent' ? 'agent' : 'operator' });
      auth.enabled = true;
      if (principal === 'delegated agent') headers.Authorization = `Bearer ${session.token}`;
      else headers.Cookie = `portos_auth=${session.token}`;
    }
    const app = appFor(principal === 'operator session' ? '192.0.2.10' : '127.0.0.1');

    // 1. Approve review
    const review = await post(app, `/api/x/drafts/${draft.id}/review`, { state: 'approved' }, headers);
    expect(review.status, JSON.stringify(review.body)).toBe(200);
    expect(review.body.state).toBe('approved');
    expect(draft.state).toBe('approved');

    // 2. Open approved draft
    const openDraft = await post(app, `/api/x/drafts/${draft.id}/open`, {}, headers);
    expect(openDraft.status, JSON.stringify(openDraft.body)).toBe(200);
    expect(openDraft.body.state).toBe('opened');
    expect(openXHandoff).toHaveBeenCalledWith({ kind: 'compose', value: draft.body });

    // 3. Open account destination
    const openAccount = await post(app, `/api/x/accounts/${account.id}/open`, { kind: 'profile' }, headers);
    expect(openAccount.status, JSON.stringify(openAccount.body)).toBe(200);
    expect(openXHandoff).toHaveBeenCalledWith({ kind: 'profile', value: account.username });

    // 4. Sync account
    const sync = await post(app, `/api/x/accounts/${account.id}/sync`, {}, headers);
    expect(sync.status, JSON.stringify(sync.body)).toBe(200);
    expect(executeXBrowserRead).toHaveBeenCalledTimes(3);
  });

  it('keeps remote reads and draft creation available without granting execution or approval', async () => {
    const app = appFor();

    const capabilities = await request(app).get('/api/x/capabilities');
    expect(capabilities.status).toBe(200);

    const accounts = await request(app).get('/api/x/accounts');
    expect(accounts.status).toBe(200);

    const drafts = await request(app).get(`/api/x/accounts/${account.id}/drafts`);
    expect(drafts.status).toBe(200);

    const createdDraft = await post(app, '/api/x/drafts', { accountId: account.id, body: 'New proposed post' });
    expect(createdDraft.status, JSON.stringify(createdDraft.body)).toBe(201);
    expect(createdDraft.body.state).toBe('pending_review');

    expect(openXHandoff).not.toHaveBeenCalled();
    expect(executeXBrowserRead).not.toHaveBeenCalled();
  });
});
