/**
 * Postgres-backed tests for the GitHub notifications inbox (#12870): the
 * upsert/reopen/read-reconcile SQL and the action mirror only run here against
 * real constraints. `gh` is the only mocked boundary; the account store is the
 * real one on a temp data root. Runs via `npm run test:db` (portos_test only).
 */
import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { makePathsProxy } from '../lib/mockPathsDataRoot.js';
import { checkHealth, ensureSchema, close, query } from '../lib/db.js';
import { requireDbOrSkip } from '../lib/dbTestGate.js';

const TEST_DATA_ROOT = mkdtempSync(join(tmpdir(), 'github-notifications-test-'));

vi.mock('../lib/fileUtils.js', async (importOriginal) => makePathsProxy(await importOriginal(), { dataRoot: TEST_DATA_ROOT }));
vi.mock('./github.js', async (importOriginal) => ({ ...(await importOriginal()), execGh: vi.fn() }));

const { execGh } = await import('./github.js');
const { createAccount } = await import('./githubAccounts.js');
const { syncAccountNotifications, listNotifications, applyNotificationAction } = await import('./githubNotifications.js');

let dbReady = false;
let skipReason = '';
{
  const health = await checkHealth().catch((e) => ({ connected: false, error: e?.message }));
  if (!health.connected) {
    skipReason = `Postgres not reachable (${health.error || 'no connection'})`;
  } else {
    await ensureSchema().catch(() => {});
    dbReady = true;
  }
}
const runDb = requireDbOrSkip('services/githubNotifications.db.test', dbReady, skipReason);

const accountIds = [];

const thread = (id, { updatedAt = '2026-10-01T10:00:00Z', owner = 'octocat', repo = 'hello', title = `Thread ${id}` } = {}) => ({
  id,
  unread: true,
  reason: 'mention',
  updated_at: updatedAt,
  subject: { title, type: 'PullRequest', url: `https://api.github.com/repos/${owner}/${repo}/pulls/${id}` },
  repository: { full_name: `${owner}/${repo}`, private: false, owner: { login: owner } },
});

const listing = (threads, headers = {}) => [
  'HTTP/2.0 200 OK',
  'Last-Modified: Thu, 01 Oct 2026 10:00:00 GMT',
  'X-Poll-Interval: 60',
  ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`),
  '',
  JSON.stringify(threads),
].join('\r\n');

// Routes gh calls: token lookup, the listing (via `respond`), and thread actions.
function mockGh(respond) {
  const actions = [];
  vi.mocked(execGh).mockImplementation(async (args) => {
    if (args[0] === 'auth') return 'gho_example';
    const path = args.find((arg) => /^notifications/.test(arg));
    if (path.startsWith('notifications?')) return respond(args);
    actions.push([args[args.indexOf('--method') + 1], path]);
    return '';
  });
  return actions;
}

afterAll(async () => {
  if (dbReady) {
    await query('DELETE FROM github_notifications WHERE account_id = ANY($1::text[])', [accountIds]).catch(() => {});
    await query('DELETE FROM github_notification_sync WHERE account_id = ANY($1::text[])', [accountIds]).catch(() => {});
    await close();
  }
  rmSync(TEST_DATA_ROOT, { recursive: true, force: true });
});

describe.skipIf(!runDb)('GitHub notifications inbox against Postgres', () => {
  let account;
  beforeEach(async () => {
    vi.mocked(execGh).mockReset();
    account = await createAccount({ host: 'github.com', login: `octocat${accountIds.length}`, label: 'Example' });
    accountIds.push(account.id);
  });

  it('stores threads with a host-bound link, sends If-Modified-Since next time, and reconciles reads', async () => {
    const login = account.login;
    const seen = [];
    mockGh((args) => {
      seen.push(args);
      return seen.length === 1
        ? listing([thread('101', { owner: login }), thread('102', { owner: 'someone-else' })])
        : listing([thread('102', { owner: 'someone-else' })]);
    });

    expect(await syncAccountNotifications(account.id)).toMatchObject({ changed: true, fetched: 2 });
    const first = await listNotifications({ accountId: account.id });
    expect(first.notifications).toEqual(expect.arrayContaining([
      expect.objectContaining({ threadId: '101', yourRepo: true, htmlUrl: `https://github.com/${login}/hello/pull/101`, unread: true }),
      expect.objectContaining({ threadId: '102', yourRepo: false }),
    ]));
    expect(first.sync[account.id]).toMatchObject({ lastError: null, pollIntervalSeconds: 60 });

    await syncAccountNotifications(account.id);
    expect(seen[1]).toContain('If-Modified-Since: Thu, 01 Oct 2026 10:00:00 GMT');
    const rows = (await listNotifications({ accountId: account.id })).notifications;
    expect(rows.find((row) => row.threadId === '101').unread).toBe(false);
    expect(rows.find((row) => row.threadId === '102').unread).toBe(true);
  });

  it('treats a 304 as unchanged and keeps rows', async () => {
    let calls = 0;
    mockGh(() => {
      calls += 1;
      if (calls === 1) return listing([thread('201')]);
      throw Object.assign(new Error('gh: HTTP 304'), { ghExitCode: 1, ghStderr: 'gh: HTTP 304' });
    });
    await syncAccountNotifications(account.id);
    expect(await syncAccountNotifications(account.id)).toMatchObject({ changed: false });
    expect((await listNotifications({ accountId: account.id })).notifications).toHaveLength(1);
  });

  it('applies actions on GitHub, moves rows between views, and reopens a done thread on new activity', async () => {
    let updatedAt = '2026-10-01T10:00:00Z';
    const actions = mockGh(() => listing([thread('301', { updatedAt }), thread('302')]));
    await syncAccountNotifications(account.id);

    expect(await applyNotificationAction(account.id, '301', 'done')).toMatchObject({ state: 'done', unread: false });
    expect(await applyNotificationAction(account.id, '302', 'mute')).toMatchObject({ state: 'muted' });
    expect(actions).toEqual([
      ['DELETE', 'notifications/threads/301'],
      ['PUT', 'notifications/threads/302/subscription'],
    ]);
    expect((await listNotifications({ accountId: account.id, view: 'needs-you' })).notifications).toEqual([]);
    expect((await listNotifications({ accountId: account.id, view: 'handled' })).notifications).toHaveLength(2);

    updatedAt = '2026-10-02T10:00:00Z';
    // A changed Last-Modified would normally gate this; the mock ignores it.
    await syncAccountNotifications(account.id);
    const open = (await listNotifications({ accountId: account.id, view: 'needs-you' })).notifications;
    expect(open.map((row) => row.threadId)).toEqual(['301']);
  });

  it('brings an unsubscribed thread back on a new mention but leaves a muted one handled', async () => {
    let updatedAt = '2026-10-01T10:00:00Z';
    mockGh(() => listing([thread('401', { updatedAt }), thread('402', { updatedAt })]));
    await syncAccountNotifications(account.id);
    await applyNotificationAction(account.id, '401', 'unsubscribe');
    await applyNotificationAction(account.id, '402', 'mute');

    updatedAt = '2026-10-02T10:00:00Z';
    await syncAccountNotifications(account.id);
    const open = (await listNotifications({ accountId: account.id, view: 'needs-you' })).notifications;
    expect(open.map((row) => row.threadId)).toEqual(['401']);
  });

  it('reopens a done thread locally without subscribing to it on GitHub', async () => {
    const actions = mockGh(() => listing([thread('501')]));
    await syncAccountNotifications(account.id);
    await applyNotificationAction(account.id, '501', 'done');
    expect(await applyNotificationAction(account.id, '501', 'reopen')).toMatchObject({ state: 'open' });
    expect(actions).toEqual([['DELETE', 'notifications/threads/501']]);
  });

  it('records the failure on the sync cursor and refuses actions on unknown threads', async () => {
    mockGh(() => { throw Object.assign(new Error('HTTP 502'), { ghExitCode: 1, ghStderr: 'HTTP 502' }); });
    await expect(syncAccountNotifications(account.id)).rejects.toThrow('HTTP 502');
    expect((await listNotifications({ accountId: account.id })).sync[account.id].lastError).toContain('HTTP 502');
    await expect(applyNotificationAction(account.id, '999', 'done')).rejects.toMatchObject({ status: 404 });
  });
});
