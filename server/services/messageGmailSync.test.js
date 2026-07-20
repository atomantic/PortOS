import { describe, it, expect } from 'vitest';

import { buildGmailQuery, SENT_INGEST_DAYS } from './messageGmailSync.js';

// buildGmailQuery is the pure search-query core (#2796). Inbox is always scoped;
// sent mail is folded in only when the account opts into reply-detection ingestion,
// bounded to the outreach detection window so a big sent folder can't crowd out
// inbox results.
describe('buildGmailQuery', () => {
  it('inbox-only when ingestSent is off', () => {
    expect(buildGmailQuery('unread', false)).toBe('is:unread in:inbox');
    expect(buildGmailQuery('full', false)).toBe('in:inbox');
  });

  it('folds recent sent mail in when ingestSent is on, keeping the unread scope on inbox only', () => {
    expect(buildGmailQuery('unread', true)).toBe(`(is:unread in:inbox) OR (in:sent newer_than:${SENT_INGEST_DAYS}d)`);
    expect(buildGmailQuery('full', true)).toBe(`(in:inbox) OR (in:sent newer_than:${SENT_INGEST_DAYS}d)`);
  });

  it('bounds the sent fetch to the 14-day outreach detection window', () => {
    expect(SENT_INGEST_DAYS).toBe(14);
    expect(buildGmailQuery('full', true)).toContain('newer_than:14d');
  });
});
