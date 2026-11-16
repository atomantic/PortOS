import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

// Real feeds service (feeds.json) over a temp data root. Only the SSRF-guarded
// network fetch is doubled: it is the one external boundary the service has.
vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-feeds-routes-') }));
vi.mock('../lib/safeUrlFetch.js', async (importOriginal) => ({
  ...(await importOriginal()),
  fetchPublicText: vi.fn(),
}));
afterAll(cleanupTempDataRoots);

const { fetchPublicText } = await import('../lib/safeUrlFetch.js');
const { default: feedsRoutes } = await import('./feeds.js');

const app = express();
app.use(express.json());
app.use('/api/feeds', feedsRoutes);
app.use(errorMiddleware);

const api = (method, path = '', body) => request(app)[method](`/api/feeds${path}`).send(body);

const rss = (title, links) => `<?xml version="1.0"?><rss version="2.0"><channel><title>${title}</title>${links
  .map((l, i) => `<item><title>Post ${l}</title><link>https://example.com/${l}</link><description>Body ${l}</description><pubDate>Mon, 0${i + 1} Jan 2024 00:00:00 GMT</pubDate></item>`)
  .join('')}</channel></rss>`;

let urlCount = 0;
const newUrl = () => `https://example.com/feed-${urlCount++}.xml`;
const subscribe = async (xml, url = newUrl()) => {
  fetchPublicText.mockResolvedValueOnce(xml);
  const res = await api('post', '', { url });
  expect(res.status).toBe(201);
  return res.body;
};

beforeEach(() => fetchPublicText.mockReset());

describe('/api/feeds', () => {
  it('subscribes to a feed whose items then read back through the feed list, item list and stats', async () => {
    const feed = await subscribe(rss('Example Blog', ['a', 'b']));
    expect(feed).toMatchObject({ title: 'Example Blog', itemCount: 2, unreadCount: 2 });

    expect((await api('get')).body).toContainEqual(expect.objectContaining({ id: feed.id, unreadCount: 2 }));
    const items = (await api('get', `/items?feedId=${feed.id}`)).body;
    // Newest first by pubDate.
    expect(items.map((i) => i.link)).toEqual(['https://example.com/b', 'https://example.com/a']);
    expect((await api('get', '/stats')).body.topUnread).toContainEqual({ id: feed.id, title: 'Example Blog', unread: 2 });
  });

  it('maps a duplicate, unreachable or non-feed URL to 400 without persisting a subscription', async () => {
    const url = newUrl();
    await subscribe(rss('Dup', ['a']), url);
    const before = (await api('get')).body.length;

    const dup = await api('post', '', { url });
    expect(dup.status).toBe(400);
    expect(dup.body.error).toBe('Feed URL already subscribed');

    fetchPublicText.mockResolvedValueOnce(null);
    expect((await api('post', '', { url: newUrl() })).body.error).toMatch(/Could not fetch feed/);
    fetchPublicText.mockResolvedValueOnce('<html>not a feed</html>');
    expect((await api('post', '', { url: newUrl() })).body.error).toBe('That URL is not an RSS or Atom feed');

    fetchPublicText.mockClear();
    expect((await api('post', '', { url: 'not a url' })).status).toBe(400);
    expect(fetchPublicText).not.toHaveBeenCalled();
    expect((await api('get')).body).toHaveLength(before);
  });

  it('marks one item read and all of a feed read, leaving other feeds untouched', async () => {
    const one = await subscribe(rss('One', ['a1', 'a2', 'a3']));
    const two = await subscribe(rss('Two', ['b1']));
    const unread = async (feedId) => (await api('get', `/items?feedId=${feedId}&unreadOnly=true`)).body;

    const [first] = await unread(one.id);
    expect((await api('post', `/items/${first.id}/read`)).body).toEqual({ updated: true });
    expect(await unread(one.id)).toHaveLength(2);

    expect((await api('post', `/items/read-all?feedId=${one.id}`)).body).toEqual({ marked: 2 });
    expect(await unread(one.id)).toHaveLength(0);
    expect(await unread(two.id)).toHaveLength(1);

    // Without feedId it covers every feed; earlier tests' feeds share this store.
    expect((await api('post', '/items/read-all')).body.marked).toBeGreaterThanOrEqual(1);
    expect(await unread(two.id)).toHaveLength(0);
    expect((await api('get', '/stats')).body.unreadItems).toBe(0);
  });

  it('reads items with the filters the client sends and clamps pagination', async () => {
    const feed = await subscribe(rss('Paged', ['p1', 'p2', 'p3']));
    const links = async (qs) => (await api('get', `/items?feedId=${feed.id}${qs}`)).body.map((i) => i.link);

    expect(await links('&limit=1&offset=1')).toEqual(['https://example.com/p2']);
    // limit above the 500 cap is clamped rather than rejected.
    expect(await links('&limit=9999')).toHaveLength(3);
    expect((await api('get', '/items?unreadOnly=yes')).status).toBe(400);
  });

  it('refreshes a feed adding only new items, and refreshes every feed with a failure count', async () => {
    const url = newUrl();
    const feed = await subscribe(rss('Old Title', ['r1']), url);

    fetchPublicText.mockResolvedValueOnce(rss('New Title', ['r1', 'r2']));
    const refreshed = await api('post', `/${feed.id}/refresh`);
    expect(refreshed.status).toBe(200);
    expect(refreshed.body).toMatchObject({ newCount: 1, feed: { title: 'New Title', unreadCount: 2 } });
    expect((await api('get', `/items?feedId=${feed.id}`)).body).toHaveLength(2);

    fetchPublicText.mockImplementation(async (u) => (u === url ? rss('New Title', ['r1', 'r2', 'r3']) : null));
    const all = await api('post', '/refresh-all');
    expect(all.status).toBe(200);
    expect(all.body.newItems).toBe(1);
    // Every other subscription in the shared store got a null fetch.
    const feedCount = (await api('get')).body.length;
    expect(all.body).toMatchObject({ refreshed: feedCount, failures: feedCount - 1 });
    expect((await api('get', `/items?feedId=${feed.id}`)).body).toHaveLength(3);
  });

  it('removes a feed together with its items, and answers 404 for unknown feeds and items', async () => {
    const feed = await subscribe(rss('Gone', ['g1']));
    expect((await api('delete', `/${feed.id}`)).body).toEqual({ removed: true });
    expect((await api('get')).body.map((f) => f.id)).not.toContain(feed.id);
    expect((await api('get', `/items?feedId=${feed.id}`)).body).toEqual([]);

    expect((await api('delete', `/${feed.id}`)).status).toBe(404);
    expect((await api('post', '/f9/refresh')).status).toBe(404);
    expect((await api('post', '/items/i9/read')).status).toBe(404);
  });
});
