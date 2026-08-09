import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/db.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
vi.mock('../integrations/x/index.js', () => ({ executeXBrowserRead: vi.fn() }));
vi.mock('./xBrowser.js', () => ({ openXHandoff: vi.fn() }));

const { query, withTransaction } = await import('../lib/db.js');
const { executeXBrowserRead } = await import('../integrations/x/index.js');
const { deriveXDiagnostics, syncAccount, PROFILE_READ_FAILED_ERROR } = await import('./x.js');

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

  it('records a read failure instead of clearing last_error when the profile page is unreadable', async () => {
    executeXBrowserRead.mockResolvedValue({ profile: { username: '' }, posts: [] });

    const { result, update } = await runSync();

    expect(result.diagnostics.profilePublic).toBeNull();
    expect(update[1][2]).toBe(PROFILE_READ_FAILED_ERROR);
  });

  it('clears last_error when the profile page read successfully', async () => {
    executeXBrowserRead.mockResolvedValue({ profile: { username: 'example_user' }, posts: [] });

    const { result, update } = await runSync();

    expect(result.diagnostics.profilePublic).toBe(true);
    expect(update[1][2]).toBe('');
  });
});
