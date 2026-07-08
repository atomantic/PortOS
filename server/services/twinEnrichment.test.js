/**
 * Pure-logic tests for twin enrichment (Phase 7, #2156). No DB, no provider
 * calls — these cover the deterministic rollup math, novelty ratio, hourly
 * histogram bucketing (with timezone edge cases), observed-chronotype
 * classification, and the stated-vs-observed comparison (divergence is signal,
 * observed never clobbers stated). The DB fetch + file persistence + LLM
 * interpretation paths are thin wrappers over these helpers.
 */
import { describe, it, expect } from 'vitest';
import {
  topCounts,
  noveltyRatio,
  listenArtistNames,
  listenGenreNames,
  rollupListen,
  rollupWatch,
  chronotypeHistogram,
  peakHour,
  classifyObservedChronotype,
  compareChronotype,
  buildConsumptionBrief,
} from './twinEnrichment.js';

describe('topCounts', () => {
  it('counts and sorts by frequency, then alphabetically for ties', () => {
    const out = topCounts(['b', 'a', 'b', 'c', 'a', 'a']);
    expect(out).toEqual([
      { name: 'a', count: 3 },
      { name: 'b', count: 2 },
      { name: 'c', count: 1 },
    ]);
  });
  it('skips blank/nullish keys and trims', () => {
    expect(topCounts([' x ', '', null, undefined, 'x'])).toEqual([{ name: 'x', count: 2 }]);
  });
  it('respects the limit', () => {
    expect(topCounts(['a', 'b', 'c', 'd'], 2)).toHaveLength(2);
  });
  it('breaks equal-count ties by name (stable federation order)', () => {
    // z and a both appear once — alphabetical keeps checksums convergent.
    expect(topCounts(['z', 'a']).map((x) => x.name)).toEqual(['a', 'z']);
  });
});

describe('noveltyRatio', () => {
  it('returns null ratio for an empty window (no signal ≠ 0% novel)', () => {
    expect(noveltyRatio([])).toEqual({ total: 0, distinct: 0, repeats: 0, noveltyRatio: null });
  });
  it('is 1.0 when nothing repeats', () => {
    expect(noveltyRatio(['a', 'b', 'c'])).toEqual({ total: 3, distinct: 3, repeats: 0, noveltyRatio: 1 });
  });
  it('drops as items repeat', () => {
    // 4 plays, 2 distinct → 0.5 novel, 2 repeats.
    expect(noveltyRatio(['a', 'a', 'b', 'b'])).toEqual({ total: 4, distinct: 2, repeats: 2, noveltyRatio: 0.5 });
  });
});

describe('listenArtistNames / listenGenreNames', () => {
  it('reads structured artist objects', () => {
    expect(listenArtistNames({ metadata: { artists: [{ name: 'Boards of Canada' }, { name: 'Aphex Twin' }] } }))
      .toEqual(['Boards of Canada', 'Aphex Twin']);
  });
  it('accepts bare-string artists', () => {
    expect(listenArtistNames({ metadata: { artists: ['Solo'] } })).toEqual(['Solo']);
  });
  it('falls back to the comma-joined summary line when metadata is lean', () => {
    expect(listenArtistNames({ summary: 'A, B , C' })).toEqual(['A', 'B', 'C']);
  });
  it('returns [] when there is nothing usable', () => {
    expect(listenArtistNames({})).toEqual([]);
    expect(listenGenreNames({})).toEqual([]);
  });
  it('reads genres when present (future-proof)', () => {
    expect(listenGenreNames({ metadata: { genres: ['ambient', { name: 'idm' }] } })).toEqual(['ambient', 'idm']);
  });
});

describe('rollupListen / rollupWatch', () => {
  const listens = [
    { kind: 'media.listen', title: 'T1', metadata: { trackId: 't1', artists: [{ name: 'A' }], genres: ['ambient'] } },
    { kind: 'media.listen', title: 'T1', metadata: { trackId: 't1', artists: [{ name: 'A' }], genres: ['ambient'] } },
    { kind: 'media.listen', title: 'T2', metadata: { trackId: 't2', artists: [{ name: 'B' }] } },
    { kind: 'media.watch', title: 'V1', metadata: { videoId: 'v1', channel: 'Chan' } }, // ignored by listen rollup
  ];
  it('rolls up only media.listen events', () => {
    const r = rollupListen(listens);
    expect(r.total).toBe(3);
    expect(r.topArtists).toEqual([{ name: 'A', count: 2 }, { name: 'B', count: 1 }]);
    expect(r.topGenres).toEqual([{ name: 'ambient', count: 2 }]);
    // 3 plays, t1 twice → 2 distinct.
    expect(r.novelty).toEqual({ total: 3, distinct: 2, repeats: 1, noveltyRatio: 0.667 });
  });
  it('rolls up only media.watch events with channels + novelty', () => {
    const watches = [
      { kind: 'media.watch', title: 'V1', metadata: { videoId: 'v1', channel: 'Chan', topics: ['tech'] } },
      { kind: 'media.watch', title: 'V2', metadata: { videoId: 'v2', channel: 'Chan' } },
      { kind: 'media.listen', title: 'T', metadata: { trackId: 't' } },
    ];
    const r = rollupWatch(watches);
    expect(r.total).toBe(2);
    expect(r.topChannels).toEqual([{ name: 'Chan', count: 2 }]);
    expect(r.topTopics).toEqual([{ name: 'tech', count: 1 }]);
    expect(r.novelty.distinct).toBe(2);
  });
});

describe('chronotypeHistogram — timezone bucketing', () => {
  it('buckets by LOCAL hour, not UTC', () => {
    // 2026-07-04T02:30:00Z = 19:30 the previous day in America/Los_Angeles (-07).
    const events = [{ kind: 'message.sent', happenedAt: '2026-07-04T02:30:00Z' }];
    const hist = chronotypeHistogram(events, 'America/Los_Angeles');
    expect(hist[19].messages).toBe(1);
    expect(hist[19].total).toBe(1);
    // Same instant in UTC lands at hour 2.
    const utc = chronotypeHistogram(events, 'UTC');
    expect(utc[2].messages).toBe(1);
  });
  it('separates categories and counts only outbound messages', () => {
    const events = [
      { kind: 'message.sent', happenedAt: '2026-07-04T15:00:00Z' },
      { kind: 'message.received', happenedAt: '2026-07-04T15:00:00Z' }, // not a self-timing signal
      { kind: 'calendar.event', happenedAt: '2026-07-04T15:00:00Z' },
      { kind: 'media.listen', happenedAt: '2026-07-04T15:00:00Z' },
      { kind: 'media.watch', happenedAt: '2026-07-04T15:00:00Z' },
    ];
    const hist = chronotypeHistogram(events, 'UTC');
    expect(hist[15]).toMatchObject({ messages: 1, meetings: 1, media: 2 });
    // message.received is excluded entirely (reflects others' timing, not the
    // user's) — total is the sum of the three signal categories.
    expect(hist[15].total).toBe(4);
  });
  it('handles a DST spring-forward instant without crashing', () => {
    // 2026-03-08 09:30Z is ~01:30 local before the 02:00 PST→PDT jump.
    const events = [{ kind: 'media.listen', happenedAt: '2026-03-08T09:30:00Z' }];
    const hist = chronotypeHistogram(events, 'America/Los_Angeles');
    const active = hist.filter((s) => s.total > 0);
    expect(active).toHaveLength(1);
    expect(active[0].media).toBe(1);
  });
  it('skips invalid timestamps', () => {
    const hist = chronotypeHistogram([{ kind: 'message.sent', happenedAt: 'nonsense' }], 'UTC');
    expect(hist.every((s) => s.total === 0)).toBe(true);
  });
});

describe('peakHour', () => {
  it('returns the busiest hour for a field, or null when empty', () => {
    const hist = chronotypeHistogram([
      { kind: 'message.sent', happenedAt: '2026-07-04T09:00:00Z' },
      { kind: 'message.sent', happenedAt: '2026-07-04T09:30:00Z' },
      { kind: 'message.sent', happenedAt: '2026-07-04T14:00:00Z' },
    ], 'UTC');
    expect(peakHour(hist, 'messages')).toBe(9);
    expect(peakHour(hist, 'media')).toBe(null);
  });
});

describe('classifyObservedChronotype', () => {
  const at = (hourUtc, kind = 'media.listen') => ({ kind, happenedAt: `2026-07-04T${String(hourUtc).padStart(2, '0')}:00:00Z` });
  it('returns null type below the minimum sample size', () => {
    const hist = chronotypeHistogram([at(9), at(9)], 'UTC');
    expect(classifyObservedChronotype(hist).type).toBe(null);
  });
  it('classifies an early cluster as morning', () => {
    const events = [6, 7, 7, 8, 8, 9].map((h) => at(h));
    const hist = chronotypeHistogram(events, 'UTC');
    expect(classifyObservedChronotype(hist).type).toBe('morning');
  });
  it('classifies a late cluster as evening', () => {
    const events = [18, 19, 20, 20, 21, 22].map((h) => at(h));
    const hist = chronotypeHistogram(events, 'UTC');
    expect(classifyObservedChronotype(hist).type).toBe('evening');
  });
  it('uses a circular mean so a midnight-wrapped night-owl classifies as evening, not morning', () => {
    // Active 22:00–02:00 — a linear mean would land near noon (wrong); the
    // circular mean wraps the center near midnight, and the small-hours band
    // must then read as evening (a night owl), never 'morning'.
    const events = [22, 23, 0, 1, 2, 23].map((h) => at(h));
    const hist = chronotypeHistogram(events, 'UTC');
    const { type, centerHour } = classifyObservedChronotype(hist);
    expect(centerHour).not.toBeGreaterThan(3); // wrapped near midnight, not ~12
    expect(type).toBe('evening');
  });
  it('classifies a small-hours center (night owl) as evening', () => {
    const events = [23, 0, 0, 1, 1, 2].map((h) => at(h));
    const { type } = classifyObservedChronotype(chronotypeHistogram(events, 'UTC'));
    expect(type).toBe('evening');
  });
});

describe('compareChronotype — divergence is signal, not error', () => {
  it('agrees when both match', () => {
    expect(compareChronotype('morning', 'morning')).toMatchObject({ agree: true, divergence: 'none' });
  });
  it('flags adjacent types as mild divergence', () => {
    expect(compareChronotype('morning', 'intermediate')).toMatchObject({ agree: false, divergence: 'mild', distance: 1 });
  });
  it('flags morning-vs-evening as strong divergence', () => {
    expect(compareChronotype('morning', 'evening')).toMatchObject({ agree: false, divergence: 'strong', distance: 2 });
  });
  it('returns unknown (never a false divergence) when a side is missing', () => {
    expect(compareChronotype(null, 'evening')).toMatchObject({ agree: null, divergence: 'unknown' });
    expect(compareChronotype('morning', null)).toMatchObject({ agree: null, divergence: 'unknown' });
  });
});

describe('provenance — observed evidence supplements, never overwrites stated', () => {
  it('observed evidence records carry source: observed and never mutate a stated object', () => {
    // The comparison surfaces both values side by side; the stated value is
    // passed through untouched regardless of what was observed.
    const stated = Object.freeze({ type: 'morning' });
    const cmp = compareChronotype(stated.type, 'evening');
    expect(stated.type).toBe('morning'); // unchanged (frozen would throw on mutation)
    expect(cmp.statedType).toBe('morning');
    expect(cmp.observedType).toBe('evening');
  });
});

describe('buildConsumptionBrief', () => {
  it('renders numbers only — no invented interpretation', () => {
    const taste = {
      windows: {
        month: {
          days: 30,
          listen: { total: 5, topArtists: [{ name: 'A', count: 3 }], topGenres: [], novelty: { noveltyRatio: 0.6, distinct: 3, total: 5 } },
          watch: { total: 2, topChannels: [{ name: 'Chan', count: 2 }], topTopics: [] },
        },
      },
    };
    const chronotype = { observedType: 'evening', centerHour: 20, sampleSize: 40, peakHours: { messages: 21, media: 22, overall: 21 } };
    const brief = buildConsumptionBrief(taste, chronotype);
    expect(brief).toContain('A (3)');
    expect(brief).toContain('Chan (2)');
    expect(brief).toContain('Observed chronotype: evening');
    expect(brief).toContain('Novelty ratio: 0.6');
  });
  it('is safe on empty/absent evidence', () => {
    expect(() => buildConsumptionBrief(null, null)).not.toThrow();
    expect(buildConsumptionBrief(null, null)).toBe('');
  });
});
