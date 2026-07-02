import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { makePathsProxy } from '../lib/mockPathsDataRoot.js';

let tmpRoot;

vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  return makePathsProxy(actual, { dataRoot: () => tmpRoot });
});

// feeds.js fetches through the shared SSRF-guarded helper (server/lib/safeUrlFetch.js),
// which is exercised for real here — we only mock its two boundaries: the DNS
// resolve (dns.lookup) and the timed fetch. safeUrlFetch resolves a hostname
// once via dns.lookup and PINS the connection to that vetted address, so these
// tests drive the same rebinding-pin path production uses.
const fetchMock = vi.fn();
vi.mock('../lib/fetchWithTimeout.js', () => ({
  fetchWithTimeout: (...args) => fetchMock(...args),
}));

const lookupMock = vi.fn();
vi.mock('dns/promises', () => ({
  default: { lookup: (...args) => lookupMock(...args) },
  lookup: (...args) => lookupMock(...args),
}));

let feeds;

beforeAll(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterAll(() => {
  vi.restoreAllMocks();
});

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'portos-feeds-test-'));
  vi.resetModules();
  fetchMock.mockReset();
  lookupMock.mockReset().mockResolvedValue({ address: '93.184.216.34', family: 4 });
  feeds = await import('./feeds.js');
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(tmpRoot, { recursive: true, force: true });
});

const makeResponse = ({ status = 200, body = '', headers = {} } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k) => headers[k.toLowerCase()] || null },
  text: async () => body,
});

const RSS_FIXTURE = `<?xml version="1.0"?>
<rss version="2.0"><channel>
<title>Example Feed</title>
<item>
  <title>First Post</title>
  <link>https://example.com/posts/1</link>
  <description><![CDATA[<p>Hello <b>world</b></p>]]></description>
  <pubDate>Mon, 18 May 2026 10:00:00 GMT</pubDate>
  <author>Alice</author>
</item>
<item>
  <title>Second Post</title>
  <link>https://example.com/posts/2</link>
  <description>Plain &amp; simple</description>
  <pubDate>Tue, 19 May 2026 10:00:00 GMT</pubDate>
  <dc:creator>Bob</dc:creator>
</item>
</channel></rss>`;

const ATOM_FIXTURE = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<title>Atom Source</title>
<entry>
  <title>Entry One</title>
  <link rel="self" href="https://example.com/atom/1.self"/>
  <link rel="alternate" href="https://example.com/atom/1"/>
  <summary>summary one</summary>
  <updated>2026-05-18T12:00:00Z</updated>
  <author><name>Carol</name></author>
</entry>
<entry>
  <title>Entry Two</title>
  <link href="https://example.com/atom/2"/>
  <content>content two</content>
  <published>2026-05-19T12:00:00Z</published>
</entry>
</feed>`;

const FETCH_ERROR = 'Could not fetch feed — check the URL';

describe('getFeeds / getFeedStats — empty state', () => {
  it('returns empty arrays before any subscriptions', async () => {
    expect(await feeds.getFeeds()).toEqual([]);
    expect(await feeds.getFeedStats()).toEqual({ totalFeeds: 0, totalItems: 0, unreadItems: 0 });
  });
});

describe('addFeed', () => {
  it('subscribes to a valid RSS feed and seeds initial items', async () => {
    fetchMock.mockResolvedValue(makeResponse({ body: RSS_FIXTURE }));
    const result = await feeds.addFeed('https://example.com/rss');
    expect(result.error).toBeUndefined();
    expect(result.feed).toMatchObject({
      url: 'https://example.com/rss',
      title: 'Example Feed',
      itemCount: 2,
      unreadCount: 2,
    });

    const items = await feeds.getItems({});
    expect(items).toHaveLength(2);
    expect(items[0].title).toBe('Second Post');
    expect(items[0].author).toBe('Bob');
    expect(items[1].description).toBe('Hello world');
  });

  it('parses Atom feeds and prefers rel="alternate" link', async () => {
    fetchMock.mockResolvedValue(makeResponse({ body: ATOM_FIXTURE }));
    const result = await feeds.addFeed('https://example.com/atom');
    expect(result.feed.title).toBe('Atom Source');
    const items = await feeds.getItems({});
    expect(items.map(i => i.link).sort()).toEqual([
      'https://example.com/atom/1',
      'https://example.com/atom/2',
    ]);
  });

  it('rejects duplicate URLs', async () => {
    fetchMock.mockResolvedValue(makeResponse({ body: RSS_FIXTURE }));
    await feeds.addFeed('https://example.com/rss');
    const dup = await feeds.addFeed('https://example.com/rss');
    expect(dup).toEqual({ error: 'Feed URL already subscribed' });
  });

  it('returns an error when the fetch returns nothing fetchable', async () => {
    fetchMock.mockResolvedValue(null);
    const result = await feeds.addFeed('https://example.com/dead');
    expect(result).toEqual({ error: FETCH_ERROR });
  });

  it.each([
    ['file://', 'file:///etc/passwd'],
    ['data://', 'data:text/xml,<rss/>'],
  ])('rejects non-http(s) protocol %s (SSRF guard)', async (_label, url) => {
    const result = await feeds.addFeed(url);
    expect(result).toEqual({ error: FETCH_ERROR });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    '127.0.0.1',
    '10.0.0.1',
    '192.168.1.1',
    '172.16.5.5',
    '169.254.169.254',
    '0.0.0.0',
  ])('rejects literal private IPv4 %s without DNS lookup', async (host) => {
    const result = await feeds.addFeed(`http://${host}/feed`);
    expect(result).toEqual({ error: FETCH_ERROR });
    expect(lookupMock).not.toHaveBeenCalled(); // literal is classified without resolving
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['IPv6 loopback', '[::1]'],
    ['IPv6 unspecified', '[::]'],
    ['IPv6 ULA fc00::/7 (fc..)', '[fc00::1]'],
    ['IPv6 ULA fc00::/7 (fd..)', '[fd12:3456:789a::1]'],
    ['IPv6 link-local fe80::/10', '[fe80::1]'],
    ['IPv4-mapped loopback', '[::ffff:127.0.0.1]'],
    ['IPv4-mapped RFC1918', '[::ffff:192.168.1.1]'],
  ])('rejects literal private IPv6 %s without DNS lookup', async (_label, host) => {
    const result = await feeds.addFeed(`http://${host}/feed`);
    expect(result).toEqual({ error: FETCH_ERROR });
    expect(lookupMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts a public IPv6 literal (covers stripped-brackets path)', async () => {
    fetchMock.mockResolvedValue(makeResponse({ body: RSS_FIXTURE }));
    const result = await feeds.addFeed('http://[2606:4700:4700::1111]/rss');
    expect(result.error).toBeUndefined();
    expect(lookupMock).not.toHaveBeenCalled(); // literal needs no resolve/pin
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Bracketed form must survive into the outbound fetch URL — bracket-stripping
    // happens only inside the private-literal classifier.
    expect(fetchMock.mock.calls[0][0]).toContain('[2606:4700:4700::1111]');
  });

  it('rejects hostnames that resolve to a private IP (DNS rebinding guard)', async () => {
    lookupMock.mockResolvedValue({ address: '10.0.0.42', family: 4 });
    const result = await feeds.addFeed('https://evil.example.com/rss');
    expect(result).toEqual({ error: FETCH_ERROR });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects hostnames that resolve to a link-local / metadata IP', async () => {
    lookupMock.mockResolvedValue({ address: '169.254.169.254', family: 4 });
    const result = await feeds.addFeed('https://metadata.example.com/rss');
    expect(result).toEqual({ error: FETCH_ERROR });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed when the hostname cannot be resolved (no unpinned fetch)', async () => {
    // A hostname we can't vet must never fall through to an unpinned connect —
    // that connect would re-resolve at TCP time, exactly the rebinding window.
    lookupMock.mockRejectedValue(Object.assign(new Error('not found'), { code: 'ENOTFOUND' }));
    const result = await feeds.addFeed('https://no-records.example.com/rss');
    expect(result).toEqual({ error: FETCH_ERROR });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts a hostname that resolves to a public IPv6 address', async () => {
    fetchMock.mockResolvedValue(makeResponse({ body: RSS_FIXTURE }));
    lookupMock.mockResolvedValue({ address: '2606:4700:4700::1111', family: 6 });
    const result = await feeds.addFeed('https://v6only.example.com/rss');
    expect(result.error).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Connection is pinned to the vetted address (undici would otherwise re-resolve).
    expect(fetchMock.mock.calls[0][1].dispatcher).toBeDefined();
  });

  it('pins the connection to the vetted address (rebinding TOCTOU closed)', async () => {
    fetchMock.mockResolvedValue(makeResponse({ body: RSS_FIXTURE }));
    lookupMock.mockResolvedValue({ address: '93.184.216.34', family: 4 });
    await feeds.addFeed('https://rebind.example.com/rss');
    expect(fetchMock.mock.calls[0][1].dispatcher).toBeDefined();
  });

  it('follows a single safe redirect to the new URL', async () => {
    fetchMock
      .mockResolvedValueOnce(makeResponse({ status: 302, headers: { location: 'https://example.com/final.xml' } }))
      .mockResolvedValueOnce(makeResponse({ body: RSS_FIXTURE }));
    const result = await feeds.addFeed('https://example.com/redirect');
    expect(result.error).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe('https://example.com/final.xml');
    expect(fetchMock.mock.calls[1][1].redirect).toBe('error');
  });

  it('rejects redirects to private IPs without making the second fetch', async () => {
    lookupMock.mockImplementation(async (host) =>
      host === 'evil.example.com' ? { address: '10.0.0.1', family: 4 } : { address: '93.184.216.34', family: 4 });
    fetchMock.mockResolvedValueOnce(makeResponse({ status: 302, headers: { location: 'https://evil.example.com/x' } }));
    const result = await feeds.addFeed('https://example.com/redirect');
    expect(result).toEqual({ error: FETCH_ERROR });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lookupMock).toHaveBeenCalledWith('evil.example.com');
  });

  it('falls back to the URL hostname when the feed has no <title>', async () => {
    fetchMock.mockResolvedValue(makeResponse({ body: '<rss><channel></channel></rss>' }));
    const result = await feeds.addFeed('https://blog.example.com/rss');
    expect(result.feed.title).toBe('blog.example.com');
  });
});

describe('removeFeed', () => {
  it('removes the feed and all its items', async () => {
    fetchMock.mockResolvedValue(makeResponse({ body: RSS_FIXTURE }));
    const { feed } = await feeds.addFeed('https://example.com/rss');
    const result = await feeds.removeFeed(feed.id);
    expect(result).toEqual({ removed: true });
    expect(await feeds.getFeeds()).toHaveLength(0);
    expect(await feeds.getItems({})).toHaveLength(0);
  });

  it('returns an error for an unknown id', async () => {
    expect(await feeds.removeFeed('not-real')).toEqual({ error: 'Feed not found' });
  });
});

describe('refreshFeed', () => {
  it('adds only new items (dedupe by link) and bumps lastFetched', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-19T10:00:00Z'));
    fetchMock.mockResolvedValueOnce(makeResponse({ body: RSS_FIXTURE }));
    const { feed } = await feeds.addFeed('https://example.com/rss');
    const before = feed.lastFetched;

    vi.setSystemTime(new Date('2026-05-19T10:01:00Z'));
    const NEXT = RSS_FIXTURE.replace(
      '</channel></rss>',
      `<item><title>Third</title><link>https://example.com/posts/3</link><pubDate>Wed, 20 May 2026 10:00:00 GMT</pubDate></item></channel></rss>`,
    );
    fetchMock.mockResolvedValueOnce(makeResponse({ body: NEXT }));

    const result = await feeds.refreshFeed(feed.id);
    expect(result.newCount).toBe(1);
    expect(result.feed.itemCount).toBe(3);
    expect(result.feed.lastFetched).not.toBe(before);
    expect((await feeds.getItems({ feedId: feed.id })).map(i => i.title)).toContain('Third');
  });

  it('returns an error when the feed id is unknown', async () => {
    expect(await feeds.refreshFeed('missing')).toEqual({ error: 'Feed not found' });
  });

  it('returns an error when the fetch fails', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse({ body: RSS_FIXTURE }));
    const { feed } = await feeds.addFeed('https://example.com/rss');
    fetchMock.mockResolvedValueOnce(null);
    expect(await feeds.refreshFeed(feed.id)).toEqual({ error: 'Could not fetch feed' });
  });
});

describe('refreshAllFeeds', () => {
  it('refreshes every subscribed feed in parallel and counts new items', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse({ body: RSS_FIXTURE }));
    const a = (await feeds.addFeed('https://example.com/rss')).feed;
    fetchMock.mockResolvedValueOnce(makeResponse({ body: ATOM_FIXTURE }));
    const b = (await feeds.addFeed('https://example.com/atom')).feed;

    const A_NEXT = RSS_FIXTURE.replace(
      '</channel></rss>',
      `<item><title>RSS New</title><link>https://example.com/posts/N</link></item></channel></rss>`,
    );
    const B_NEXT = ATOM_FIXTURE.replace(
      '</feed>',
      `<entry><title>Atom New</title><link href="https://example.com/atom/N"/><updated>2026-05-20T12:00:00Z</updated></entry></feed>`,
    );

    // Deferred-promise pattern: each fetch parks until externally resolved.
    // If refreshAllFeeds were serial, fetch B wouldn't start before A resolved,
    // so resolving A first and asserting B is in-flight pins true parallelism.
    let resolveA;
    let resolveB;
    const aFetch = new Promise(r => { resolveA = r; });
    const bFetch = new Promise(r => { resolveB = r; });
    fetchMock.mockImplementation((url) =>
      url.includes('/atom') ? bFetch : aFetch,
    );

    fetchMock.mockClear();
    const refreshPromise = feeds.refreshAllFeeds();
    await new Promise(r => setImmediate(r));
    expect(fetchMock).toHaveBeenCalledTimes(2);

    resolveA(makeResponse({ body: A_NEXT }));
    resolveB(makeResponse({ body: B_NEXT }));
    const result = await refreshPromise;
    expect(result).toMatchObject({ refreshed: 2, newItems: 2, failures: 0 });
    expect((await feeds.getItems({ feedId: a.id })).map(i => i.title)).toContain('RSS New');
    expect((await feeds.getItems({ feedId: b.id })).map(i => i.title)).toContain('Atom New');
  });

  it('counts failures separately when a feed cannot be fetched', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse({ body: RSS_FIXTURE }));
    await feeds.addFeed('https://example.com/rss');
    fetchMock.mockResolvedValue(null);
    const result = await feeds.refreshAllFeeds();
    expect(result.failures).toBe(1);
    expect(result.newItems).toBe(0);
  });
});

const seedTwoFeeds = async () => {
  fetchMock.mockResolvedValueOnce(makeResponse({ body: RSS_FIXTURE }));
  const a = (await feeds.addFeed('https://example.com/rss')).feed;
  fetchMock.mockResolvedValueOnce(makeResponse({ body: ATOM_FIXTURE }));
  const b = (await feeds.addFeed('https://example.com/atom')).feed;
  return { feedA: a, feedB: b };
};

describe('getItems', () => {
  let feedA;

  beforeEach(async () => {
    ({ feedA } = await seedTwoFeeds());
  });

  it('filters by feedId', async () => {
    const aItems = await feeds.getItems({ feedId: feedA.id });
    expect(aItems).toHaveLength(2);
    expect(aItems.every(i => i.feedId === feedA.id)).toBe(true);
  });

  it('filters unread-only', async () => {
    const items = await feeds.getItems({});
    await feeds.markItemRead(items[0].id);
    const unread = await feeds.getItems({ unreadOnly: true });
    expect(unread).toHaveLength(3);
    expect(unread.every(i => !i.read)).toBe(true);
  });

  it('paginates via limit + offset', async () => {
    expect(await feeds.getItems({ limit: 2 })).toHaveLength(2);
    expect(await feeds.getItems({ limit: 2, offset: 2 })).toHaveLength(2);
    expect(await feeds.getItems({ limit: 10, offset: 4 })).toHaveLength(0);
  });

  it('returns items newest-first across feeds', async () => {
    const items = await feeds.getItems({});
    const dates = items.map(i => Date.parse(i.pubDate || i.fetchedAt));
    for (let i = 1; i < dates.length; i++) {
      expect(dates[i - 1]).toBeGreaterThanOrEqual(dates[i]);
    }
  });
});

describe('markItemRead / markAllRead', () => {
  it('marks a single item read', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse({ body: RSS_FIXTURE }));
    await feeds.addFeed('https://example.com/rss');
    const [item] = await feeds.getItems({});
    expect(await feeds.markItemRead(item.id)).toEqual({ updated: true });
    expect((await feeds.getItems({ unreadOnly: true })).find(i => i.id === item.id)).toBeUndefined();
  });

  it('returns an error for an unknown item id', async () => {
    expect(await feeds.markItemRead('missing')).toEqual({ error: 'Item not found' });
  });

  it('marks every item read with no scope', async () => {
    await seedTwoFeeds();
    const result = await feeds.markAllRead();
    expect(result.marked).toBe(4);
    expect(await feeds.getItems({ unreadOnly: true })).toHaveLength(0);
  });

  it('marks only the scoped feed when feedId is provided', async () => {
    const { feedA } = await seedTwoFeeds();
    const result = await feeds.markAllRead(feedA.id);
    expect(result.marked).toBe(2);
    expect(await feeds.getItems({ unreadOnly: true })).toHaveLength(2);
  });
});

describe('getFeeds — unread counts', () => {
  it('reports per-feed unread counts in O(items)', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse({ body: RSS_FIXTURE }));
    const { feed } = await feeds.addFeed('https://example.com/rss');
    const items = await feeds.getItems({ feedId: feed.id });
    await feeds.markItemRead(items[0].id);
    const [info] = await feeds.getFeeds();
    expect(info.unreadCount).toBe(1);
  });
});

describe('getFeedStats', () => {
  it('aggregates totals across feeds', async () => {
    await seedTwoFeeds();
    expect(await feeds.getFeedStats()).toEqual({ totalFeeds: 2, totalItems: 4, unreadItems: 4 });
  });
});
