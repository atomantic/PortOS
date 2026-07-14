/**
 * RSS/Atom Feed Ingestion Service
 *
 * Manages feed subscriptions, fetches/parses RSS and Atom feeds,
 * and stores items for reading within the Brain knowledge system.
 *
 * Data stored in data/feeds.json:
 *   { feeds: [...], items: [...] }
 */

import { randomUUID } from 'crypto';
import { join } from 'path';
import { PATHS, createCachedStore } from '../lib/fileUtils.js';
import { fetchPublicText } from '../lib/safeUrlFetch.js';
import { decodeXmlEntities } from '../lib/xmlEntities.js';

const FEEDS_FILE = join(PATHS.data, 'feeds.json');
const MAX_ITEMS_PER_FEED = 100;
const FETCH_TIMEOUT_MS = 15000;

const DEFAULT_DATA = { feeds: [], items: [] };
const store = createCachedStore(FEEDS_FILE, DEFAULT_DATA, { context: 'feeds' });

// Compare items newest-first by pubDate (or fetchedAt fallback). Both writes
// and the legacy normalization pass use this so getItems can skip the sort.
const itemSortKey = (item) => Date.parse(item.pubDate || item.fetchedAt) || 0;
const compareItemsNewestFirst = (a, b) => itemSortKey(b) - itemSortKey(a);

// Sort runs on writes only; getItems trusts the invariant. Legacy unsorted
// state on disk gets normalized once on first read (see ensureItemsSorted).
// The invariant assumes this module owns all writes to feeds.json — out-of-band
// edits while the process is running won't retrigger normalization.
let _itemsSorted = false;
const sortItemsNewestFirst = (items) => {
  items.sort(compareItemsNewestFirst);
  _itemsSorted = true;
};

const isSortedNewestFirst = (items) => {
  for (let i = 1; i < items.length; i++) {
    if (compareItemsNewestFirst(items[i - 1], items[i]) > 0) return false;
  }
  return true;
};

async function ensureItemsSorted() {
  if (_itemsSorted) return;
  await store.mutate((data) => {
    if (!isSortedNewestFirst(data.items)) {
      sortItemsNewestFirst(data.items);
    } else {
      _itemsSorted = true;
    }
    return data;
  });
}

// ─── RSS/Atom Parser ────────────────────────────────────────────────────────

/**
 * Extract text content from an XML tag (non-greedy, handles CDATA).
 */
const extractTag = (xml, tag) => {
  const re = new RegExp(`<${tag}[^>]*>\\s*(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?\\s*</${tag}>`, 'i');
  const match = xml.match(re);
  return match ? match[1].trim() : '';
};

/**
 * Extract href from an Atom <link> tag.
 */
const extractAtomLink = (xml) => {
  // Prefer rel="alternate" or no rel
  const altMatch = xml.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i);
  if (altMatch) return altMatch[1];
  const anyMatch = xml.match(/<link[^>]*href=["']([^"']+)["']/i);
  return anyMatch ? anyMatch[1] : '';
};

/**
 * Strip HTML tags from a string for plain text display.
 */
const stripHtml = (html) => decodeXmlEntities(html.replace(/<[^>]+>/g, '')).trim();

/**
 * Parse RSS 2.0 feed XML into normalized items.
 */
const parseRSS = (xml) => {
  const channelMatch = xml.match(/<channel>([\s\S]*)<\/channel>/i);
  if (!channelMatch) return { title: '', items: [] };
  const channel = channelMatch[1];

  const feedTitle = extractTag(channel, 'title');

  // Split on <item> tags
  const itemBlocks = channel.match(/<item>([\s\S]*?)<\/item>/gi) || [];
  const items = itemBlocks.map(block => ({
    title: extractTag(block, 'title'),
    link: extractTag(block, 'link'),
    description: stripHtml(extractTag(block, 'description')).slice(0, 500),
    pubDate: extractTag(block, 'pubDate'),
    author: extractTag(block, 'author') || extractTag(block, 'dc:creator')
  }));

  return { title: feedTitle, items };
};

/**
 * Parse Atom feed XML into normalized items.
 */
const parseAtom = (xml) => {
  const feedTitle = extractTag(xml, 'title');

  const entryBlocks = xml.match(/<entry>([\s\S]*?)<\/entry>/gi) || [];
  const items = entryBlocks.map(block => ({
    title: extractTag(block, 'title'),
    link: extractAtomLink(block),
    description: stripHtml(extractTag(block, 'summary') || extractTag(block, 'content')).slice(0, 500),
    pubDate: extractTag(block, 'updated') || extractTag(block, 'published'),
    author: extractTag(block, 'name')
  }));

  return { title: feedTitle, items };
};

/**
 * Auto-detect feed format and parse.
 */
const parseFeed = (xml) => {
  if (/<feed[\s>]/i.test(xml)) return parseAtom(xml);
  return parseRSS(xml);
};

// ─── Feed Management ────────────────────────────────────────────────────────

export async function getFeeds() {
  const data = await store.load();
  // Pre-compute unread counts in one pass: O(I) instead of O(F×I)
  const unreadCounts = new Map();
  for (const item of data.items) {
    if (!item.read) unreadCounts.set(item.feedId, (unreadCounts.get(item.feedId) || 0) + 1);
  }
  return data.feeds.map(feed => ({
    ...feed,
    unreadCount: unreadCounts.get(feed.id) || 0
  }));
}

export async function addFeed(url) {
  // Fast pre-check for an obvious duplicate so we don't fetch the network for
  // a URL we're going to reject anyway. The authoritative re-check happens
  // inside the serialized mutate below.
  const existing = await store.load();
  if (existing.feeds.some(f => f.url === url)) {
    return { error: 'Feed URL already subscribed' };
  }

  // Fetch the feed to validate and get its title
  const xml = await fetchFeedXml(url);
  if (!xml) {
    return { error: 'Could not fetch feed — check the URL' };
  }

  const parsed = parseFeed(xml);
  const feed = {
    id: randomUUID(),
    url,
    title: parsed.title || new URL(url).hostname,
    addedAt: new Date().toISOString(),
    lastFetched: new Date().toISOString(),
    itemCount: parsed.items.length
  };

  // Add initial items
  const newItems = parsed.items.slice(0, MAX_ITEMS_PER_FEED).map(item => ({
    id: randomUUID(),
    feedId: feed.id,
    title: item.title,
    link: item.link,
    description: item.description,
    pubDate: item.pubDate,
    author: item.author,
    read: false,
    fetchedAt: new Date().toISOString()
  }));

  let dup = false;
  await store.mutate((data) => {
    if (data.feeds.some(f => f.url === url)) { dup = true; return data; }
    data.feeds.push(feed);
    data.items.push(...newItems);
    sortItemsNewestFirst(data.items);
    return data;
  });
  if (dup) return { error: 'Feed URL already subscribed' };

  console.log(`📡 Feed added: ${feed.title} (${newItems.length} items)`);

  return { feed: { ...feed, unreadCount: newItems.length } };
}

export async function removeFeed(id) {
  let removedFeed = null;
  await store.mutate((data) => {
    const idx = data.feeds.findIndex(f => f.id === id);
    if (idx === -1) return data;
    removedFeed = data.feeds[idx];
    data.feeds.splice(idx, 1);
    data.items = data.items.filter(i => i.feedId !== id);
    return data;
  });

  if (!removedFeed) return { error: 'Feed not found' };
  console.log(`🗑️ Feed removed: ${removedFeed.title}`);
  return { removed: true };
}

export async function refreshFeed(id) {
  const snapshot = await store.load();
  const feedSnapshot = snapshot.feeds.find(f => f.id === id);
  if (!feedSnapshot) return { error: 'Feed not found' };

  // Network fetch happens outside the write lock; the parsed result is applied
  // under mutate so a concurrent write can't clobber the merge (applyParsedFeed
  // is the shared no-I/O merge — dedupe, trim, bump lastFetched/itemCount/title).
  const xml = await fetchFeedXml(feedSnapshot.url);
  if (!xml) return { error: 'Could not fetch feed' };

  const parsed = parseFeed(xml);

  let result = null;
  await store.mutate((data) => {
    const feed = data.feeds.find(f => f.id === id);
    if (!feed) return data; // removed between fetch and apply
    const newCount = applyParsedFeed(data, feed, parsed);
    sortItemsNewestFirst(data.items);
    const unreadCount = data.items.filter(i => i.feedId === id && !i.read).length;
    result = { feed: { ...feed, unreadCount }, newCount };
    return data;
  });

  if (!result) return { error: 'Feed not found' };
  console.log(`🔄 Feed refreshed: ${result.feed.title} (+${result.newCount} new)`);
  return result;
}

// Fetch and parse XML for a feed without touching the store (safe to run in parallel)
async function fetchAndParseFeed(feed) {
  const xml = await fetchFeedXml(feed.url);
  if (!xml) return { feed, parsed: null, error: 'Could not fetch feed' };
  return { feed, parsed: parseFeed(xml), error: null };
}

// Apply a parsed feed result to a loaded data object (no I/O — safe to call serially)
function applyParsedFeed(data, feed, parsed) {
  const feedRecord = data.feeds.find(f => f.id === feed.id);
  if (!feedRecord) return 0;

  const existingLinks = new Set(data.items.filter(i => i.feedId === feed.id).map(i => i.link));
  const newItems = parsed.items
    .filter(item => item.link && !existingLinks.has(item.link))
    .slice(0, MAX_ITEMS_PER_FEED)
    .map(item => ({
      id: randomUUID(),
      feedId: feed.id,
      title: item.title,
      link: item.link,
      description: item.description,
      pubDate: item.pubDate,
      author: item.author,
      read: false,
      fetchedAt: new Date().toISOString()
    }));

  data.items.push(...newItems);

  // Trim to MAX_ITEMS_PER_FEED per feed (keep newest)
  const feedItems = data.items
    .filter(i => i.feedId === feed.id)
    .sort((a, b) => new Date(b.fetchedAt) - new Date(a.fetchedAt));
  if (feedItems.length > MAX_ITEMS_PER_FEED) {
    const keepIds = new Set(feedItems.slice(0, MAX_ITEMS_PER_FEED).map(i => i.id));
    data.items = data.items.filter(i => i.feedId !== feed.id || keepIds.has(i.id));
  }

  feedRecord.lastFetched = new Date().toISOString();
  feedRecord.itemCount = data.items.filter(i => i.feedId === feed.id).length;
  if (parsed.title) feedRecord.title = parsed.title;

  return newItems.length;
}

// refreshAllFeeds defers sort to a single end-of-batch pass — applyParsedFeed
// runs per feed inside the loop and we'd otherwise re-sort the whole array
// N times for an N-feed refresh.
export async function refreshAllFeeds() {
  const snapshot = await store.load();
  const feedList = [...snapshot.feeds];
  const CONCURRENCY = 5;
  let totalFailed = 0;

  // Fetch in parallel batches (no store I/O), collecting parsed results; the
  // merge into the store happens once under mutate so a concurrent write path
  // can't clobber the batch.
  const parsedResults = [];
  for (let i = 0; i < feedList.length; i += CONCURRENCY) {
    const batch = feedList.slice(i, i + CONCURRENCY);
    const fetched = await Promise.allSettled(batch.map(f => fetchAndParseFeed(f)));
    for (const r of fetched) {
      if (r.status === 'rejected') {
        totalFailed++;
        console.warn(`⚠️ feeds: fetch error: ${r.reason?.message || r.reason}`);
        continue;
      }
      const { feed, parsed, error } = r.value;
      if (error || !parsed) {
        totalFailed++;
        console.warn(`⚠️ feeds: refresh failed for ${feed.id} (${feed.url}): ${error}`);
        continue;
      }
      parsedResults.push({ feed, parsed });
    }
  }

  let totalNew = 0;
  let feedCount = 0;
  await store.mutate((data) => {
    for (const { feed, parsed } of parsedResults) {
      const newCount = applyParsedFeed(data, feed, parsed);
      console.log(`🔄 Feed refreshed: ${feed.title || feed.id} (+${newCount} new)`);
      totalNew += newCount;
    }
    if (totalNew > 0) sortItemsNewestFirst(data.items);
    feedCount = data.feeds.length;
    return data;
  });

  console.log(`📡 All feeds refreshed: +${totalNew} new items, ${totalFailed} failures`);
  return { refreshed: feedCount, newItems: totalNew, failures: totalFailed };
}

export async function getItems({ feedId, unreadOnly, limit, offset = 0 } = {}) {
  await ensureItemsSorted();
  const data = await store.load();
  let items = data.items;

  if (feedId) items = items.filter(i => i.feedId === feedId);
  if (unreadOnly) items = items.filter(i => !i.read);

  if (limit != null) return items.slice(offset, offset + limit);
  return items.slice(offset);
}

export async function markItemRead(itemId) {
  let found = false;
  await store.mutate((data) => {
    const item = data.items.find(i => i.id === itemId);
    if (!item) return data;
    item.read = true;
    found = true;
    return data;
  });
  if (!found) return { error: 'Item not found' };
  return { updated: true };
}

export async function markAllRead(feedId) {
  let count = 0;
  await store.mutate((data) => {
    for (const item of data.items) {
      if (feedId && item.feedId !== feedId) continue;
      if (!item.read) {
        item.read = true;
        count++;
      }
    }
    return data;
  });
  console.log(`✅ Marked ${count} items as read${feedId ? ` for feed ${feedId}` : ''}`);
  return { marked: count };
}

export async function getFeedStats() {
  const data = await store.load();
  // Single-pass per-feed unread tally (O(I)) — mirrors getFeeds()'s approach so
  // the widget can surface top unread feed names without a second computation.
  const unreadCounts = new Map();
  for (const item of data.items) {
    if (!item.read) unreadCounts.set(item.feedId, (unreadCounts.get(item.feedId) || 0) + 1);
  }
  const topUnread = data.feeds
    .map(feed => ({ id: feed.id, title: feed.title, unread: unreadCounts.get(feed.id) || 0 }))
    .filter(f => f.unread > 0)
    .sort((a, b) => b.unread - a.unread)
    .slice(0, 5);
  return {
    totalFeeds: data.feeds.length,
    totalItems: data.items.length,
    unreadItems: data.items.filter(i => !i.read).length,
    topUnread
  };
}

// ─── Internal Helpers ───────────────────────────────────────────────────────

const FEED_HEADERS = {
  'User-Agent': 'PortOS Feed Reader/1.0',
  Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml',
};

// Fetch a feed's XML through the shared SSRF-guarded fetch. `blockPrivate: true`
// keeps feeds' historical block-all-private posture (an arbitrary user-added
// feed URL must not be aimable at the home network) while gaining the
// connect-time IP PIN that closes the DNS-rebinding TOCTOU (#2046): the
// hostname is resolved once and undici connects to exactly that vetted address,
// re-validated and re-pinned on every redirect hop. `throwOnUnsafe: false`
// preserves this module's contract of returning null on any failure (so addFeed
// surfaces the friendly "Could not fetch feed" message rather than a bubbled
// 400) for an unsafe/private host, network error, non-ok status, or blocked
// redirect.
async function fetchFeedXml(url) {
  return fetchPublicText(url, {
    timeoutMs: FETCH_TIMEOUT_MS,
    headers: FEED_HEADERS,
    blockPrivate: true,
    throwOnUnsafe: false,
  });
}
