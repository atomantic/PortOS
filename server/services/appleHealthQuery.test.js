/**
 * Apple Health Query Service Tests
 *
 * `pickDaySumPoints` is the read-side fix for #8450: a metric-day's stored
 * points can come from multiple devices (XML export: iPhone + Apple Watch)
 * and/or multiple importers (XML import + Health Auto Export JSON ingest)
 * covering the same day. Summing all of them double- or triple-counts
 * steps, energy, and sleep. These tests pin the dedup rule at the pure
 * boundary, then verify `getDailyAggregates` applies it end-to-end.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { PATHS } from '../lib/fileUtils.js';

const tempDirs = [];
beforeEach(async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'portos-ahQuery-test-'));
  tempDirs.push(tempDir);
  Object.defineProperty(PATHS, 'health', {
    value: tempDir,
    configurable: true,
  });
});

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  tempDirs.length = 0;
});

const { pickDaySumPoints, getDailyAggregates } = await import('./appleHealthQuery.js');

const qty = (p) => p.qty ?? 0;

describe('pickDaySumPoints', () => {
  it('picks the largest single XML source instead of summing devices (acceptance #1)', () => {
    const points = [
      { date: '2024-01-15 08:00:00 -0800', qty: 8000, src: 'iPhone', origin: 'xml' },
      { date: '2024-01-15 08:05:00 -0800', qty: 9000, src: 'Apple Watch', origin: 'xml' },
    ];
    const chosen = pickDaySumPoints(points, qty);
    expect(chosen).toHaveLength(1);
    expect(chosen[0].src).toBe('Apple Watch');
    expect(chosen.reduce((s, p) => s + p.qty, 0)).toBe(9000);
  });

  it('prefers HAE (already HealthKit-deduplicated) points over any XML points (acceptance #2)', () => {
    const points = [
      { date: '2024-01-15 08:00:00 -0800', qty: 8000, src: 'iPhone', origin: 'xml' },
      { date: '2024-01-15 08:05:00 -0800', qty: 9000, src: 'Apple Watch', origin: 'xml' },
      { date: '2024-01-15T00:00:00Z', qty: 9100, origin: 'hae' },
    ];
    const chosen = pickDaySumPoints(points, qty);
    expect(chosen).toHaveLength(1);
    expect(chosen[0].origin).toBe('hae');
    expect(chosen.reduce((s, p) => s + p.qty, 0)).toBe(9100);
  });

  it('reports the larger of two sleep sources rather than summing them (acceptance #3)', () => {
    const points = [
      { date: '2024-01-15 22:00:00 -0800', deep: 1, rem: 1, core: 3, awake: 0.5, src: 'Apple Watch', origin: 'xml' },
      { date: '2024-01-15 23:00:00 -0800', deep: 0.5, rem: 0.5, core: 2, awake: 0.2, src: 'iPhone', origin: 'xml' },
    ];
    const getSleepTotal = (p) => (p.deep ?? 0) + (p.rem ?? 0) + (p.core ?? 0);
    const chosen = pickDaySumPoints(points, getSleepTotal);
    expect(chosen).toHaveLength(1);
    expect(chosen[0].src).toBe('Apple Watch');
  });

  it('sums legacy HAE-only points with no origin/src exactly as before (acceptance #4)', () => {
    const points = [
      { date: '2024-01-15T00:00:00Z', qty: 4000 },
      { date: '2024-01-15T06:00:00Z', qty: 5000 },
    ];
    const chosen = pickDaySumPoints(points, qty);
    expect(chosen).toEqual(points);
    expect(chosen.reduce((s, p) => s + p.qty, 0)).toBe(9000);
  });

  it('treats legacy points carrying an src key (no origin) as XML and dedups by source', () => {
    const points = [
      { date: '2024-01-15 08:00:00 -0800', qty: 8000, src: 'iPhone' },
      { date: '2024-01-15 08:05:00 -0800', qty: 9000, src: 'Apple Watch' },
    ];
    const chosen = pickDaySumPoints(points, qty);
    expect(chosen).toHaveLength(1);
    expect(chosen[0].src).toBe('Apple Watch');
  });

  it('returns the input unchanged for an empty array', () => {
    expect(pickDaySumPoints([], qty)).toEqual([]);
  });
});

describe('getDailyAggregates', () => {
  async function writeDay(dateStr, metrics) {
    await writeFile(
      join(PATHS.health, `${dateStr}.json`),
      JSON.stringify({ date: dateStr, metrics, updated: new Date().toISOString() }),
      'utf-8'
    );
  }

  it('does not double-count step_count across two XML source devices for the same day', async () => {
    await writeDay('2024-02-01', {
      step_count: [
        { date: '2024-02-01 08:00:00 -0800', qty: 8000, unit: 'count', src: 'iPhone', origin: 'xml' },
        { date: '2024-02-01 08:05:00 -0800', qty: 9000, unit: 'count', src: 'Apple Watch', origin: 'xml' },
      ],
    });

    const results = await getDailyAggregates('step_count', '2024-02-01', '2024-02-01');
    expect(results).toEqual([{ date: '2024-02-01', value: 9000 }]);
  });

  it('does not double-count sleep_analysis across two sources for the same night', async () => {
    await writeDay('2024-02-02', {
      sleep_analysis: [
        { date: '2024-02-02 22:00:00 -0800', totalSleep: 5, deep: 1, rem: 1, core: 3, awake: 0.5, src: 'Apple Watch', origin: 'xml' },
        { date: '2024-02-02 23:00:00 -0800', totalSleep: 3, deep: 0.5, rem: 0.5, core: 2, awake: 0.2, src: 'iPhone', origin: 'xml' },
      ],
    });

    const results = await getDailyAggregates('sleep_analysis', '2024-02-02', '2024-02-02');
    expect(results).toHaveLength(1);
    expect(results[0].value).toBe(5);
    expect(results[0].deep).toBe(1);
    expect(results[0].rem).toBe(1);
    expect(results[0].core).toBe(3);
    expect(results[0].awake).toBe(0.5);
  });

  it('aggregates legacy HAE-only day files exactly as before (no origin/src)', async () => {
    await writeDay('2024-02-03', {
      step_count: [
        { date: '2024-02-03T00:00:00Z', qty: 4000 },
        { date: '2024-02-03T06:00:00Z', qty: 5000 },
      ],
    });

    const results = await getDailyAggregates('step_count', '2024-02-03', '2024-02-03');
    expect(results).toEqual([{ date: '2024-02-03', value: 9000 }]);
  });
});
