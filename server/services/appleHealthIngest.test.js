/**
 * Apple Health Ingest Service Tests
 *
 * Tests for upsert logic: latest write wins, data updates correctly,
 * identical points are skipped, and concurrent writes serialize per-date.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { PATHS } from '../lib/fileUtils.js';

// Mock PATHS to use a temp directory
const tempDirs = [];
beforeEach(async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'portos-ahIngest-test-'));
  tempDirs.push(tempDir);
  // Override PATHS.health for this test
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

const { extractDateStr, upsertPoints, mergeIntoDay, ingestHealthData } = await import('./appleHealthIngest.js');

describe('extractDateStr', () => {
  it('extracts YYYY-MM-DD from an Apple Health timestamp', () => {
    expect(extractDateStr('2024-01-15 08:30:00 -0800')).toBe('2024-01-15');
    expect(extractDateStr('2024-12-31 23:59:59 +0000')).toBe('2024-12-31');
  });

  it('returns null for invalid dates', () => {
    expect(extractDateStr('not-a-date')).toBeNull();
    expect(extractDateStr('')).toBeNull();
    expect(extractDateStr(null)).toBeNull();
    expect(extractDateStr(undefined)).toBeNull();
  });
});

describe('upsertPoints', () => {
  it('adds new points when existing array is empty', () => {
    const newPoints = [
      { date: '2024-01-15 00:00:00 -0800', qty: 300 },
      { date: '2024-01-15 12:00:00 -0800', qty: 500 },
    ];
    const result = upsertPoints([], newPoints);

    expect(result.added).toBe(2);
    expect(result.updated).toBe(0);
    expect(result.result).toHaveLength(2);
    expect(result.result[0].qty).toBe(300);
    expect(result.result[1].qty).toBe(500);
  });

  it('updates existing point when date matches', () => {
    const existing = [
      { date: '2024-01-15 00:00:00 -0800', qty: 300 },
    ];
    const newPoints = [
      { date: '2024-01-15 00:00:00 -0800', qty: 9000 },
    ];
    const result = upsertPoints(existing, newPoints);

    expect(result.added).toBe(0);
    expect(result.updated).toBe(1);
    expect(result.result).toHaveLength(1);
    expect(result.result[0].qty).toBe(9000);
  });

  it('skips identical points without counting as added or updated', () => {
    const existing = [
      { date: '2024-01-15 00:00:00 -0800', qty: 300 },
    ];
    const newPoints = [
      { date: '2024-01-15 00:00:00 -0800', qty: 300 },
    ];
    const result = upsertPoints(existing, newPoints);

    expect(result.added).toBe(0);
    expect(result.updated).toBe(0);
    expect(result.result).toHaveLength(1);
    expect(result.result[0].qty).toBe(300);
  });

  it('mixes adds, updates, and skips correctly', () => {
    const existing = [
      { date: '2024-01-15 00:00:00 -0800', qty: 300 }, // will be updated
      { date: '2024-01-15 06:00:00 -0800', qty: 400 }, // will be skipped (identical)
    ];
    const newPoints = [
      { date: '2024-01-15 00:00:00 -0800', qty: 9000 }, // update
      { date: '2024-01-15 06:00:00 -0800', qty: 400 },  // skip (identical)
      { date: '2024-01-15 12:00:00 -0800', qty: 500 },  // add
    ];
    const result = upsertPoints(existing, newPoints);

    expect(result.added).toBe(1);
    expect(result.updated).toBe(1);
    expect(result.result).toHaveLength(3);
    // Check the values
    expect(result.result.find(p => p.date === '2024-01-15 00:00:00 -0800').qty).toBe(9000);
    expect(result.result.find(p => p.date === '2024-01-15 06:00:00 -0800').qty).toBe(400);
    expect(result.result.find(p => p.date === '2024-01-15 12:00:00 -0800').qty).toBe(500);
  });
});

describe('mergeIntoDay', () => {
  it('creates a new day file when it does not exist', async () => {
    const result = await mergeIntoDay('2024-01-15', 'step_count', [
      { date: '2024-01-15 00:00:00 -0800', qty: 9000 },
    ]);

    expect(result.added).toBe(1);
    expect(result.updated).toBe(0);
    expect(result.totalPoints).toBe(1);

    // Verify file was written
    const dayPath = join(PATHS.health, '2024-01-15.json');
    const content = await import('fs/promises').then(m => m.readFile(dayPath, 'utf-8'));
    const data = JSON.parse(content);
    expect(data.metrics.step_count).toHaveLength(1);
    expect(data.metrics.step_count[0].qty).toBe(9000);
  });

  it('updates an existing day value with a larger value', async () => {
    const dayPath = join(PATHS.health, '2024-01-15.json');
    await writeFile(dayPath, JSON.stringify({
      date: '2024-01-15',
      metrics: {
        step_count: [
          { date: '2024-01-15 08:00:00 -0800', qty: 300 },
        ],
      },
      updated: new Date().toISOString(),
    }), 'utf-8');

    // Re-sync with more complete data
    const result = await mergeIntoDay('2024-01-15', 'step_count', [
      { date: '2024-01-15 08:00:00 -0800', qty: 9000 },
    ]);

    expect(result.added).toBe(0);
    expect(result.updated).toBe(1);
    expect(result.totalPoints).toBe(1);

    const content = await import('fs/promises').then(m => m.readFile(dayPath, 'utf-8'));
    const data = JSON.parse(content);
    expect(data.metrics.step_count[0].qty).toBe(9000);
  });

  it('does not rewrite file when ingesting identical point', async () => {
    const dayPath = join(PATHS.health, '2024-01-15.json');
    const originalTime = new Date('2024-01-01T00:00:00Z').toISOString();
    await writeFile(dayPath, JSON.stringify({
      date: '2024-01-15',
      metrics: {
        step_count: [
          { date: '2024-01-15 08:00:00 -0800', qty: 300 },
        ],
      },
      updated: originalTime,
    }), 'utf-8');

    // Ingest identical point
    const result = await mergeIntoDay('2024-01-15', 'step_count', [
      { date: '2024-01-15 08:00:00 -0800', qty: 300 },
    ]);

    expect(result.added).toBe(0);
    expect(result.updated).toBe(0);

    const content = await import('fs/promises').then(m => m.readFile(dayPath, 'utf-8'));
    const data = JSON.parse(content);
    // File should not have been rewritten, so updated timestamp should still match original
    expect(data.updated).toBe(originalTime);
  });

  it('handles multiple metrics in same day', async () => {
    await mergeIntoDay('2024-01-15', 'step_count', [
      { date: '2024-01-15 08:00:00 -0800', qty: 9000 },
    ]);

    await mergeIntoDay('2024-01-15', 'heart_rate', [
      { date: '2024-01-15 10:00:00 -0800', qty: 72 },
    ]);

    const dayPath = join(PATHS.health, '2024-01-15.json');
    const content = await import('fs/promises').then(m => m.readFile(dayPath, 'utf-8'));
    const data = JSON.parse(content);

    expect(data.metrics.step_count).toHaveLength(1);
    expect(data.metrics.step_count[0].qty).toBe(9000);
    expect(data.metrics.heart_rate).toHaveLength(1);
    expect(data.metrics.heart_rate[0].qty).toBe(72);
  });
});

describe('ingestHealthData', () => {
  it('ingests new data and reports added records', async () => {
    const payload = {
      data: {
        metrics: [
          {
            name: 'step_count',
            data: [
              { date: '2024-01-15 08:00:00 -0800', qty: 9000 },
              { date: '2024-01-15 18:00:00 -0800', qty: 5000 },
            ],
          },
        ],
      },
    };

    const result = await ingestHealthData(payload);

    expect(result.recordsIngested).toBe(2);
    expect(result.recordsUpdated).toBe(0);
    expect(result.recordsSkipped).toBe(0);
    expect(result.daysAffected).toBe(1);
  });

  it('updates existing values and reports separately', async () => {
    const dayPath = join(PATHS.health, '2024-01-15.json');
    await writeFile(dayPath, JSON.stringify({
      date: '2024-01-15',
      metrics: {
        step_count: [
          { date: '2024-01-15 08:00:00 -0800', qty: 300 }, // partial value
        ],
      },
      updated: new Date().toISOString(),
    }), 'utf-8');

    // Re-sync with complete data
    const payload = {
      data: {
        metrics: [
          {
            name: 'step_count',
            data: [
              { date: '2024-01-15 08:00:00 -0800', qty: 9000 }, // updated
            ],
          },
        ],
      },
    };

    const result = await ingestHealthData(payload);

    expect(result.recordsIngested).toBe(0);
    expect(result.recordsUpdated).toBe(1);
    expect(result.recordsSkipped).toBe(0);
    expect(result.daysAffected).toBe(1);
  });

  it('distinguishes dupes (identical) from updates', async () => {
    const dayPath = join(PATHS.health, '2024-01-15.json');
    const originalTime = new Date('2024-01-01T00:00:00Z').toISOString();
    await writeFile(dayPath, JSON.stringify({
      date: '2024-01-15',
      metrics: {
        step_count: [
          { date: '2024-01-15 08:00:00 -0800', qty: 9000, origin: 'hae' },
        ],
      },
      updated: originalTime,
    }), 'utf-8');

    // Re-sync with identical data
    const payload = {
      data: {
        metrics: [
          {
            name: 'step_count',
            data: [
              { date: '2024-01-15 08:00:00 -0800', qty: 9000 }, // identical
            ],
          },
        ],
      },
    };

    const result = await ingestHealthData(payload);

    expect(result.recordsIngested).toBe(0);
    expect(result.recordsUpdated).toBe(0);
    expect(result.recordsSkipped).toBe(1); // counted as dupe
  });

  it('re-stamps a legacy point (no origin) as an update exactly once, then treats it as a dupe (#8450)', async () => {
    const dayPath = join(PATHS.health, '2024-01-16.json');
    await writeFile(dayPath, JSON.stringify({
      date: '2024-01-16',
      metrics: {
        step_count: [
          { date: '2024-01-16 08:00:00 -0800', qty: 9000 }, // pre-#8450: no origin stamp
        ],
      },
      updated: new Date('2024-01-01T00:00:00Z').toISOString(),
    }), 'utf-8');

    const payload = {
      data: {
        metrics: [
          { name: 'step_count', data: [{ date: '2024-01-16 08:00:00 -0800', qty: 9000 }] },
        ],
      },
    };

    // First re-sync after upgrading: same value, but ingestHealthData now
    // stamps origin, so the stored point differs from the legacy one and is
    // counted as an update (self-healing one-time migration).
    const first = await ingestHealthData(payload);
    expect(first.recordsIngested).toBe(0);
    expect(first.recordsUpdated).toBe(1);
    expect(first.recordsSkipped).toBe(0);

    // Second re-sync: the stored point now carries origin: 'hae' too, so it's
    // a true dupe again.
    const second = await ingestHealthData(payload);
    expect(second.recordsIngested).toBe(0);
    expect(second.recordsUpdated).toBe(0);
    expect(second.recordsSkipped).toBe(1);
  });

  it('mixes additions, updates, and dupes in one ingest', async () => {
    const dayPath = join(PATHS.health, '2024-01-15.json');
    const originalTime = new Date('2024-01-01T00:00:00Z').toISOString();
    await writeFile(dayPath, JSON.stringify({
      date: '2024-01-15',
      metrics: {
        step_count: [
          { date: '2024-01-15 08:00:00 -0800', qty: 300, origin: 'hae' },    // will be updated
          { date: '2024-01-15 12:00:00 -0800', qty: 400, origin: 'hae' },    // will be skipped (dupe)
        ],
      },
      updated: originalTime,
    }), 'utf-8');

    const payload = {
      data: {
        metrics: [
          {
            name: 'step_count',
            data: [
              { date: '2024-01-15 08:00:00 -0800', qty: 9000 },  // update
              { date: '2024-01-15 12:00:00 -0800', qty: 400 },   // dupe (identical)
              { date: '2024-01-15 18:00:00 -0800', qty: 500 },   // add
            ],
          },
        ],
      },
    };

    const result = await ingestHealthData(payload);

    expect(result.recordsIngested).toBe(1); // 1 added
    expect(result.recordsUpdated).toBe(1);  // 1 updated
    expect(result.recordsSkipped).toBe(1);  // 1 dupe (identical)
  });

  it('handles multiple days and metrics', async () => {
    const payload = {
      data: {
        metrics: [
          {
            name: 'step_count',
            data: [
              { date: '2024-01-14 08:00:00 -0800', qty: 8000 },
              { date: '2024-01-15 08:00:00 -0800', qty: 9000 },
            ],
          },
          {
            name: 'heart_rate',
            data: [
              { date: '2024-01-14 10:00:00 -0800', qty: 70 },
              { date: '2024-01-15 10:00:00 -0800', qty: 72 },
            ],
          },
        ],
      },
    };

    const result = await ingestHealthData(payload);

    expect(result.metricsProcessed).toBe(2);
    expect(result.recordsIngested).toBe(4);
    expect(result.daysAffected).toBe(2);

    // Verify both day files exist
    const content14 = await import('fs/promises').then(m =>
      m.readFile(join(PATHS.health, '2024-01-14.json'), 'utf-8')
    );
    const data14 = JSON.parse(content14);
    expect(data14.metrics.step_count).toHaveLength(1);
    expect(data14.metrics.heart_rate).toHaveLength(1);

    const content15 = await import('fs/promises').then(m =>
      m.readFile(join(PATHS.health, '2024-01-15.json'), 'utf-8')
    );
    const data15 = JSON.parse(content15);
    expect(data15.metrics.step_count).toHaveLength(1);
    expect(data15.metrics.heart_rate).toHaveLength(1);
  });

  it('normalizes metric name aliases', async () => {
    const payload = {
      data: {
        metrics: [
          {
            name: 'heart_rate_variability', // HAE short name
            data: [
              { date: '2024-01-15 08:00:00 -0800', qty: 25 },
            ],
          },
        ],
      },
    };

    const result = await ingestHealthData(payload);

    expect(result.recordsIngested).toBe(1);

    const dayPath = join(PATHS.health, '2024-01-15.json');
    const content = await import('fs/promises').then(m => m.readFile(dayPath, 'utf-8'));
    const data = JSON.parse(content);
    // Should be stored under the normalized name
    expect(data.metrics.heart_rate_variability_sdnn).toHaveLength(1);
  });

  it('skips records with invalid date strings', async () => {
    const payload = {
      data: {
        metrics: [
          {
            name: 'step_count',
            data: [
              { date: '2024-01-15 08:00:00 -0800', qty: 9000 },
              { date: 'invalid-date', qty: 5000 },
              { date: '2024-01-15 18:00:00 -0800', qty: 2000 },
            ],
          },
        ],
      },
    };

    const result = await ingestHealthData(payload);

    expect(result.recordsIngested).toBe(2);
    expect(result.recordsSkipped).toBe(1); // invalid-date
  });
});
