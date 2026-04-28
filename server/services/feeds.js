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
import dns from 'dns/promises';
import net from 'net';
import { PATHS, createCachedStore } from '../lib/fileUtils.js';
import { fetchWithTimeout } from '../lib/fetchWithTimeout.js';

const FEEDS_FILE = join(PATHS.data, 'feeds.json');
const MAX_ITEMS_PER_FEED = 100;
const FETCH_TIMEOUT_MS = 15000;

const DEFAULT_DATA = { feeds: [], items: [] };
const store = createCachedStore(FEEDS_FILE, DEFAULT_DATA, { context: 'feeds' });

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
const stripHtml = (html) => html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();

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
  const data = await store.load();

  // Check for duplicate URL
  if (data.feeds.some(f => f.url === url)) {
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

  data.feeds.push(feed);

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
  data.items.push(...newItems);

  await store.save(data);
  console.log(`📡 Feed added: ${feed.title} (${newItems.length} items)`);

  return { feed: { ...feed, unreadCount: newItems.length } };
}

export async function removeFeed(id) {
  const data = await store.load();
  const idx = data.feeds.findIndex(f => f.id === id);
  if (idx === -1) return { error: 'Feed not found' };

  const feed = data.feeds[idx];
  data.feeds.splice(idx, 1);
  data.items = data.items.filter(i => i.feedId !== id);
  await store.save(data);

  console.log(`🗑️ Feed removed: ${feed.title}`);
  return { removed: true };
}

export async function refreshFeed(id) {
  const data = await store.load();
  const feed = data.feeds.find(f => f.id === id);
  if (!feed) return { error: 'Feed not found' };

  const xml = await fetchFeedXml(feed.url);
  if (!xml) return { error: 'Could not fetch feed' };

  const parsed = parseFeed(xml);

  // Deduplicate by link
  const existingLinks = new Set(data.items.filter(i => i.feedId === id).map(i => i.link));
  const newItems = parsed.items
    .filter(item => item.link && !existingLinks.has(item.link))
    .slice(0, MAX_ITEMS_PER_FEED)
    .map(item => ({
      id: randomUUID(),
      feedId: id,
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
    .filter(i => i.feedId === id)
    .sort((a, b) => new Date(b.fetchedAt) - new Date(a.fetchedAt));
  if (feedItems.length > MAX_ITEMS_PER_FEED) {
    const keepIds = new Set(feedItems.slice(0, MAX_ITEMS_PER_FEED).map(i => i.id));
    data.items = data.items.filter(i => i.feedId !== id || keepIds.has(i.id));
  }

  feed.lastFetched = new Date().toISOString();
  feed.itemCount = data.items.filter(i => i.feedId === id).length;
  if (parsed.title) feed.title = parsed.title;

  await store.save(data);
  console.log(`🔄 Feed refreshed: ${feed.title} (+${newItems.length} new)`);

  return { feed: { ...feed, unreadCount: data.items.filter(i => i.feedId === id && !i.read).length }, newCount: newItems.length };
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

export async function refreshAllFeeds() {
  const data = await store.load();
  const CONCURRENCY = 5;
  let totalNew = 0;
  let totalFailed = 0;

  // Fetch in parallel batches; mutations are applied serially to avoid concurrent store.save() races
  for (let i = 0; i < data.feeds.length; i += CONCURRENCY) {
    const batch = data.feeds.slice(i, i + CONCURRENCY);
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
      const newCount = applyParsedFeed(data, feed, parsed);
      console.log(`🔄 Feed refreshed: ${feed.title || feed.id} (+${newCount} new)`);
      totalNew += newCount;
    }
  }

  await store.save(data);
  console.log(`📡 All feeds refreshed: +${totalNew} new items, ${totalFailed} failures`);
  return { refreshed: data.feeds.length, newItems: totalNew, failures: totalFailed };
}

export async function getItems({ feedId, unreadOnly, limit, offset = 0 } = {}) {
  const data = await store.load();
  let items = data.items;

  if (feedId) items = items.filter(i => i.feedId === feedId);
  if (unreadOnly) items = items.filter(i => !i.read);

  // Sort newest first by pubDate or fetchedAt
  items.sort((a, b) => {
    const da = new Date(a.pubDate || a.fetchedAt);
    const db = new Date(b.pubDate || b.fetchedAt);
    return db - da;
  });

  if (limit != null) return items.slice(offset, offset + limit);
  return items.slice(offset);
}

export async function markItemRead(itemId) {
  const data = await store.load();
  const item = data.items.find(i => i.id === itemId);
  if (!item) return { error: 'Item not found' };
  item.read = true;
  await store.save(data);
  return { updated: true };
}

export async function markAllRead(feedId) {
  const data = await store.load();
  let count = 0;
  for (const item of data.items) {
    if (feedId && item.feedId !== feedId) continue;
    if (!item.read) {
      item.read = true;
      count++;
    }
  }
  await store.save(data);
  console.log(`✅ Marked ${count} items as read${feedId ? ` for feed ${feedId}` : ''}`);
  return { marked: count };
}

export async function getFeedStats() {
  const data = await store.load();
  return {
    totalFeeds: data.feeds.length,
    totalItems: data.items.length,
    unreadItems: data.items.filter(i => !i.read).length
  };
}

// ─── Internal Helpers ───────────────────────────────────────────────────────

// Check if an IP address is private/loopback/link-local
function isPrivateIP(ip) {
  if (!ip) return true;
  // IPv6 loopback
  if (ip === '::1' || ip === '::') return true;
  // IPv4
  const parts = ip.split('.').map(Number);
  if (parts.length === 4 && parts.every(p => !isNaN(p) && p >= 0 && p <= 255)) {
    if (parts[0] === 10) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 127) return true;
    if (parts[0] === 0) return true;
  }
  return false;
}

// Resolve hostname and verify it doesn't point to a private IP
async function isHostSafe(hostname) {
  // Numeric IPs: check directly
  if (net.isIP(hostname)) return !isPrivateIP(hostname);
  // DNS resolution: check all resolved addresses
  const addresses = await dns.resolve4(hostname).catch(() => []);
  if (addresses.length === 0) return false;
  return addresses.every(addr => !isPrivateIP(addr));
}

async function fetchFeedXml(url) {
  // Restrict to http/https to prevent SSRF via file://, data://, etc.
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) return null;
  // Resolve DNS and block private/loopback/link-local IPs (prevents rebinding attacks)
  if (!await isHostSafe(parsed.hostname)) return null;

  const feedHeaders = { 'User-Agent': 'PortOS Feed Reader/1.0', Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' };

  const res = await fetchWithTimeout(url, {
    redirect: 'manual',
    headers: feedHeaders
  }, FETCH_TIMEOUT_MS).catch(() => null);

  // Handle redirects manually to validate each redirect target
  if (res?.status >= 300 && res?.status < 400) {
    const location = res.headers.get('location');
    if (!location) return null;
    const redirectUrl = new URL(location, url);
    if (!['http:', 'https:'].includes(redirectUrl.protocol)) return null;
    if (!await isHostSafe(redirectUrl.hostname)) return null;
    // Follow the validated redirect
    const res2 = await fetchWithTimeout(redirectUrl.href, {
      redirect: 'error',
      headers: feedHeaders
    }, FETCH_TIMEOUT_MS).catch(() => null);
    if (!res2?.ok) return null;
    return res2.text();
  }

  if (!res?.ok) return null;
  return res.text();
}
