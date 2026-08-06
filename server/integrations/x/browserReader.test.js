import { beforeEach, describe, expect, it, vi } from 'vitest';

const navigateToUrlPinned = vi.fn();
vi.mock('../../services/browserService.js', () => ({ navigateToUrlPinned }));

const { readLatest, readPeople, readProfile } = await import('./browserReader.js');

const page = (url, evalResult) => ({ id: 'page-1', url, evalResult });

describe('X browser read transport', () => {
  beforeEach(() => {
    navigateToUrlPinned.mockReset();
  });

  it('reads a public profile from the fixed X origin and bounds the normalized shape', async () => {
    navigateToUrlPinned.mockResolvedValue(page('https://x.com/Example_User', {
      profile: {
        displayName: 'Example User',
        username: 'Example_User',
        bio: 'A public bio',
        followers: 1296,
        following: 1777,
        postCount: 7473,
      },
      posts: [{
        remoteId: '123',
        authorHandle: 'Example_User',
        body: 'A public post',
        sourceUrl: 'https://x.com/status/123',
        impressions: 382,
        replies: 1,
        reposts: 2,
        likes: 3,
        bookmarks: 4,
      }],
    }));

    await expect(readProfile('Example_User')).resolves.toEqual({
      profile: {
        displayName: 'Example User',
        username: 'example_user',
        bio: 'A public bio',
        followers: 1296,
        following: 1777,
        postCount: 7473,
        url: 'https://x.com/Example_User',
      },
      posts: [expect.objectContaining({
        remoteId: '123',
        kind: 'post',
        engagements: 10,
        sourceUrl: 'https://x.com/status/123',
      })],
    });
    expect(navigateToUrlPinned).toHaveBeenCalledWith('https://x.com/Example_User', expect.objectContaining({
      evaluateExpression: expect.stringContaining('querySelectorAll'),
    }));
  });

  it('keeps account search and latest search as separate fixed, read-only operations', async () => {
    navigateToUrlPinned
      .mockResolvedValueOnce(page('https://x.com/search?q=example_user&src=typed_query&f=user', { handles: ['example_user', 'another_user'] }))
      .mockResolvedValueOnce(page('https://x.com/search?q=from%3Aexample_user+-filter%3Areplies&src=typed_query&f=live', {
        posts: [{ remoteId: '456', authorHandle: 'example_user', body: 'Latest post', sourceUrl: 'https://x.com/status/456' }],
      }));

    await expect(readPeople('example_user')).resolves.toEqual({ handles: ['example_user', 'another_user'], exactMatch: true });
    await expect(readLatest('example_user')).resolves.toEqual({ posts: [expect.objectContaining({ remoteId: '456', body: 'Latest post' })] });
    expect(navigateToUrlPinned.mock.calls[0][0]).toBe('https://x.com/search?q=example_user&src=typed_query&f=user');
    expect(navigateToUrlPinned.mock.calls[1][0]).toBe('https://x.com/search?q=from%3Aexample_user+-filter%3Areplies&src=typed_query&f=live');
  });

  it('rejects off-origin or wrong-page browser results', async () => {
    navigateToUrlPinned.mockResolvedValueOnce(page('https://example.com/example_user', { profile: {} }));
    await expect(readProfile('example_user')).rejects.toThrow('left the fixed origin');

    navigateToUrlPinned.mockResolvedValueOnce(page('https://x.com/other', { profile: {} }));
    await expect(readProfile('example_user')).rejects.toThrow('different page than the one requested');
  });
});
