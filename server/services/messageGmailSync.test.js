import { describe, it, expect } from 'vitest';

import {
  inboxQuery,
  sentQuery,
  gmailSyncPasses,
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
