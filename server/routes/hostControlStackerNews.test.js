import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';
import { DEV_PROXY_CLIENT_ADDRESS_HEADER } from '../../lib/portosAuthCore.js';
import { derivePeerAuthToken, PEER_AUTH_HEADER, PEER_INSTANCE_HEADER } from '../lib/peerHttpClient.js';
import { hashStackerNewsRules, POLICY_VERSION } from '../services/stackerNewsPolicy.js';

vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-stacker-authority-') }));
afterAll(cleanupTempDataRoots);
const auth = vi.hoisted(() => ({ enabled: false }));
vi.mock('../services/auth.js', async (importOriginal) => ({
  ...await importOriginal(),
  isAuthEnabled: vi.fn(async () => auth.enabled),
  verifyPassword: vi.fn(async () => true),
}));
vi.mock('../services/settings.js', () => ({
  settingsEvents: new EventEmitter(), getSettings: vi.fn(async () => ({})),
}));
vi.mock('../services/instanceIdentity.js', () => ({
  loadData: vi.fn(async () => ({ peers: [{
    id: 'example-peer', instanceId: 'example-instance', enabled: true, syncSecret: 'a'.repeat(32),
  }] })),
}));
vi.mock('../services/stackerNewsScheduler.js', () => ({ reconcileStackerNewsSchedulers: vi.fn() }));
vi.mock('../services/stackerNewsBrowser.js', () => ({
  getStackerNewsBrowserIdentity: vi.fn(), openStackerNewsHandoff: vi.fn(),
}));
const storage = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../lib/db.js', () => ({
  query: storage.query,
  withTransaction: async (callback) => callback({ query: storage.query }),
}));
const decryptValue = vi.hoisted(() => vi.fn(() => 'synthetic-stacker-key'));
vi.mock('../lib/vaultCrypto.js', () => ({ decryptValue, encryptValue: vi.fn(), ensureVaultKey: vi.fn() }));
const executeStackerNewsOperation = vi.hoisted(() => vi.fn());
vi.mock('../integrations/stackerNews/index.js', () => ({
  executeStackerNewsOperation, executeStackerNewsBrowserRead: vi.fn(), stackerNewsCapabilities: {},
}));

// Mount the actual authorization middleware, router, and action service. Only
// persistence/credentials and the external publication adapter are synthetic.
import { authGate, hostControlRouteGate } from '../services/authGate.js';
import { createSession } from '../services/auth.js';
import stackerNewsRoutes from './stackerNews.js';

const account = { id: '00000000-0000-4000-8000-000000000001', username: 'example_user', enabled: true, rules: {} };
const territory = { id: '00000000-0000-4000-8000-000000000002', account_id: account.id, slug: 'art', rules: {}, inherit_account_rules: true };
const item = {
  id: '00000000-0000-4000-8000-000000000003', account_id: account.id, territory_id: territory.id,
  remote_id: '42', title: 'Example post', body: 'Example content', image_urls: [],
  content_hash: createHash('sha256').update('Example post\nExample content').digest('hex'),
};
const actionId = '00000000-0000-4000-8000-000000000004';
let action;
let events;
let budget;

const seedAction = (state = 'pending_review') => ({
  id: actionId, account_id: account.id, territory_id: territory.id, item_id: item.id,
  kind: 'publish_comment', state, payload: { body: 'Example reply' },
  approved_at: state === 'approved' ? new Date() : null,
  reviewed_target: { username: account.username, territorySlug: territory.slug, remoteItemId: item.remote_id },
  source_content_hash: item.content_hash, rules_hash: hashStackerNewsRules({}), policy_version: POLICY_VERSION,
});

beforeEach(() => {
  vi.clearAllMocks();
  auth.enabled = false;
  action = seedAction();
  events = [];
  budget = { hour_count: 0, day_count: 0, last_executed: null };
  storage.query.mockImplementation(async (sql, params = []) => {
    if (sql.startsWith('SELECT * FROM stacker_news_accounts')) return { rows: [account] };
    if (sql.startsWith('SELECT * FROM stacker_news_territories')) return { rows: [territory] };
    if (sql.startsWith('SELECT * FROM stacker_news_items')) return { rows: [item] };
    if (sql.startsWith('SELECT api_key_enc')) return { rows: [{ api_key_enc: 'synthetic-ciphertext' }] };
    if (sql.includes('COUNT(*) FILTER')) return { rows: [budget] };
    if (sql.includes('WHERE idempotency_key=$1')) return { rows: [] };
    if (sql.startsWith('SELECT')) return { rows: [action] };
    if (sql.includes('INSERT INTO stacker_news_action_events')) {
      events.push(params.slice(1));
      return { rows: [] };
    }
    if (sql.includes('INSERT INTO stacker_news_actions')) {
      action = {
        id: params[0], account_id: params[1], item_id: params[2], territory_id: params[3], kind: params[4],
        state: 'pending_review', destination: params[5], payload: params[6], source_content_hash: params[7],
        rules_hash: params[8], policy_version: params[9], idempotency_key: params[10], reviewed_target: params[11],
      };
    } else if (sql.includes('SET state=$2,review_note')) {
      if (action.state !== 'pending_review') return { rows: [] };
      action = { ...action, state: params[1], review_note: params[2], approved_at: new Date() };
    } else if (sql.includes("SET state='executing'")) {
      if (action.state !== 'approved') return { rows: [] };
      action = { ...action, state: 'executing' };
    } else if (sql.includes('SET state=$2,result')) {
      action = { ...action, state: params[1], result: params[2], error: params[3] };
    } else throw new Error('Unexpected synthetic Stacker News query');
    return { rows: [action] };
  });
  executeStackerNewsOperation.mockImplementation(async (operation) => {
    if (operation === 'me') return { me: { name: account.username } };
    const result = { item: { id: '99' }, payInState: 'PAID' };
    if (operation === 'createDiscussion') return { upsertDiscussion: result };
    if (operation === 'createComment') return { upsertComment: result };
    throw new Error('Unexpected external operation');
  });
});

const appFor = (address = '192.0.2.10') => {
  const app = express();
  app.use((req, _res, next) => {
    Object.defineProperty(req.socket, 'remoteAddress', { value: address });
    next();
  });
  app.use(authGate, hostControlRouteGate, express.json());
  app.use('/api/stacker-news', stackerNewsRoutes);
  app.use(errorMiddleware);
  return app;
};
const post = (app, path, body = {}, headers = {}) => {
  const pending = request(app).post(path);
  for (const [name, value] of Object.entries(headers)) pending.set(name, value);
  return pending.send(body);
};
const actionPath = (suffix, id = action.id) => `/api/stacker-news/actions/${id}/${suffix}`;

describe('Stacker News review and publication authority', () => {
  it.each([
    ['remote without auth', false, '192.0.2.10', {}, 403, 'HOST_CONTROL_FORBIDDEN'],
    ['forwarded remote without auth', false, '127.0.0.1', { [DEV_PROXY_CLIENT_ADDRESS_HEADER]: '192.0.2.10' }, 403, 'HOST_CONTROL_FORBIDDEN'],
    ['anonymous with auth', true, '192.0.2.10', {}, 401, 'AUTH_REQUIRED'],
    ['Basic password', true, '192.0.2.10', { Authorization: `Basic ${Buffer.from(':example-password').toString('base64')}` }, 403, 'HOST_CONTROL_FORBIDDEN'],
    ['scoped peer', true, '192.0.2.10', {
      [PEER_AUTH_HEADER]: derivePeerAuthToken('a'.repeat(32), 'example-instance'), [PEER_INSTANCE_HEADER]: 'example-instance',
    }, 403, 'PEER_SCOPE_FORBIDDEN'],
  ])('refuses %s before approval persistence or saved-key execution', async (_name, enabled, address, headers, status, code) => {
    auth.enabled = enabled;
    const app = appFor(address);
    const review = await post(app, actionPath('review'), { state: 'approved' }, headers);
    expect(review.status, JSON.stringify(review.body)).toBe(status);
    expect(review.body.code).toBe(code);
    expect(action.state).toBe('pending_review');

    action = seedAction('approved');
    const execute = await post(app, actionPath('execute'), {}, headers);
    expect(execute.status, JSON.stringify(execute.body)).toBe(status);
    expect(execute.body.code).toBe(code);
    expect(action.state).toBe('approved');
    expect(storage.query).not.toHaveBeenCalled();
    expect(decryptValue).not.toHaveBeenCalled();
    expect(executeStackerNewsOperation).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it('protects Express case and trailing-slash aliases and rejected reviews too', async () => {
    const app = appFor();
    const review = await post(app, `${actionPath('review').toUpperCase()}/`, { state: 'rejected' });
    const execute = await post(app, `${actionPath('execute').toUpperCase()}/`);
    expect(review.status).toBe(403);
    expect(execute.status).toBe(403);
    expect(storage.query).not.toHaveBeenCalled();
  });

  it.each([
    ['local', 'publish_comment'], ['operator session', 'publish_post'], ['delegated agent', 'publish_comment'],
  ])('preserves %s review and execution through the real consumer', async (principal, kind) => {
    const headers = {};
    if (principal !== 'local') {
      const session = await createSession({ label: principal === 'delegated agent' ? 'agent' : 'operator' });
      auth.enabled = true;
      if (principal === 'delegated agent') headers.Authorization = `Bearer ${session.token}`;
      else headers.Cookie = `portos_auth=${session.token}`;
    }
    const app = appFor(principal === 'operator session' ? '192.0.2.10' : '127.0.0.1');
    const payload = kind === 'publish_post' ? { title: 'Example title', body: 'Example post' } : { body: 'Example reply' };
    const created = await post(app, '/api/stacker-news/actions', {
      accountId: account.id, territoryId: territory.id, kind, payload,
      ...(kind === 'publish_comment' ? { itemId: item.id } : {}),
    }, headers);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const review = await post(app, actionPath('review'), { state: 'approved' }, headers);
    expect(review.status, JSON.stringify(review.body)).toBe(200);
    const executed = await post(app, actionPath('execute'), {}, headers);
    expect(executed.status, JSON.stringify(executed.body)).toBe(200);
    expect(executed.body).toMatchObject({ state: 'completed', result: { remoteItemId: '99', payInState: 'PAID' } });
    expect(executeStackerNewsOperation.mock.calls).toEqual([
      ['me', {}, 'synthetic-stacker-key'],
      [kind === 'publish_post' ? 'createDiscussion' : 'createComment',
        kind === 'publish_post' ? { sub: 'art', title: payload.title, body: payload.body } : { parentId: '42', body: payload.body },
        'synthetic-stacker-key'],
    ]);
    expect(events.map((event) => event[2])).toEqual(['pending_review', 'approved', 'executing', 'completed']);
  });

  it('keeps remote action reads and preparation available without granting approval', async () => {
    const app = appFor();
    const read = await request(app).get(`/api/stacker-news/accounts/${account.id}/actions`);
    expect(read.status).toBe(200);
    const draft = await post(app, '/api/stacker-news/actions', {
      accountId: account.id, itemId: item.id, kind: 'draft_comment', payload: { body: 'Example local draft' },
    });
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    expect(draft.body.state).toBe('pending_review');
    expect(executeStackerNewsOperation).not.toHaveBeenCalled();
  });

  it('retains approval freshness and action budgets for authorized callers', async () => {
    const app = appFor('127.0.0.1');
    action = seedAction('approved');
    action.approved_at = new Date(Date.now() - 25 * 60 * 60 * 1_000);
    const stale = await post(app, actionPath('execute'));
    expect(stale.status).toBe(500);
    expect(stale.body.error).toContain('Approval is stale');
    action = seedAction('approved');
    budget.hour_count = 3;
    const exhausted = await post(app, actionPath('execute'));
    expect(exhausted.status).toBe(500);
    expect(exhausted.body.error).toContain('Hourly Stacker News action budget reached');
    expect(action.state).toBe('approved');
    expect(events).toEqual([]);
    expect(executeStackerNewsOperation).not.toHaveBeenCalled();
  });
});
