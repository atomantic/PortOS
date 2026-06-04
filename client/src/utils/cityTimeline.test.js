import { describe, it, expect } from 'vitest';
import { computeActivityDensity, buildTimelineBuckets } from './cityTimeline';

// Fixed reference "now" so the relative-age math is deterministic.
const NOW = 1_700_000_000_000;
const minsAgo = (m) => NOW - m * 60 * 1000;
const secsAgo = (s) => NOW - s * 1000;

describe('computeActivityDensity', () => {
  it('returns one empty slot per bin', () => {
    const slots = computeActivityDensity([], { now: NOW, bins: 24 });
    expect(slots).toHaveLength(24);
    expect(slots.every(s => s.count === 0 && s.level === null)).toBe(true);
  });

  it('bins recent events into the correct slot and counts them', () => {
    const logs = [
      { timestamp: secsAgo(5), level: 'info' },   // newest → last bin
      { timestamp: secsAgo(6), level: 'info' },
      { timestamp: minsAgo(9.9), level: 'info' }, // oldest → bin 0
    ];
    const slots = computeActivityDensity(logs, { now: NOW, windowMs: 10 * 60 * 1000, bins: 24 });
    expect(slots[slots.length - 1].count).toBe(2);
    expect(slots[0].count).toBe(1);
  });

  it('drops events outside the window', () => {
    const logs = [
      { timestamp: minsAgo(20), level: 'info' }, // older than 10m window
      { timestamp: NOW + 5000, level: 'info' },  // future
    ];
    const slots = computeActivityDensity(logs, { now: NOW, windowMs: 10 * 60 * 1000, bins: 24 });
    expect(slots.reduce((n, s) => n + s.count, 0)).toBe(0);
  });

  it('keeps the highest-severity level per bin', () => {
    const logs = [
      { timestamp: secsAgo(5), level: 'info' },
      { timestamp: secsAgo(6), level: 'error' },
      { timestamp: secsAgo(7), level: 'warn' },
    ];
    const slots = computeActivityDensity(logs, { now: NOW, windowMs: 60 * 1000, bins: 1 });
    expect(slots[0].count).toBe(3);
    expect(slots[0].level).toBe('error');
  });

  it('ignores entries with an unparseable timestamp', () => {
    const slots = computeActivityDensity(
      [{ timestamp: 'not-a-date', level: 'info' }, { level: 'info' }],
      { now: NOW },
    );
    expect(slots.reduce((n, s) => n + s.count, 0)).toBe(0);
  });
});

describe('buildTimelineBuckets', () => {
  it('groups events into relative-age buckets, newest first', () => {
    const logs = [
      { _localId: 1, timestamp: secsAgo(10), level: 'info', message: 'now-ish' },
      { _localId: 2, timestamp: minsAgo(3), level: 'warn', message: 'recent' },
      { _localId: 3, timestamp: minsAgo(12), level: 'error', message: 'quarter' },
      { _localId: 4, timestamp: minsAgo(40), level: 'info', message: 'older' },
    ];
    const buckets = buildTimelineBuckets(logs, { now: NOW });
    expect(buckets.map(b => b.id)).toEqual(['now', 'recent', 'quarter', 'older']);
    expect(buckets[0].events[0].message).toBe('now-ish');
    expect(buckets[2].events[0].level).toBe('error');
  });

  it('drops empty buckets', () => {
    const logs = [{ _localId: 1, timestamp: secsAgo(5), level: 'info', message: 'just happened' }];
    const buckets = buildTimelineBuckets(logs, { now: NOW });
    expect(buckets).toHaveLength(1);
    expect(buckets[0].id).toBe('now');
  });

  it('orders events newest-first within a bucket', () => {
    const logs = [
      { _localId: 1, timestamp: minsAgo(4), level: 'info', message: 'first' },
      { _localId: 2, timestamp: minsAgo(2), level: 'info', message: 'second' },
    ];
    const buckets = buildTimelineBuckets(logs, { now: NOW });
    expect(buckets[0].events.map(e => e.message)).toEqual(['second', 'first']);
  });

  it('caps total events at `max`', () => {
    const logs = Array.from({ length: 100 }, (_, i) => ({
      _localId: i,
      timestamp: secsAgo(i),
      level: 'info',
      message: `e${i}`,
    }));
    const buckets = buildTimelineBuckets(logs, { now: NOW, max: 10 });
    const total = buckets.reduce((n, b) => n + b.events.length, 0);
    expect(total).toBe(10);
  });

  it('lower-cases the level and defaults a missing one to info', () => {
    const logs = [
      { _localId: 1, timestamp: secsAgo(1), level: 'WARN', message: 'w' },
      { _localId: 2, timestamp: secsAgo(2), message: 'no-level' },
    ];
    const buckets = buildTimelineBuckets(logs, { now: NOW });
    const levels = buckets.flatMap(b => b.events.map(e => e.level));
    expect(levels).toContain('warn');
    expect(levels).toContain('info');
  });

  it('skips events with future or invalid timestamps', () => {
    const logs = [
      { _localId: 1, timestamp: NOW + 60000, level: 'info', message: 'future' },
      { _localId: 2, timestamp: 'nope', level: 'info', message: 'bad' },
      { _localId: 3, timestamp: secsAgo(5), level: 'info', message: 'good' },
    ];
    const buckets = buildTimelineBuckets(logs, { now: NOW });
    const msgs = buckets.flatMap(b => b.events.map(e => e.message));
    expect(msgs).toEqual(['good']);
  });
});
