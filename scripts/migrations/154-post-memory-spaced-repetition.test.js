import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration, { MIGRATION_DEFAULT_EASE } from './154-post-memory-spaced-repetition.js';
import { DEFAULT_EASE } from '../../server/services/meatspacePostMemory.js';

const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));

describe('migration 154 — backfill POST memory spaced-repetition schedule', () => {
  let rootDir;
  let itemsPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-154-'));
    mkdirSync(join(rootDir, 'data', 'meatspace'), { recursive: true });
    itemsPath = join(rootDir, 'data', 'meatspace', 'post-memory-items.json');
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('does not drift from the service default ease', () => {
    expect(MIGRATION_DEFAULT_EASE).toBe(DEFAULT_EASE);
  });

  it('no-ops when the memory items file is missing', async () => {
    const result = await migration.up({ rootDir });
    expect(result).toEqual({ updated: 0, reason: 'no-file' });
    expect(existsSync(itemsPath)).toBe(false);
  });

  it('stamps a default schedule on items that lack one', async () => {
    writeJson(itemsPath, {
      items: [
        { id: 'a', title: 'A', updatedAt: '2026-01-01T00:00:00.000Z' },
        { id: 'b', title: 'B' },
      ],
    });
    const result = await migration.up({ rootDir });
    expect(result.updated).toBe(2);

    const { items } = readJson(itemsPath);
    expect(items[0].schedule).toEqual({
      ease: MIGRATION_DEFAULT_EASE,
      intervalDays: 0,
      nextReview: '2026-01-01T00:00:00.000Z', // anchored to updatedAt
      lastReviewed: null,
    });
    // Second item has no timestamps → anchored to run time (a valid ISO string).
    expect(items[1].schedule.intervalDays).toBe(0);
    expect(Number.isNaN(Date.parse(items[1].schedule.nextReview))).toBe(false);
  });

  it('leaves an already-scheduled item untouched', async () => {
    const existing = { ease: 2.6, intervalDays: 6, nextReview: '2030-01-01T00:00:00.000Z', lastReviewed: '2026-05-01T00:00:00.000Z' };
    writeJson(itemsPath, { items: [{ id: 'a', title: 'A', schedule: existing }] });
    const result = await migration.up({ rootDir });
    expect(result).toEqual({ updated: 0, reason: 'already-scheduled' });
    expect(readJson(itemsPath).items[0].schedule).toEqual(existing);
  });

  it('is idempotent across re-runs', async () => {
    writeJson(itemsPath, { items: [{ id: 'a', title: 'A' }] });
    await migration.up({ rootDir });
    const afterFirst = readJson(itemsPath);
    const second = await migration.up({ rootDir });
    expect(second).toEqual({ updated: 0, reason: 'already-scheduled' });
    expect(readJson(itemsPath)).toEqual(afterFirst);
  });

  it('skips a malformed items file without throwing', async () => {
    writeFileSync(itemsPath, '{ not json');
    const result = await migration.up({ rootDir });
    expect(result).toEqual({ updated: 0, reason: 'invalid-json' });
  });
});
