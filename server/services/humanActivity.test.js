/**
 * Pure-logic tests for the human-activity timeline (#2150). No DB — these cover
 * the deterministic ingestion mappers, dedupe-key derivation, normalization, and
 * the histogram/summary aggregates. The Postgres round-trip (recordEvents /
 * listEvents / getDaySummary idempotency) is covered in humanActivity.db.test.js.
 */
import { describe, it, expect } from 'vitest';
import {
  shortSummary,
  localDayKey,
  localDayRangeUtc,
  normalizeParticipant,
  normalizeParticipants,
  normalizeCandidate,
  hourlyHistogram,
  summarizeCounts,
  messageActivityCandidates,
  calendarActivityCandidates,
} from './humanActivity.js';

describe('shortSummary', () => {
  it('collapses whitespace to a single line', () => {
    expect(shortSummary('hello   world\n\tfoo')).toBe('hello world foo');
  });
  it('clamps to max with an ellipsis and never returns the full body', () => {
    const body = 'x'.repeat(500);
    const out = shortSummary(body, 160);
    expect(out.length).toBeLessThanOrEqual(160);
    expect(out.endsWith('…')).toBe(true);
  });
  it('returns empty for falsy input', () => {
    expect(shortSummary('')).toBe('');
    expect(shortSummary(null)).toBe('');
  });
});

describe('localDayKey / localDayRangeUtc', () => {
  it('derives the local day key in a given timezone', () => {
    // 2026-07-04T02:00:00Z is still 2026-07-03 in America/Los_Angeles (-07:00).
    expect(localDayKey('2026-07-04T02:00:00Z', 'America/Los_Angeles')).toBe('2026-07-03');
    // …and the same instant is already 2026-07-04 in UTC.
    expect(localDayKey('2026-07-04T02:00:00Z', 'UTC')).toBe('2026-07-04');
  });
  it('returns a 24h UTC window bounding the local day', () => {
    const range = localDayRangeUtc('2026-07-04', 'America/Los_Angeles');
    expect(range).toBeTruthy();
    // Local midnight PDT (-07:00) → 07:00Z.
    expect(range.start.toISOString()).toBe('2026-07-04T07:00:00.000Z');
    expect(range.end.getTime() - range.start.getTime()).toBe(24 * 60 * 60 * 1000);
  });
  it('rejects a malformed date string', () => {
    expect(localDayRangeUtc('not-a-date', 'UTC')).toBeNull();
    expect(localDayKey('not-a-date', 'UTC')).toBeNull();
  });
});

describe('participant normalization', () => {
  it('lowercases email, trims, drops empties', () => {
    expect(normalizeParticipant('  Foo@Bar.COM ')).toEqual({ email: 'foo@bar.com' });
    expect(normalizeParticipant({ name: ' Jane ', email: 'J@X.io', phone: ' +1 555 ' }))
      .toEqual({ name: 'Jane', email: 'j@x.io', phone: '+1 555' });
    expect(normalizeParticipant({})).toBeNull();
    expect(normalizeParticipant(null)).toBeNull();
  });
  it('normalizes and filters a list', () => {
    expect(normalizeParticipants(['a@b.com', {}, null, { name: 'X' }])).toEqual([
      { email: 'a@b.com' }, { name: 'X' },
    ]);
    expect(normalizeParticipants('nope')).toEqual([]);
  });
});

describe('normalizeCandidate', () => {
  const base = {
    source: 'gmail', kind: 'message.received', happenedAt: '2026-07-04T12:00:00Z',
    dedupeKey: 'msg:acct:ext1', title: 'Hi', summary: 'body preview',
  };
  it('produces a DB row shape with a generated id when none supplied', () => {
    const row = normalizeCandidate(base);
    expect(row.id).toBeTruthy();
    expect(row.source).toBe('gmail');
    expect(row.kind).toBe('message.received');
    expect(row.happenedAt).toBe('2026-07-04T12:00:00.000Z');
    expect(row.participants).toEqual([]);
    expect(row.metadata).toEqual({});
    expect(row.durationS).toBeNull();
  });
  it('preserves a supplied id and coerces duration to an int', () => {
    const row = normalizeCandidate({ ...base, id: 'fixed-id', durationS: 90.7 });
    expect(row.id).toBe('fixed-id');
    expect(row.durationS).toBe(91);
  });
  it('returns null when a required field is missing or the date is invalid', () => {
    expect(normalizeCandidate({ ...base, source: '' })).toBeNull();
    expect(normalizeCandidate({ ...base, kind: '' })).toBeNull();
    expect(normalizeCandidate({ ...base, dedupeKey: '' })).toBeNull();
    expect(normalizeCandidate({ ...base, happenedAt: 'garbage' })).toBeNull();
    expect(normalizeCandidate(null)).toBeNull();
  });
  it('accepts snake_case aliases from callers', () => {
    const row = normalizeCandidate({
      source: 'calendar', kind: 'calendar.event', happened_at: '2026-07-04T12:00:00Z',
      dedupe_key: 'cal:a:1', account_id: 'acct-9', duration_s: 3600,
    });
    expect(row.accountId).toBe('acct-9');
    expect(row.durationS).toBe(3600);
  });
});

describe('hourlyHistogram / summarizeCounts', () => {
  const events = [
    { happenedAt: '2026-07-04T14:05:00Z', source: 'gmail', kind: 'message.received' },
    { happenedAt: '2026-07-04T14:40:00Z', source: 'gmail', kind: 'message.sent' },
    { happenedAt: '2026-07-04T22:00:00Z', source: 'calendar', kind: 'calendar.event' },
  ];
  it('buckets events into 24 local-hour slots', () => {
    const hist = hourlyHistogram(events, 'UTC');
    expect(hist).toHaveLength(24);
    expect(hist[14].count).toBe(2);
    expect(hist[22].count).toBe(1);
    expect(hist[0].count).toBe(0);
  });
  it('tallies by source and kind', () => {
    const counts = summarizeCounts(events);
    expect(counts.total).toBe(3);
    expect(counts.bySource).toEqual({ gmail: 2, calendar: 1 });
    expect(counts.byKind).toEqual({ 'message.received': 1, 'message.sent': 1, 'calendar.event': 1 });
  });
});

describe('messageActivityCandidates', () => {
  const account = { id: 'acct-1', type: 'gmail', email: 'me@example.com' };
  it('marks sent vs received by comparing the sender to the account owner', () => {
    const [received, sent] = messageActivityCandidates(account, [
      { externalId: 'e1', date: '2026-07-04T10:00:00Z', from: 'friend@x.io', to: ['me@example.com'], subject: 'Hey' },
      { externalId: 'e2', date: '2026-07-04T11:00:00Z', from: { email: 'ME@example.com' }, to: ['friend@x.io'], subject: 'Re: Hey' },
    ]);
    expect(received.kind).toBe('message.received');
    expect(sent.kind).toBe('message.sent');
  });
  it('excludes the account owner from participants and builds a stable dedupe key', () => {
    const [c] = messageActivityCandidates(account, [
      { externalId: 'e1', date: '2026-07-04T10:00:00Z', from: 'friend@x.io', to: ['me@example.com', 'other@x.io'], subject: 'Hey', bodyText: 'the full body\nwith newlines' },
    ]);
    const emails = c.participants.map((p) => p.email);
    expect(emails).toContain('friend@x.io');
    expect(emails).toContain('other@x.io');
    expect(emails).not.toContain('me@example.com');
    expect(c.dedupeKey).toBe('msg:acct-1:e1');
    expect(c.metadata.externalId).toBe('e1');
    // Privacy: summary is a collapsed preview, not the raw multi-line body.
    expect(c.summary).toBe('the full body with newlines');
  });
  it('skips messages without a date or external id', () => {
    expect(messageActivityCandidates(account, [{ subject: 'no date' }])).toEqual([]);
    expect(messageActivityCandidates(account, [{ date: '2026-07-04T10:00:00Z' }])).toEqual([]);
  });
});

describe('calendarActivityCandidates', () => {
  const account = { id: 'cal-1', type: 'google-calendar' };
  const now = new Date('2026-07-04T23:00:00Z').getTime();
  it('records finished, non-declined events with a duration', () => {
    const [c] = calendarActivityCandidates(account, [
      {
        externalId: 'ev1', title: 'Standup', location: 'Zoom',
        startTime: '2026-07-04T09:00:00Z', endTime: '2026-07-04T09:30:00Z',
        organizer: 'boss@x.io', attendees: ['me@example.com'],
      },
    ], now);
    expect(c.source).toBe('calendar');
    expect(c.kind).toBe('calendar.event');
    expect(c.durationS).toBe(1800);
    expect(c.dedupeKey).toBe('cal:cal-1:ev1');
    expect(c.title).toBe('Standup');
  });
  it('skips cancelled, declined, and not-yet-finished events', () => {
    expect(calendarActivityCandidates(account, [{ externalId: 'a', startTime: '2026-07-04T08:00:00Z', endTime: '2026-07-04T08:30:00Z', isCancelled: true }], now)).toEqual([]);
    expect(calendarActivityCandidates(account, [{ externalId: 'b', startTime: '2026-07-04T08:00:00Z', endTime: '2026-07-04T08:30:00Z', myStatus: 'declined' }], now)).toEqual([]);
    // ends in the future relative to `now`
    expect(calendarActivityCandidates(account, [{ externalId: 'c', startTime: '2026-07-05T08:00:00Z', endTime: '2026-07-05T08:30:00Z' }], now)).toEqual([]);
  });
});
