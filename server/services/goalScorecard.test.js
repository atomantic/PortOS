import { describe, it, expect } from 'vitest';
import {
  shiftIsoDate,
  isoWeekStart,
  weekRangeUtc,
  goalKeywords,
  buildMappingRules,
  eventGoalMatches,
  eventSeconds,
  bucketEventsByWeek,
  weekTotals,
  computeScorecard,
  formatScorecardDigestLine,
  NOMINAL_SECONDS,
  TREND_WEEKS,
} from './goalScorecard.js';

const UTC = 'UTC';

const ev = (over = {}) => ({
  kind: over.kind ?? 'message.sent',
  title: over.title ?? null,
  summary: over.summary ?? null,
  durationS: over.durationS ?? null,
  participants: over.participants ?? [],
  metadata: over.metadata ?? {},
  happenedAt: over.happenedAt ?? '2026-07-06T12:00:00.000Z',
  ...over,
});

describe('shiftIsoDate', () => {
  it('shifts forward and back across month/year boundaries', () => {
    expect(shiftIsoDate('2026-07-06', 7)).toBe('2026-07-13');
    expect(shiftIsoDate('2026-07-06', -7)).toBe('2026-06-29');
    expect(shiftIsoDate('2026-12-31', 1)).toBe('2027-01-01');
    expect(shiftIsoDate('2026-03-01', -1)).toBe('2026-02-28');
  });
});

describe('isoWeekStart (week bucketing)', () => {
  it('maps every day of a week to its Monday (default)', () => {
    // 2026-07-06 is a Monday. Mon..Sun all resolve to 2026-07-06.
    for (let i = 0; i < 7; i += 1) {
      expect(isoWeekStart(shiftIsoDate('2026-07-06', i))).toBe('2026-07-06');
    }
    // The next day (Mon 2026-07-13) starts a new bucket.
    expect(isoWeekStart('2026-07-13')).toBe('2026-07-13');
  });

  it('honors a Sunday week start (weekStartsOn=7)', () => {
    // 2026-07-05 is a Sunday. With Sunday-start, Sun..Sat resolve to 2026-07-05.
    expect(isoWeekStart('2026-07-05', 7)).toBe('2026-07-05');
    expect(isoWeekStart('2026-07-06', 7)).toBe('2026-07-05'); // Monday still in that week
    expect(isoWeekStart('2026-07-11', 7)).toBe('2026-07-05'); // Saturday
    expect(isoWeekStart('2026-07-12', 7)).toBe('2026-07-12'); // next Sunday
  });

  it('returns null for a non-ISO date', () => {
    expect(isoWeekStart('not-a-date')).toBeNull();
    expect(isoWeekStart(null)).toBeNull();
  });
});

describe('weekRangeUtc', () => {
  it('spans exactly 7 days in UTC', () => {
    const range = weekRangeUtc('2026-07-06', UTC);
    expect(range.start.toISOString()).toBe('2026-07-06T00:00:00.000Z');
    expect(range.end.toISOString()).toBe('2026-07-13T00:00:00.000Z');
    expect((range.end - range.start) / (24 * 3600 * 1000)).toBe(7);
  });
});

describe('goalKeywords', () => {
  it('drops stopwords and short tokens, keeps meaningful title words', () => {
    expect(goalKeywords({ title: 'Buy Estate Property' })).toEqual(
      expect.arrayContaining(['estate', 'property']),
    );
    // "Buy" is a stopword; nothing shorter than 4 chars survives.
    expect(goalKeywords({ title: 'Buy Estate Property' })).not.toContain('buy');
  });

  it('includes tags and category verbatim (lowercased)', () => {
    const kw = goalKeywords({ title: 'Musical Fluency', tags: ['Piano', 'practice'], category: 'creative' });
    expect(kw).toEqual(expect.arrayContaining(['musical', 'fluency', 'piano', 'practice', 'creative']));
  });

  it('de-duplicates overlap between title/tags/category', () => {
    const kw = goalKeywords({ title: 'Creative Legacy', tags: ['legacy'], category: 'creative' });
    expect(kw.filter((k) => k === 'legacy')).toHaveLength(1);
    expect(kw.filter((k) => k === 'creative')).toHaveLength(1);
  });
});

describe('buildMappingRules', () => {
  const goals = [
    { id: 'g1', title: 'Musical Fluency', category: 'creative', status: 'active' },
    { id: 'g2', title: 'Buy Humanoid Robot', category: 'financial', status: 'active', linkedCalendars: [{ subcalendarId: 'cal-x', matchPattern: null }] },
    { id: 'g3', title: 'Archived goal', category: 'health', status: 'archived' },
  ];

  it('builds one rule per active goal, skipping non-active', () => {
    const rules = buildMappingRules(goals);
    expect(rules.map((r) => r.id)).toEqual(['g1', 'g2']);
  });

  it('carries linkedCalendars ({subcalendarId, matchPattern}) into subcalendars', () => {
    const rules = buildMappingRules(goals);
    expect(rules.find((r) => r.id === 'g2').subcalendars).toEqual([{ subcalendarId: 'cal-x', matchPattern: null }]);
  });

  it('folds linkedActivities activityName values into keywords (not personIds)', () => {
    const rules = buildMappingRules([
      { id: 'gp', title: 'Piano', category: 'creative', status: 'active', linkedActivities: [{ activityName: 'Scales Drill', requiredFrequency: 3 }] },
    ]);
    expect(rules[0].keywords).toContain('scales drill');
    expect(rules[0].personIds).toEqual([]);
  });

  it('merges override keywords and can disable a goal', () => {
    const rules = buildMappingRules(goals, {
      g1: { keywords: ['guitar', 'GUITAR'] },
      g2: { enabled: false },
    });
    expect(rules.map((r) => r.id)).toEqual(['g1']);
    expect(rules[0].keywords).toContain('guitar');
    // de-duped case-insensitively
    expect(rules[0].keywords.filter((k) => k === 'guitar')).toHaveLength(1);
  });

  it('override personIds add participants; override subcalendarIds replace linked calendars', () => {
    const rules = buildMappingRules(goals, { g2: { personIds: ['p9'], subcalendarIds: ['cal-y'] } });
    const r = rules.find((x) => x.id === 'g2');
    expect(r.personIds).toEqual(['p9']);
    expect(r.subcalendars).toEqual([{ subcalendarId: 'cal-y', matchPattern: null }]);
  });
});

describe('eventGoalMatches', () => {
  const rules = buildMappingRules([
    { id: 'music', title: 'Musical Fluency', category: 'creative', status: 'active' },
    { id: 'robot', title: 'Buy Humanoid Robot', category: 'financial', status: 'active', linkedCalendars: [{ subcalendarId: 'cal-robot', matchPattern: null }] },
  ], { robot: { personIds: ['p-bob'] } });

  it('matches by keyword in title/summary/participant name', () => {
    expect(eventGoalMatches(ev({ title: 'piano and musical practice' }), rules)).toEqual(['music']);
    expect(eventGoalMatches(ev({ summary: 'ordered a humanoid arm' }), rules)).toEqual(['robot']);
    expect(eventGoalMatches(ev({ participants: [{ name: 'Robot Lab' }] }), rules)).toEqual(['robot']);
  });

  it('matches by override-linked personId', () => {
    expect(eventGoalMatches(ev({ participants: [{ personId: 'p-bob' }] }), rules)).toEqual(['robot']);
  });

  it('matches by linked calendar subcalendarId', () => {
    expect(eventGoalMatches(ev({ kind: 'calendar.event', metadata: { subcalendarId: 'cal-robot' } }), rules)).toEqual(['robot']);
  });

  it('honors a calendar matchPattern (title must contain it)', () => {
    const patternRules = buildMappingRules([
      { id: 'gym', title: 'Fitness', category: 'health', status: 'active', linkedCalendars: [{ subcalendarId: 'cal-health', matchPattern: 'workout' }] },
    ]);
    expect(eventGoalMatches(ev({ kind: 'calendar.event', title: 'morning workout', metadata: { subcalendarId: 'cal-health' } }), patternRules)).toEqual(['gym']);
    // Same calendar, title without the pattern → no match.
    expect(eventGoalMatches(ev({ kind: 'calendar.event', title: 'dentist appt', metadata: { subcalendarId: 'cal-health' } }), patternRules)).toEqual([]);
  });

  it('returns empty for an unaligned event', () => {
    expect(eventGoalMatches(ev({ title: 'random chatter' }), rules)).toEqual([]);
  });

  it('matches single-token keywords on whole words, not substrings', () => {
    // A short tag "art" must NOT match "start"/"artisan" via substring.
    const artRules = buildMappingRules([
      { id: 'art', title: 'Studio', category: 'creative', status: 'active', tags: ['art'] },
    ]);
    expect(eventGoalMatches(ev({ title: 'start the artisan run' }), artRules)).toEqual([]);
    expect(eventGoalMatches(ev({ title: 'made some art today' }), artRules)).toEqual(['art']);
  });

  it('still substring-matches multi-word phrase keywords', () => {
    const phraseRules = buildMappingRules([
      { id: 'pull', title: 'Fitness', category: 'health', status: 'active', tags: ['pull ups'] },
    ]);
    expect(eventGoalMatches(ev({ title: 'did pull ups at the gym' }), phraseRules)).toEqual(['pull']);
  });

  it('can match multiple goals at once (de-duplicated)', () => {
    const out = eventGoalMatches(ev({ title: 'musical robot jam', summary: 'humanoid' }), rules);
    expect(out.sort()).toEqual(['music', 'robot']);
  });
});

describe('eventSeconds', () => {
  it('uses the real duration when present', () => {
    expect(eventSeconds(ev({ kind: 'calendar.event', durationS: 3600 }))).toBe(3600);
  });

  it('falls back to the per-kind nominal when duration is absent/zero', () => {
    expect(eventSeconds(ev({ kind: 'message.sent' }))).toBe(NOMINAL_SECONDS['message.sent']);
    expect(eventSeconds(ev({ kind: 'calendar.event', durationS: 0 }))).toBe(NOMINAL_SECONDS['calendar.event']);
    expect(eventSeconds(ev({ kind: 'unknown.kind' }))).toBe(NOMINAL_SECONDS.default);
  });
});

describe('bucketEventsByWeek', () => {
  it('groups events into their local weeks and drops unparseable timestamps', () => {
    const events = [
      ev({ happenedAt: '2026-07-06T10:00:00Z' }), // Mon week A
      ev({ happenedAt: '2026-07-12T23:00:00Z' }), // Sun week A
      ev({ happenedAt: '2026-07-13T01:00:00Z' }), // Mon week B
      ev({ happenedAt: 'garbage' }),
    ];
    const buckets = bucketEventsByWeek(events, UTC);
    expect(buckets.get('2026-07-06')).toHaveLength(2);
    expect(buckets.get('2026-07-13')).toHaveLength(1);
    expect([...buckets.keys()].sort()).toEqual(['2026-07-06', '2026-07-13']);
  });
});

describe('weekTotals', () => {
  const rules = buildMappingRules([{ id: 'music', title: 'Musical Fluency', category: 'creative', status: 'active' }]);

  it('splits aligned vs unaligned seconds', () => {
    const events = [
      ev({ kind: 'calendar.event', durationS: 3600, title: 'musical practice' }), // aligned 3600
      ev({ kind: 'message.sent', title: 'lunch plans' }), // unaligned 120
    ];
    const t = weekTotals(events, rules);
    expect(t.alignedSeconds).toBe(3600);
    expect(t.unalignedSeconds).toBe(NOMINAL_SECONDS['message.sent']);
    expect(t.totalSeconds).toBe(3600 + NOMINAL_SECONDS['message.sent']);
    expect(t.eventCount).toBe(2);
  });
});

describe('computeScorecard (rollup math)', () => {
  const rules = buildMappingRules([
    { id: 'music', title: 'Musical Fluency', category: 'creative', status: 'active' },
    { id: 'fitness', title: 'Ten Pull Ups', category: 'health', status: 'active' },
  ]);

  it('aggregates per-goal hours, share, and distinct contacts', () => {
    const events = [
      ev({ kind: 'calendar.event', durationS: 3600, title: 'musical rehearsal', participants: [{ personId: 'p1' }, { name: 'Ana' }] }),
      ev({ kind: 'calendar.event', durationS: 1800, title: 'more musical time', participants: [{ personId: 'p1' }] }),
      ev({ kind: 'calendar.event', durationS: 1800, title: 'pull ups session' }),
      ev({ kind: 'message.sent', title: 'unrelated' }), // unaligned
    ];
    const sc = computeScorecard({ weekStart: '2026-07-06', events, rules, timezone: UTC });

    expect(sc.totals.alignedSeconds).toBe(3600 + 1800 + 1800);
    expect(sc.totals.unalignedSeconds).toBe(NOMINAL_SECONDS['message.sent']);
    expect(sc.totals.alignedHours).toBe(2); // 7200s

    const music = sc.goals.find((g) => g.id === 'music');
    expect(music.alignedSeconds).toBe(5400);
    expect(music.alignedHours).toBe(1.5);
    expect(music.eventCount).toBe(2);
    // p1 twice + Ana once = 2 distinct contacts
    expect(music.contactCount).toBe(2);

    // Goals sorted by aligned seconds desc: music (5400) before fitness (1800).
    expect(sc.goals[0].id).toBe('music');
    // Share is fraction of aligned time (5400 / 7200 = 0.75).
    expect(music.share).toBeCloseTo(0.75, 3);
  });

  it('counts an event under every goal it maps to (overlap allowed)', () => {
    const events = [ev({ kind: 'calendar.event', durationS: 3600, title: 'musical pull ups mashup' })];
    const sc = computeScorecard({ weekStart: '2026-07-06', events, rules, timezone: UTC });
    expect(sc.goals.find((g) => g.id === 'music').alignedSeconds).toBe(3600);
    expect(sc.goals.find((g) => g.id === 'fitness').alignedSeconds).toBe(3600);
    // Aligned total counts the event once, not double.
    expect(sc.totals.alignedSeconds).toBe(3600);
  });

  it('reports trend direction from aligned share vs prior weeks', () => {
    const events = [ev({ kind: 'calendar.event', durationS: 3600, title: 'musical' })]; // 100% aligned this week
    const trend = [
      { weekStart: '2026-06-15', alignedSeconds: 10, unalignedSeconds: 90, totalSeconds: 100 }, // 10%
      { weekStart: '2026-06-22', alignedSeconds: 20, unalignedSeconds: 80, totalSeconds: 100 }, // 20%
      { weekStart: '2026-06-29', alignedSeconds: 30, unalignedSeconds: 70, totalSeconds: 100 }, // 30%
      { weekStart: '2026-07-06', alignedSeconds: 3600, unalignedSeconds: 0, totalSeconds: 3600 }, // current
    ];
    const sc = computeScorecard({ weekStart: '2026-07-06', events, rules, timezone: UTC, trend });
    expect(sc.trendDirection).toBe('up');
    expect(sc.trend).toHaveLength(4);
    expect(sc.trend[0].alignedShare).toBeCloseTo(0.1, 3);
  });

  it('is flat with no prior weeks and empty when there is no activity', () => {
    const empty = computeScorecard({ weekStart: '2026-07-06', events: [], rules, timezone: UTC });
    expect(empty.trendDirection).toBe('flat');
    expect(empty.totals.totalSeconds).toBe(0);
    expect(empty.totals.alignedShare).toBe(0);
    expect(empty.goals.every((g) => g.alignedSeconds === 0)).toBe(true);
  });

  it('reports flat (not down) for a zero-activity week even after active prior weeks', () => {
    const trend = [
      { weekStart: '2026-06-22', alignedSeconds: 50, unalignedSeconds: 50, totalSeconds: 100 }, // 50%
      { weekStart: '2026-06-29', alignedSeconds: 60, unalignedSeconds: 40, totalSeconds: 100 }, // 60%
      { weekStart: '2026-07-06', alignedSeconds: 0, unalignedSeconds: 0, totalSeconds: 0 },
    ];
    const sc = computeScorecard({ weekStart: '2026-07-06', events: [], rules, timezone: UTC, trend });
    expect(sc.trendDirection).toBe('flat');
  });
});

describe('formatScorecardDigestLine', () => {
  it('renders a one-line slice with the top goal', () => {
    const sc = {
      weekStart: '2026-07-06',
      totals: { alignedHours: 5, unalignedHours: 3, alignedShare: 0.625, totalSeconds: 28800 },
      goals: [{ title: 'Musical Fluency', alignedSeconds: 18000, alignedHours: 5 }],
    };
    const line = formatScorecardDigestLine(sc);
    expect(line).toContain('week of 2026-07-06');
    expect(line).toContain('5h aligned');
    expect(line).toContain('3h unaligned');
    expect(line).toContain('63% goal-aligned');
    expect(line).toContain('Musical Fluency');
  });

  it('returns null when there is no tracked time', () => {
    expect(formatScorecardDigestLine({ weekStart: '2026-07-06', totals: { totalSeconds: 0 }, goals: [] })).toBeNull();
    expect(formatScorecardDigestLine(null)).toBeNull();
  });
});

describe('constants', () => {
  it('exposes a sane trend window', () => {
    expect(TREND_WEEKS).toBeGreaterThanOrEqual(2);
  });
});
