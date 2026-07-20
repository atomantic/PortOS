import { describe, it, expect } from 'vitest';

import {
  inboxQuery,
  sentQuery,
  gmailSyncPasses,
  collectMessageIds,
  SENT_INGEST_DAYS,
  SENT_INGEST_MAX,
} from './messageGmailSync.js';
import { DEFAULT_WITHIN_DAYS } from './tribeOutreach.js';

// The Gmail sync's search-query core (#2796). Inbox and sent are fetched as
// SEPARATE list passes so a heavy sender's sent mail can't crowd unread inbox out
// of a shared cap.
describe('inboxQuery / sentQuery', () => {
  it('scopes the inbox pass to unread only in unread mode', () => {
    expect(inboxQuery('unread')).toBe('is:unread in:inbox');
    expect(inboxQuery('full')).toBe('in:inbox');
  });

  it('bounds the sent pass by date to the detection window', () => {
    expect(sentQuery()).toBe(`in:sent newer_than:${SENT_INGEST_DAYS}d`);
    expect(SENT_INGEST_DAYS).toBe(14);
  });
});

describe('gmailSyncPasses', () => {
  it('is inbox-only (own cap) when ingestSent is off', () => {
    expect(gmailSyncPasses('unread', false, 100)).toEqual([
      { query: 'is:unread in:inbox', cap: 100 },
    ]);
    expect(gmailSyncPasses('full', false, 200)).toEqual([
      { query: 'in:inbox', cap: 200 },
    ]);
  });

  it('adds a separate sent pass with its OWN budget when ingestSent is on', () => {
    expect(gmailSyncPasses('unread', true, 100)).toEqual([
      { query: 'is:unread in:inbox', cap: 100 },
      { query: `in:sent newer_than:${SENT_INGEST_DAYS}d`, cap: SENT_INGEST_MAX },
    ]);
    // The inbox cap is untouched — sent mail never eats into it.
    expect(gmailSyncPasses('full', true, 200)[0]).toEqual({ query: 'in:inbox', cap: 200 });
  });
});

// Constant-coupling guard: the sent-fetch window must cover the outreach detection
// window, or a reply inside the window would be missed and its inbound would
// falsely read as unanswered.
describe('sent-ingest window covers the outreach detection window', () => {
  it('SENT_INGEST_DAYS >= DEFAULT_WITHIN_DAYS', () => {
    expect(SENT_INGEST_DAYS).toBeGreaterThanOrEqual(DEFAULT_WITHIN_DAYS);
  });
});

// #2820: the sent pass must paginate the ENTIRE window (up to the generous ceiling),
// not stop at the first page — a heavy sender's reply beyond page 1 would otherwise
// go un-ingested and its inbound would falsely read as unanswered.
describe('collectMessageIds — full pagination', () => {
  // Build a paginating fake Gmail list: `total` ids in pages of 100, keyed by query
  // so distinct passes don't collide.
  const pagingListFn = (countByQuery) => {
    const cursors = new Map();
    return async ({ q, maxResults, pageToken }) => {
      const total = countByQuery[q] ?? 0;
      const start = pageToken ? Number(pageToken) : 0;
      const end = Math.min(start + maxResults, total);
      const messages = [];
      for (let i = start; i < end; i++) messages.push({ id: `${q}#${i}`, threadId: `t-${i}` });
      const next = end < total ? String(end) : null;
      cursors.set(q, end);
      return { messages, nextPageToken: next };
    };
  };

  it('walks past the first 100 sent results up to the pass cap', async () => {
    // 250 sent messages — a reply at index 200 lives well beyond the first page.
    const sentQ = sentQuery();
    const passes = [{ query: sentQ, cap: SENT_INGEST_MAX }];
    const ids = await collectMessageIds(passes, pagingListFn({ [sentQ]: 250 }));
    expect(ids).toHaveLength(250);
    expect(ids.some((m) => m.id === `${sentQ}#200`)).toBe(true); // the far reply is fetched
  });

  it('stops at the pass cap when the window exceeds the ceiling (bounded fail-safe)', async () => {
    const sentQ = sentQuery();
    const passes = [{ query: sentQ, cap: SENT_INGEST_MAX }];
    const ids = await collectMessageIds(passes, pagingListFn({ [sentQ]: SENT_INGEST_MAX + 500 }));
    expect(ids.length).toBeLessThanOrEqual(SENT_INGEST_MAX);
    expect(ids.length).toBeGreaterThanOrEqual(SENT_INGEST_MAX); // fills exactly to the ceiling
  });

  it('dedupes an id that appears in both the inbox and sent passes', async () => {
    // Same query id space would collide; simulate cross-pass overlap by hand.
    let call = 0;
    const listFn = async () => {
      call += 1;
      if (call === 1) return { messages: [{ id: 'a' }, { id: 'b' }], nextPageToken: null };
      return { messages: [{ id: 'b' }, { id: 'c' }], nextPageToken: null };
    };
    const ids = await collectMessageIds([{ query: 'in:inbox', cap: 100 }, { query: 'in:sent', cap: 100 }], listFn);
    expect(ids.map((m) => m.id)).toEqual(['a', 'b', 'c']);
  });

  it('SENT_INGEST_MAX is a generous ceiling well past the old first-page limit of 100', () => {
    expect(SENT_INGEST_MAX).toBeGreaterThanOrEqual(1000);
  });
});
