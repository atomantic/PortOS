import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/db.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
vi.mock('../integrations/x/index.js', () => ({ executeXBrowserRead: vi.fn() }));
vi.mock('./xBrowser.js', () => ({ openXHandoff: vi.fn() }));

const { query, withTransaction } = await import('../lib/db.js');
const { executeXBrowserRead } = await import('../integrations/x/index.js');
const { openXHandoff } = await import('./xBrowser.js');
const { buildXReadError, deriveXDiagnostics, syncAccount, reviewDraft, openApprovedDraft } = await import('./x.js');

describe('X diagnostics', () => {
  it('distinguishes observable public/search reach from unknown recommendation eligibility', () => {
    const result = deriveXDiagnostics({
      accountUsername: '@Example_User',
      profile: { username: 'example_user' },
      latest: { posts: [
        { authorHandle: 'example_user', remoteId: '1' },
        { authorHandle: 'other_user', remoteId: '2' },
      ] },
      people: { handles: ['other_user', 'Example_User'] },
    });

    expect(result).toMatchObject({
      profileRead: true,
      profilePublic: true,
      profileHandleMatches: true,
      appearsInPeopleSearch: true,
      recentPostsInLatestSearch: true,
      latestSearchPostCount: 1,
      recommendationEligibility: 'unknown',
    });
  });

  it('reports unknown rather than false when the profile page read came back empty', () => {
    const result = deriveXDiagnostics({
      accountUsername: '@Example_User',
      profile: { username: '' },
      latest: { posts: [] },
      people: {},
    });

    expect(result).toMatchObject({
      profileRead: false,
      profilePublic: null,
      profileHandleMatches: null,
      appearsInPeopleSearch: null,
      recentPostsInLatestSearch: null,
      latestSearchPostCount: null,
      recommendationEligibility: 'unknown',
    });
  });

  it('scores each read on its own evidence rather than collapsing them into the profile read', () => {
    const searchesUnread = deriveXDiagnostics({
      accountUsername: '@Example_User',
      profile: { username: 'example_user' },
      latest: {},
      people: { handles: [] },
    });

    expect(searchesUnread).toMatchObject({
      profileRead: true,
      profilePublic: true,
      appearsInPeopleSearch: null,
      recentPostsInLatestSearch: null,
      latestSearchPostCount: null,
    });

    const searchesRead = deriveXDiagnostics({
      accountUsername: '@Example_User',
      profile: {},
      latest: { posts: [{ authorHandle: 'other_user', remoteId: '1' }] },
      people: { handles: ['other_user'] },
    });

    expect(searchesRead).toMatchObject({
      profileRead: false,
      profilePublic: null,
      appearsInPeopleSearch: false,
      recentPostsInLatestSearch: false,
      latestSearchPostCount: 0,
    });
  });

  it('keeps false for a profile page that read fine but did not return the configured handle', () => {
    const result = deriveXDiagnostics({
      accountUsername: '@Example_User',
      profile: { username: 'someone_else' },
      latest: { posts: [{ authorHandle: 'someone_else', remoteId: '1' }] },
      people: { handles: ['someone_else'] },
    });

    expect(result).toMatchObject({
      profileRead: true,
      profilePublic: false,
      profileHandleMatches: false,
      appearsInPeopleSearch: false,
      recentPostsInLatestSearch: false,
      latestSearchPostCount: 0,
    });
  });

  it('keeps a positive search observation true even when the profile page read came back empty', () => {
    const result = deriveXDiagnostics({
      accountUsername: '@Example_User',
      profile: {},
      latest: { posts: [{ authorHandle: 'example_user', remoteId: '1' }] },
      people: { exactMatch: true },
    });

    expect(result).toMatchObject({
      profileRead: false,
      profilePublic: null,
      appearsInPeopleSearch: true,
      recentPostsInLatestSearch: true,
      latestSearchPostCount: 1,
    });
  });
});

describe('syncAccount error reporting', () => {
  const accountRow = { id: 'acct-1', username: 'example_user', enabled: true, label: 'Example', profile_snapshot: {} };

  beforeEach(() => {
    vi.clearAllMocks();
    query.mockImplementation(async (sql) => {
      if (/FROM x_accounts/.test(sql)) return { rows: [accountRow] };
      return { rows: [] };
    });
  });

  const runSync = async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    withTransaction.mockImplementation(async (callback) => callback(client));
    const result = await syncAccount('acct-1');
    const update = client.query.mock.calls.find(([sql]) => /UPDATE x_accounts/.test(sql));
    return { result, update };
  };

  it('records a read failure instead of clearing last_error when the pages come back empty', async () => {
    executeXBrowserRead.mockResolvedValue({ profile: { username: '' }, posts: [], handles: [] });

    const { result, update } = await runSync();

    expect(result.diagnostics.profilePublic).toBeNull();
    expect(update[1][2]).toBe(buildXReadError({ profileRead: false, peopleRead: false, latestRead: false }));
    expect(update[1][2]).toMatch(/profile page, account search, Latest search/);
  });

  it('clears last_error when every page read successfully', async () => {
    executeXBrowserRead.mockImplementation(async (name) => (name === 'people'
      ? { handles: ['example_user'], exactMatch: true }
      : { profile: { username: 'example_user' }, posts: [{ authorHandle: 'example_user', remoteId: '1' }] }));

    const { result, update } = await runSync();

    expect(result.diagnostics.profilePublic).toBe(true);
    expect(result.diagnostics.appearsInPeopleSearch).toBe(true);
    expect(update[1][2]).toBe('');
  });

  // A browser read can hand back a "post" whose id is a slug, an `analytics`
  // path segment, or an empty string — anything that is not the numeric status
  // id X actually keys on. Persisting one writes a row that can never
  // ON CONFLICT-merge with the real post, so the same post ingests twice.
  it('drops remote posts whose id is not a numeric X status id', async () => {
    executeXBrowserRead.mockImplementation(async (name) => {
      if (name === 'people') return { handles: [], exactMatch: false };
      if (name === 'profile') {
        return {
          profile: { username: 'example_user' },
          posts: [
            { authorHandle: 'example_user', remoteId: '1750000000000000001' },
            { authorHandle: 'example_user', remoteId: 'analytics' },
          ],
        };
      }
      return {
        posts: [
          { authorHandle: 'example_user', remoteId: '' },
          { authorHandle: 'example_user', remoteId: '17500000000000000zz' },
          { authorHandle: 'example_user', remoteId: '1750000000000000002' },
        ],
      };
    });

    const client = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    withTransaction.mockImplementation(async (callback) => callback(client));
    const result = await syncAccount('acct-1');

    const inserted = client.query.mock.calls
      .filter(([sql]) => /INSERT INTO x_posts/.test(sql))
      .map(([, params]) => params[2]);
    expect(inserted).toEqual(['1750000000000000001', '1750000000000000002']);
    expect(result.ingested).toBe(2);
  });

  // Re-entrancy guard, not a concurrency defense (see the Security Model): the
  // UI can fire the same sync twice — from a button and a socket refresh — and
  // the second must join the in-flight read instead of opening a second browser
  // session against the same account.
  it('joins an in-flight sync for the same account instead of reading twice', async () => {
    executeXBrowserRead.mockImplementation(async (name) => (name === 'people'
      ? { handles: ['example_user'], exactMatch: true }
      : { profile: { username: 'example_user' }, posts: [] }));
    const client = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    withTransaction.mockImplementation(async (callback) => callback(client));

    const first = syncAccount('acct-1');
    const second = syncAccount('acct-1');
    await Promise.all([first, second]);

    // profile + latest + people, once — not six reads.
    expect(executeXBrowserRead).toHaveBeenCalledTimes(3);

    // The lock releases once the run settles, so a later sync is a fresh read.
    await syncAccount('acct-1');
    expect(executeXBrowserRead).toHaveBeenCalledTimes(6);
  });
});

describe('reviewDraft state transitions', () => {
  const accountRow = { id: 'acct-1', username: 'example_user', enabled: true, label: 'Example' };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  const runReview = async (id, state, rows) => {
    query.mockImplementation(async (sql) => {
      if (/UPDATE x_drafts/.test(sql)) return { rows };
      if (/FROM x_accounts/.test(sql)) return { rows: [accountRow] };
      return { rows: [] };
    });
    const draft = await reviewDraft(id, state);
    const update = query.mock.calls.find(([sql]) => /UPDATE x_drafts/.test(sql));
    return { draft, params: update?.[1] };
  };

  it('only promotes a draft to pending_review from draft', async () => {
    const { params } = await runReview('draft-1', 'pending_review', [
      { id: 'draft-1', account_id: 'acct-1', body: 'hello', state: 'pending_review' },
    ]);
    // The WHERE clause pins the state the caller believed it was acting on, so a
    // second click (or a stale UI) can't re-run the transition.
    expect(params[3]).toBe('draft');
  });

  it.each(['approved', 'rejected'])('only moves a draft to %s from pending_review', async (state) => {
    const { params } = await runReview('draft-1', state, [
      { id: 'draft-1', account_id: 'acct-1', body: 'hello', state },
    ]);
    expect(params[3]).toBe('pending_review');
  });

  it('returns null when the draft was no longer in the expected state', async () => {
    const { draft } = await runReview('draft-1', 'approved', []);
    expect(draft).toBeNull();
  });

  it.each(['draft', 'opened', 'deleted'])('rejects %s as a review target state', async (state) => {
    await expect(reviewDraft('draft-1', state)).rejects.toThrow('Unsupported X draft review state');
  });
});

describe('openApprovedDraft approval gates', () => {
  const draftRow = (overrides = {}) => ({
    id: 'draft-1',
    account_id: 'acct-1',
    body: 'hello world',
    state: 'approved',
    approved_at: new Date().toISOString(),
    account_label: 'Example',
    username: 'example_user',
    enabled: true,
    ...overrides,
  });

  const mockDraft = (row) => {
    query.mockImplementation(async (sql) => {
      if (/UPDATE x_drafts/.test(sql)) return { rows: row ? [{ ...row, state: 'opened' }] : [] };
      if (/FROM x_drafts/.test(sql)) return { rows: row ? [row] : [] };
      return { rows: [] };
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    openXHandoff.mockResolvedValue({ url: 'https://x.com/compose/post' });
  });

  it('opens a compose window for a freshly approved draft', async () => {
    mockDraft(draftRow());
    const opened = await openApprovedDraft('draft-1');
    expect(openXHandoff).toHaveBeenCalledWith({ kind: 'compose', value: 'hello world' });
    expect(opened.state).toBe('opened');
  });

  // The 24h gate is the feature's safety story: an approval the user made
  // yesterday must not silently open a compose window they no longer intend.
  it('refuses a draft approved more than 24h ago', async () => {
    mockDraft(draftRow({ approved_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() }));
    await expect(openApprovedDraft('draft-stale')).rejects.toThrow('X draft approval is stale');
    expect(openXHandoff).not.toHaveBeenCalled();
  });

  it('still opens a draft approved just inside the 24h window', async () => {
    mockDraft(draftRow({ approved_at: new Date(Date.now() - 23 * 60 * 60 * 1000).toISOString() }));
    await expect(openApprovedDraft('draft-fresh')).resolves.toMatchObject({ state: 'opened' });
  });

  it('refuses an approved-state draft with no approval timestamp', async () => {
    mockDraft(draftRow({ approved_at: null }));
    await expect(openApprovedDraft('draft-no-stamp')).rejects.toThrow('X draft approval is stale');
    expect(openXHandoff).not.toHaveBeenCalled();
  });

  it.each(['draft', 'pending_review', 'rejected', 'opened'])('returns null for a %s draft', async (state) => {
    mockDraft(draftRow({ state }));
    await expect(openApprovedDraft(`draft-${state}`)).resolves.toBeNull();
    expect(openXHandoff).not.toHaveBeenCalled();
  });

  it('refuses to open a draft whose account is disabled', async () => {
    mockDraft(draftRow({ enabled: false }));
    await expect(openApprovedDraft('draft-disabled')).rejects.toThrow('Selected X account is disabled');
    expect(openXHandoff).not.toHaveBeenCalled();
  });

  // Same re-entrancy guard as syncAccount: a double-click must not open two
  // compose windows for one approval.
  it('joins an in-flight open for the same draft instead of handing off twice', async () => {
    mockDraft(draftRow());
    const first = openApprovedDraft('draft-1');
    const second = openApprovedDraft('draft-1');
    await Promise.all([first, second]);
    expect(openXHandoff).toHaveBeenCalledTimes(1);
  });
});
