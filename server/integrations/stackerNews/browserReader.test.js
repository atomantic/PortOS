import { beforeEach, describe, expect, it, vi } from 'vitest';

const navigateToUrlPinned = vi.fn();
const closeCdpPage = vi.fn(async () => {});
vi.mock('../../services/browserService.js', () => ({ navigateToUrlPinned, closeCdpPage }));
const { executeStackerNewsBrowserRead, readItems, readMe, readSub } = await import('./browserReader.js');

const page = (url, evalResult) => ({ id: 'page-1', url, evalResult });

describe('Stacker News browser read transport', () => {
  beforeEach(() => {
    navigateToUrlPinned.mockReset();
    closeCdpPage.mockClear();
  });

  it('reads the signed-in identity from the fixed origin and normalizes to the API shape', async () => {
    navigateToUrlPinned.mockResolvedValue(page('https://stacker.news', { id: 77, name: 'example_user' }));
    await expect(readMe()).resolves.toEqual({ me: { id: '77', name: 'example_user' } });
    expect(navigateToUrlPinned.mock.calls[0][0]).toBe('https://stacker.news');
    expect(navigateToUrlPinned.mock.calls[0][1].evaluateExpression).toContain('__NEXT_DATA__');
    expect(closeCdpPage).toHaveBeenCalledWith('page-1');
  });

  it('throws when the pinned browser is not signed in', async () => {
    navigateToUrlPinned.mockResolvedValue(page('https://stacker.news', null));
    await expect(readMe()).rejects.toThrow('not signed in');
  });

  it('builds only the fixed territory URL and normalizes the sub selection', async () => {
    navigateToUrlPinned.mockResolvedValue(page('https://stacker.news/~example/recent', {
      name: 'example', userId: 42, baseCost: 1, replyCost: 1, postsSatsFilter: 0,
      postTypes: ['LINK', 'DISCUSSION'], status: 'ACTIVE', nsfw: false,
    }));
    await expect(readSub('example')).resolves.toEqual({
      sub: { name: 'example', userId: '42', baseCost: 1, postsSatsFilter: 0, replyCost: 1, postTypes: ['LINK', 'DISCUSSION'], status: 'ACTIVE', nsfw: false },
    });
    expect(navigateToUrlPinned.mock.calls[0][0]).toBe('https://stacker.news/~example/recent');
  });

  it('reports a missing territory as a null sub rather than throwing', async () => {
    navigateToUrlPinned.mockResolvedValue(page('https://stacker.news/~ghost/recent', null));
    await expect(readSub('ghost')).resolves.toEqual({ sub: null });
  });

  it('carries the cursor into the fixed URL and back out of the items page', async () => {
    navigateToUrlPinned.mockResolvedValue(page('https://stacker.news/~example/recent?cursor=page-2', {
      cursor: 'page-3',
      items: [{ id: 42, createdAt: '2026-01-01T00:00:00Z', updatedAt: null, title: 'Example work', text: 'A post', url: '', parentId: null, user: { name: 'example_artist' }, subName: 'example' }],
    }));
    await expect(readItems('example', 'page-2')).resolves.toEqual({
      items: {
        cursor: 'page-3',
        items: [{ id: '42', createdAt: '2026-01-01T00:00:00Z', updatedAt: null, title: 'Example work', text: 'A post', url: '', parentId: null, user: { name: 'example_artist' }, subName: 'example' }],
      },
    });
    expect(navigateToUrlPinned.mock.calls[0][0]).toBe('https://stacker.news/~example/recent?cursor=page-2');
  });

  it('omits the cursor parameter on the first page', async () => {
    navigateToUrlPinned.mockResolvedValue(page('https://stacker.news/~example/recent', { cursor: null, items: [] }));
    await expect(readItems('example')).resolves.toEqual({ items: { cursor: null, items: [] } });
    expect(navigateToUrlPinned.mock.calls[0][0]).toBe('https://stacker.news/~example/recent');
  });

  it('re-normalizes whatever the untrusted page returned instead of trusting its projection', async () => {
    navigateToUrlPinned.mockResolvedValue(page('https://stacker.news/~example/recent', {
      cursor: { evil: true },
      items: [
        { id: null, title: 'dropped: no id' },
        { id: 7, title: { evil: true }, text: null, user: null, parentId: 9 },
      ],
    }));
    await expect(readItems('example')).resolves.toEqual({
      items: {
        cursor: null,
        items: [{ id: '7', createdAt: null, updatedAt: null, title: '', text: '', url: '', parentId: '9', user: { name: '' }, subName: '' }],
      },
    });
  });

  it('refuses a navigation that landed off the fixed origin, and still closes the tab', async () => {
    navigateToUrlPinned.mockResolvedValue(page('https://example.com/~example/recent', { cursor: null, items: [] }));
    await expect(readItems('example')).rejects.toThrow('left the fixed origin');
    expect(closeCdpPage).toHaveBeenCalledWith('page-1');
  });

  it('rejects a territory name or cursor the closed registry does not allow', async () => {
    await expect(readSub('../../etc/passwd')).rejects.toThrow('Invalid Stacker News territory name');
    await expect(readItems('example', 'x'.repeat(401))).rejects.toThrow('Invalid Stacker News cursor');
    expect(navigateToUrlPinned).not.toHaveBeenCalled();
  });

  it('dispatches named operations with the same envelope as the GraphQL transport', async () => {
    navigateToUrlPinned.mockResolvedValue(page('https://stacker.news', { id: '1', name: 'example_user' }));
    await expect(executeStackerNewsBrowserRead('me')).resolves.toEqual({ me: { id: '1', name: 'example_user' } });
    await expect(executeStackerNewsBrowserRead('nope')).rejects.toThrow('Unsupported Stacker News browser read');
  });
});
