import { describe, it, expect } from 'vitest';
import {
  formatActivityDigest,
  computeCatchUpDates,
  shiftIso,
} from './activityDigest.js';

const ev = (kind, over = {}) => ({
  kind,
  title: over.title ?? null,
  summary: over.summary ?? null,
  participants: over.participants ?? [],
  ...over,
});

describe('formatActivityDigest (non-LLM formatter)', () => {
  it('returns null for a day with no tracked events', () => {
    expect(formatActivityDigest({ events: [] })).toBeNull();
    expect(formatActivityDigest({})).toBeNull();
    expect(formatActivityDigest(null)).toBeNull();
  });

  it('groups conversations with a sent/received tally and resolved names', () => {
    const summary = {
      events: [
        ev('message.sent', { participants: [{ name: 'Alice Smith' }] }),
        ev('message.received', { participants: [{ name: 'Alice Smith' }] }),
        ev('message.received', { participants: [{ email: 'bob@example.com' }] }),
      ],
    };
    const out = formatActivityDigest(summary);
    expect(out).toContain('**Conversations** — 3 messages (1 sent, 2 received)');
    expect(out).toContain('Alice Smith');
    expect(out).toContain('bob@example.com');
    // Names are de-duplicated (Alice appears in two events but once in the line).
    expect(out.match(/Alice Smith/g)).toHaveLength(1);
  });

  it('resolves a tribe personId to a name via nameByPersonId', () => {
    const summary = {
      events: [ev('message.sent', { participants: [{ personId: 'p1' }] })],
    };
    const out = formatActivityDigest(summary, { nameByPersonId: { p1: 'Carol Jones' } });
    expect(out).toContain('Carol Jones');
  });

  it('lists meetings with attendee names', () => {
    const summary = {
      events: [
        ev('calendar.event', { title: 'Standup', participants: [{ name: 'Alice' }, { name: 'Bob' }] }),
      ],
    };
    const out = formatActivityDigest(summary);
    expect(out).toContain('**Meetings** — 1');
    expect(out).toContain('- Standup (with Alice, Bob)');
  });

  it('lists media with a watch/listen verb and detail', () => {
    const summary = {
      events: [
        ev('media.watch', { title: 'Some Video' }),
        ev('media.listen', { title: 'A Song', summary: 'The Band' }),
      ],
    };
    const out = formatActivityDigest(summary);
    expect(out).toContain('**Media** — 2');
    expect(out).toContain('- Watched: Some Video');
    expect(out).toContain('- Listened: A Song — The Band');
  });

  it('counts uncategorized events under Other activity (never drops events)', () => {
    const summary = { events: [ev('mystery.kind'), ev('another.kind')] };
    const out = formatActivityDigest(summary);
    expect(out).toContain('**Other activity** — 2 events');
  });
});

describe('shiftIso', () => {
  it('shifts calendar days across month/year boundaries', () => {
    expect(shiftIso('2026-07-08', 1)).toBe('2026-07-09');
    expect(shiftIso('2026-07-08', -1)).toBe('2026-07-07');
    expect(shiftIso('2026-07-31', 1)).toBe('2026-08-01');
    expect(shiftIso('2026-01-01', -1)).toBe('2025-12-31');
  });
});

describe('computeCatchUpDates (catch-up window logic)', () => {
  const TODAY = '2026-07-08';

  it('drafts only today when the last run was yesterday', () => {
    const dates = computeCatchUpDates({ lastRunDate: '2026-07-07', catchUpDays: 3 }, TODAY);
    expect(dates).toEqual([TODAY]);
  });

  it('returns nothing when already drafted today', () => {
    expect(computeCatchUpDates({ lastRunDate: TODAY, catchUpDays: 3 }, TODAY)).toEqual([]);
  });

  it('backfills the gap since the last run, capped by catchUpDays', () => {
    // last run 10 days ago, window of 3 → today-3 … today (4 days).
    const dates = computeCatchUpDates({ lastRunDate: '2026-06-28', catchUpDays: 3 }, TODAY);
    expect(dates).toEqual(['2026-07-05', '2026-07-06', '2026-07-07', '2026-07-08']);
  });

  it('backfills only up to the last-run day when the gap is inside the window', () => {
    const dates = computeCatchUpDates({ lastRunDate: '2026-07-06', catchUpDays: 5 }, TODAY);
    expect(dates).toEqual(['2026-07-07', '2026-07-08']);
  });

  it('first run (never drafted) backfills the full catch-up window plus today', () => {
    expect(computeCatchUpDates({ lastRunDate: null, catchUpDays: 2 }, TODAY)).toEqual([
      '2026-07-06', '2026-07-07', '2026-07-08',
    ]);
  });

  it('first run with catchUpDays 0 drafts today only', () => {
    expect(computeCatchUpDates({ lastRunDate: null, catchUpDays: 0 }, TODAY)).toEqual([TODAY]);
  });

  it('ignores a future lastRunDate (clock skew) without over-drafting', () => {
    expect(computeCatchUpDates({ lastRunDate: '2026-07-20', catchUpDays: 3 }, TODAY)).toEqual([]);
  });

  it('returns [] for an invalid today', () => {
    expect(computeCatchUpDates({ lastRunDate: null, catchUpDays: 3 }, 'nonsense')).toEqual([]);
  });
});
