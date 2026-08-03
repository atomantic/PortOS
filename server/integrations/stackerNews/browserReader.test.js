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
    navigateToUrlPinned.mockResolvedValue(page('https://stacker.news', { username: 'example_user', id: '77' }));
    await expect(readMe()).resolves.toEqual({ me: { id: '77', name: 'example_user' } });
    expect(navigateToUrlPinned.mock.calls[0][0]).toBe('https://stacker.news');
    expect(navigateToUrlPinned.mock.calls[0][1].evaluateExpression).toContain('__NEXT_DATA__');
    // Teardown of a read tab belongs to `navigateToUrlPinned` (#3365): passing
    // `evaluateExpression` IS the request for it, so this transport must not
    // close anything itself — the tab is already gone when it returns.
    expect(closeCdpPage).not.toHaveBeenCalled();
  });

  // The identity extractor is shared with the handoff's "Check browser identity"
  // so the two can never disagree — including its profile-link fallback, which
  // yields a username but no user ID.
  it('accepts the shared extractor profile-link fallback, with no user ID to verify ownership against', async () => {
    navigateToUrlPinned.mockResolvedValue(page('https://stacker.news', { username: 'example_user', id: null }));
    await expect(readMe()).resolves.toEqual({ me: { id: null, name: 'example_user' } });
  });

  it('throws when the pinned browser is not signed in', async () => {
    navigateToUrlPinned.mockResolvedValue(page('https://stacker.news', { username: null, id: null }));
    await expect(readMe()).rejects.toThrow('not signed in');
  });

  it('builds only the fixed territory URL and normalizes the sub selection', async () => {
    navigateToUrlPinned.mockResolvedValue(page('https://stacker.news/~example/new', {
      sub: {
        name: 'example', userId: 42, baseCost: 1, replyCost: 1, postsSatsFilter: 0,
        postTypes: ['LINK', 'DISCUSSION'], status: 'ACTIVE', nsfw: false,
      },
    }));
    await expect(readSub('example')).resolves.toEqual({
      sub: { name: 'example', userId: '42', baseCost: 1, postsSatsFilter: 0, replyCost: 1, postTypes: ['LINK', 'DISCUSSION'], status: 'ACTIVE', nsfw: false },
    });
    expect(navigateToUrlPinned.mock.calls[0][0]).toBe('https://stacker.news/~example/new');
  });

  it('reports a territory the page does not know about as a null sub rather than throwing', async () => {
    navigateToUrlPinned.mockResolvedValue(page('https://stacker.news/~ghost/new', { sub: null }));
    await expect(readSub('ghost')).resolves.toEqual({ sub: null });
  });

  it('carries the cursor into the fixed URL and back out of the items page', async () => {
    navigateToUrlPinned.mockResolvedValue(page('https://stacker.news/~example/new?cursor=page-2', {
      items: {
        cursor: 'page-3',
        items: [{ id: 42, createdAt: '2026-01-01T00:00:00Z', updatedAt: null, title: 'Example work', text: 'A post', url: '', parentId: null, user: { name: 'example_artist' }, subName: 'example' }],
      },
    }));
    await expect(readItems('example', 'page-2')).resolves.toEqual({
      items: {
        cursor: 'page-3',
        items: [{ id: '42', createdAt: '2026-01-01T00:00:00Z', updatedAt: null, title: 'Example work', text: 'A post', url: '', parentId: null, user: { name: 'example_artist' }, subName: 'example' }],
      },
    });
    expect(navigateToUrlPinned.mock.calls[0][0]).toBe('https://stacker.news/~example/new?cursor=page-2');
  });

  it('omits the cursor parameter on the first page', async () => {
    navigateToUrlPinned.mockResolvedValue(page('https://stacker.news/~example/new', { items: { cursor: null, items: [] } }));
    await expect(readItems('example')).resolves.toEqual({ items: { cursor: null, items: [] } });
    expect(navigateToUrlPinned.mock.calls[0][0]).toBe('https://stacker.news/~example/new');
  });

  // A failed extraction must never look like a quiet empty page: sync would
  // clear last_error and advance last_sync_at while ingesting nothing.
  it('throws when the page yielded no extractable payload instead of reporting an empty page', async () => {
    // Echo the requested URL back so only the missing payload can fail the read.
    navigateToUrlPinned.mockImplementation(async (url) => page(url, null));
    await expect(readItems('example')).rejects.toThrow('Could not read Stacker News data');
    await expect(readSub('example')).rejects.toThrow('Could not read Stacker News data');
    await expect(readMe()).rejects.toThrow('Could not read Stacker News data');

    // Same for a payload that is not the envelope our own extractor returns.
    navigateToUrlPinned.mockImplementation(async (url) => page(url, 'unexpected'));
    await expect(readItems('example')).rejects.toThrow('Could not read Stacker News data');
    navigateToUrlPinned.mockImplementation(async (url) => page(url, { items: { cursor: null } }));
    await expect(readItems('example')).rejects.toThrow('Could not read Stacker News data');
  });

  it('re-normalizes whatever the untrusted page returned instead of trusting its projection', async () => {
    navigateToUrlPinned.mockResolvedValue(page('https://stacker.news/~example/new', {
      items: {
        cursor: { evil: true },
        items: [
          { id: null, title: 'dropped: no id' },
          { id: true, title: 'dropped: an id that is not a string or number' },
          { id: { toString: 'nope' }, title: 'dropped: object id' },
          { id: 7, title: { evil: true }, text: null, user: null, parentId: 9 },
        ],
      },
    }));
    await expect(readItems('example')).resolves.toEqual({
      items: {
        cursor: null,
        items: [{ id: '7', createdAt: null, updatedAt: null, title: '', text: '', url: '', parentId: '9', user: { name: '' }, subName: '' }],
      },
    });
  });

  // The off-origin refusal used to have to close the tab BEFORE throwing. The
  // tab is now already torn down by the time the pinned navigation returns, so
  // the throw can be direct and this module still leaks nothing.
  it('refuses a navigation that landed off the fixed origin, without owning the tab', async () => {
    navigateToUrlPinned.mockResolvedValue(page('https://example.com/~example/new', { items: { cursor: null, items: [] } }));
    await expect(readItems('example')).rejects.toThrow('left the fixed origin');
    expect(closeCdpPage).not.toHaveBeenCalled();
  });

  // Stacker News redirects a renamed/merged territory to a different same-origin
  // one; filing that page under the configured slug would store another
  // territory's owner ID as this territory's ownership evidence.
  it('refuses a same-origin redirect to a different territory', async () => {
    navigateToUrlPinned.mockResolvedValue(page('https://stacker.news/~other/new', { items: { cursor: null, items: [] } }));
    await expect(readItems('example')).rejects.toThrow('different page than the one requested');
    expect(closeCdpPage).not.toHaveBeenCalled();
  });

  it('tolerates a trailing-slash or case difference in the landed URL', async () => {
    navigateToUrlPinned.mockResolvedValue(page('https://stacker.news/~Example/new/?nodata=1', { items: { cursor: null, items: [] } }));
    await expect(readItems('example')).resolves.toEqual({ items: { cursor: null, items: [] } });
  });

  it('refuses a payload naming a territory other than the one requested', async () => {
    navigateToUrlPinned.mockResolvedValue(page('https://stacker.news/~example/new', { sub: { name: 'other', userId: '42' } }));
    await expect(readSub('example')).rejects.toThrow('for a different requested territory');
  });

  it('bounds a page to the caller-requested limit, matching the GraphQL transport', async () => {
    const items = Array.from({ length: 40 }, (_, index) => ({ id: index + 1, user: { name: 'example_artist' } }));
    navigateToUrlPinned.mockResolvedValue(page('https://stacker.news/~example/new', { items: { cursor: null, items } }));
    await expect(executeStackerNewsBrowserRead('items', { sub: 'example', limit: 30 })).resolves.toMatchObject({ items: { items: expect.any(Array) } });
    const bounded = await executeStackerNewsBrowserRead('items', { sub: 'example', limit: 30 });
    expect(bounded.items.items).toHaveLength(30);
    const unbounded = await readItems('example');
    expect(unbounded.items.items).toHaveLength(40);
  });

  it('rejects a territory name or cursor the closed registry does not allow', async () => {
    await expect(readSub('../../etc/passwd')).rejects.toThrow('Invalid Stacker News territory name');
    await expect(readItems('example', 'x'.repeat(401))).rejects.toThrow('Invalid Stacker News cursor');
    expect(navigateToUrlPinned).not.toHaveBeenCalled();
  });

  it('dispatches named operations with the same envelope as the GraphQL transport', async () => {
    navigateToUrlPinned.mockResolvedValue(page('https://stacker.news', { username: 'example_user', id: '1' }));
    await expect(executeStackerNewsBrowserRead('me')).resolves.toEqual({ me: { id: '1', name: 'example_user' } });
    await expect(executeStackerNewsBrowserRead('nope')).rejects.toThrow('Unsupported Stacker News browser read');
  });
});
