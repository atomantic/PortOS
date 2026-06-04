// System voice tools: PM2 process status/restart and RSS feed digest/mark-read.
// Two intent groups live here (`system` for PM2, `feeds` for RSS) — they share
// the "ops / things running" mental model but gate on separate regexes.

import { listProcesses, restartApp } from '../../pm2.js';
import { getItems, getFeeds, markItemRead, markAllRead } from '../../feeds.js';
import { clampLimit } from './shared.js';

export const SYSTEM_INTENT_RE = /\b(restart|crash(?:ed)?|pm2|process|service|is.*(?:running|down|up)|status)\b/i;
// "mark.*read" / "mark.*unread" pairs feeds_mark_read with feeds_digest:
// after "what's in my feeds?" the user says "mark that one read" or "mark
// them all as read" — the bare word "read" alone is too broad (collides
// with "read my log"), so we require it follow "mark".
export const FEEDS_INTENT_RE = /\b(feeds?|news|unread|articles?|rss|digest|headlines?|mark\b[^.!?\n]{0,40}\bread)\b/i;

export const SYSTEM_TOOLS = [
  {
    name: 'pm2_status',
    description:
      'Report the status of PortOS PM2 processes. Use when the user asks "is anything crashed?", "is everything running?", "any errors?". Reports total, healthy, and any processes in errored/stopped states.',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      const procs = await listProcesses();
      const unhealthy = procs.filter((p) => p.status !== 'online');
      const online = procs.length - unhealthy.length;
      const parts = [`${online} of ${procs.length} processes online`];
      if (unhealthy.length) {
        parts.push(
          `issues: ${unhealthy.map((p) => `${p.name} (${p.status})`).join(', ')}`,
        );
      }
      return {
        ok: true,
        total: procs.length,
        online,
        unhealthy: unhealthy.map((p) => ({ name: p.name, status: p.status, restarts: p.restarts })),
        summary: parts.join('. ') + '.',
      };
    },
  },

  {
    name: 'pm2_restart',
    description:
      'Restart a PortOS PM2 process by name. Use when the user says "restart the whisper server", "restart portos-api", "bounce the cos runner". Only restart — never kill or delete.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'PM2 process name (or a distinctive substring).' },
      },
      required: ['name'],
    },
    execute: async ({ name }) => {
      if (typeof name !== 'string' || !name.trim()) throw new Error('name is required');
      const trimmed = name.trim();
      const lower = trimmed.toLowerCase();
      const procs = await listProcesses();
      const exact = procs.find((p) => p.name === trimmed);
      const match = exact
        || procs.find((p) => p.name?.toLowerCase() === lower)
        || procs.find((p) => p.name?.toLowerCase().includes(lower));
      if (!match) {
        return { ok: false, summary: `No PM2 process matched "${trimmed}".` };
      }
      await restartApp(match.name);
      return { ok: true, name: match.name, summary: `Restarted ${match.name}.` };
    },
  },

  {
    name: 'feeds_digest',
    description:
      'Summarize the user\'s unread RSS feed items. Use when the user asks "what\'s new in my feeds?", "any news?", "read me my headlines". Returns up to 5 of the newest unread items with title and feed name.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'Max items (default 5, max 10).' },
      },
    },
    execute: async ({ limit = 5 } = {}) => {
      const max = clampLimit(limit, 5, 10);
      const [items, feeds] = await Promise.all([getItems({ unreadOnly: true }), getFeeds()]);
      const feedName = (id) => feeds.find((f) => f.id === id)?.title || 'feed';
      const picks = items.slice(0, max).map((i) => ({
        title: i.title,
        feed: feedName(i.feedId),
        date: (i.pubDate || i.fetchedAt || '').slice(0, 10),
      }));
      return {
        ok: true,
        totalUnread: items.length,
        count: picks.length,
        items: picks,
        summary: picks.length
          ? `${items.length} unread. Top ${picks.length}: ${picks.map((p) => `"${p.title}" (${p.feed})`).join('; ')}.`
          : 'No unread feed items.',
      };
    },
  },

  {
    name: 'feeds_mark_read',
    description:
      'Mark RSS feed items as read. Use when the user says "mark that one read", "mark this read", "I read the second one", or "mark them all read". ' +
      'Pass `query` with a distinctive phrase from the item\'s title (the LLM should reuse a title it just spoke from feeds_digest). ' +
      'Pass `all: true` to mark every unread item read; combine with `feedQuery` to scope to a single feed (e.g. "mark all of Hacker News as read").',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Distinctive phrase from the article title to fuzzy-match against currently unread items.',
        },
        all: {
          type: 'boolean',
          description: 'Mark every unread item as read. When true, `query` is ignored.',
        },
        feedQuery: {
          type: 'string',
          description: 'Optional: when `all` is true, restrict to a single feed by fuzzy-matching its title.',
        },
      },
    },
    execute: async ({ query, all = false, feedQuery } = {}) => {
      if (!all && (typeof query !== 'string' || !query.trim())) {
        return { ok: false, summary: 'Tell me which item — say "mark all read" or quote a phrase from the title.' };
      }

      if (all) {
        let feedId;
        let feedTitle;
        if (feedQuery && typeof feedQuery === 'string' && feedQuery.trim()) {
          const feeds = await getFeeds();
          const fq = feedQuery.trim().toLowerCase();
          const feed = feeds.find((f) => (f.title || '').toLowerCase() === fq)
            || feeds.find((f) => (f.title || '').toLowerCase().includes(fq));
          if (!feed) {
            return { ok: false, summary: `No feed matched "${feedQuery}".` };
          }
          feedId = feed.id;
          feedTitle = feed.title;
        }
        const result = await markAllRead(feedId);
        const scope = feedTitle ? ` from ${feedTitle}` : '';
        return {
          ok: true,
          marked: result.marked,
          summary: result.marked
            ? `Marked ${result.marked} item${result.marked === 1 ? '' : 's'}${scope} as read.`
            : `Nothing unread${scope}.`,
        };
      }

      // Fuzzy-match a single item by title against currently unread.
      const q = query.trim().toLowerCase();
      const unread = await getItems({ unreadOnly: true, limit: 200 });
      const exact = unread.find((i) => (i.title || '').toLowerCase() === q);
      const match = exact
        || unread.find((i) => (i.title || '').toLowerCase().includes(q))
        || unread.find((i) => {
          const tokens = q.split(/\s+/).filter((t) => t.length >= 3);
          return tokens.length && tokens.every((t) => (i.title || '').toLowerCase().includes(t));
        });
      if (!match) {
        return { ok: false, summary: `No unread item matched "${query}".` };
      }
      const result = await markItemRead(match.id);
      if (result?.error) {
        return { ok: false, summary: `Couldn't mark "${match.title}" — ${result.error}.` };
      }
      return {
        ok: true,
        title: match.title,
        summary: `Marked "${match.title}" as read.`,
      };
    },
  },
];
