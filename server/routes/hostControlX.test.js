import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { callRoute, expectAuthorizedWorkflows, expectRemoteRefusal, hostControlApp } from './hostControlTestHarness.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-x-authority-') }));
afterAll(cleanupTempDataRoots);

const auth = vi.hoisted(() => ({ enabled: false }));
vi.mock('../services/auth.js', async (importOriginal) => ({
  ...await importOriginal(),
  isAuthEnabled: vi.fn(async () => auth.enabled),
}));

vi.mock('../services/settings.js', () => ({
  settingsEvents: new EventEmitter(),
  getSettings: vi.fn(async () => ({})),
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
      reviewed();
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
    // Sync ends each authorized pass; rearm the draft for the next principal.
    draft = seedDraft();
    if (target === 'profile') synced();
    if (target === 'profile') return { profile: { username: account.username }, posts: [] };
    if (target === 'latest') return { posts: [] };
    if (target === 'people') return { exactMatch: true, handles: [account.username] };
    return {};
  });
});

const reviewed = vi.hoisted(() => vi.fn());
const synced = vi.hoisted(() => vi.fn());
const mounts = [['/api/x', xRoutes]];

// Writes are plain writes under the default-deny gate (#16018); the principal
// matrix lives in services/authGate.test.js. This suite keeps one remote refusal
// for the browser handoff and an authorized review -> open -> sync workflow
// through the real route, with the browser and storage doubled.
describe('X (Twitter) review, browser handoff and sync authority', () => {
  it('refuses a remote caller before the browser handoff', async () => {
    draft = seedDraft('approved', new Date().toISOString());
    await expectRemoteRefusal(mounts, ['post', `/api/x/drafts/${draft.id}/open`, {}, openXHandoff]);
    expect(draft.state).toBe('approved');
  });

  it('preserves local and delegated-agent review, open and sync', async () => {
    await expectAuthorizedWorkflows({ auth, mounts, workflows: [
      ['post', `/api/x/drafts/${draftId}/review`, { state: 'approved' }, reviewed, 200],
      ['post', `/api/x/drafts/${draftId}/open`, {}, openXHandoff, 200],
      ['post', `/api/x/accounts/${account.id}/open`, { kind: 'profile' }, openXHandoff, 200],
      ['post', `/api/x/accounts/${account.id}/sync`, {}, synced, 200],
    ] });
  });

  it('keeps remote reads open', async () => {
    const app = await hostControlApp('192.0.2.10', mounts);
    for (const path of ['/api/x/capabilities', '/api/x/accounts', `/api/x/accounts/${account.id}/drafts`]) {
      expect((await callRoute(app, ['get', path])).status, path).toBe(200);
    }
  });
});
