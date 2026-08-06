import { describe, expect, it, vi } from 'vitest';

vi.mock('../lib/db.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
vi.mock('../integrations/x/index.js', () => ({ executeXBrowserRead: vi.fn() }));
vi.mock('./xBrowser.js', () => ({ openXHandoff: vi.fn() }));

const { deriveXDiagnostics } = await import('./x.js');

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
      profilePublic: true,
      profileHandleMatches: true,
      appearsInPeopleSearch: true,
      recentPostsInLatestSearch: true,
      latestSearchPostCount: 1,
      recommendationEligibility: 'unknown',
    });
  });
});
