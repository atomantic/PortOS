/**
 * Tests for `scripts/migrations/009-heal-sharing-cursor-drops.js` — the
 * one-shot heal that clears sharing cursor entries whose manifests are
 * still on disk but whose records never got inserted locally.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { healSharingCursorDrops } from '../../../scripts/migrations/009-heal-sharing-cursor-drops.js';

const writeJson = (path, value) =>
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');

describe('healSharingCursorDrops migration', () => {
  let rootDir;
  let dataDir;
  let bucketPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'portos-heal-migration-root-'));
    dataDir = join(rootDir, 'data');
    bucketPath = mkdtempSync(join(tmpdir(), 'portos-heal-migration-bucket-'));
    mkdirSync(join(dataDir, 'sharing', 'cursors'), { recursive: true });
    mkdirSync(join(bucketPath, 'manifests'), { recursive: true });
  });

  afterEach(() => {
    if (rootDir) rmSync(rootDir, { recursive: true, force: true });
    if (bucketPath) rmSync(bucketPath, { recursive: true, force: true });
  });

  function registerBucket(id, name) {
    writeJson(join(dataDir, 'sharing', 'buckets.json'), {
      buckets: [{ id, name, path: bucketPath, mode: 'auto-merge' }],
    });
  }

  function writeManifest(filename, recordIds, manifestId = 'mfst-test') {
    writeJson(join(bucketPath, 'manifests', filename), {
      id: manifestId, kind: 'universe', recordIds, assetRefs: [],
    });
  }

  function writeCursor(bucketId, processedById, extra = {}) {
    writeJson(join(dataDir, 'sharing', 'cursors', `${bucketId}.json`), {
      processedById, processed: [], lastProcessedAt: null, ...extra,
    });
  }

  function readCursor(bucketId) {
    return JSON.parse(readFileSync(join(dataDir, 'sharing', 'cursors', `${bucketId}.json`), 'utf-8'));
  }

  it('forgets cursor entries whose universe record is absent locally', async () => {
    registerBucket('bkt-1', 'TestBucket');
    writeManifest('sub-universe-uuid-stuck.json', ['uuid-stuck'], 'mfst-stuck');
    writeCursor('bkt-1', { 'sub-universe-uuid-stuck.json': 'mfst-stuck' });
    // universe-builder.json absent → uuid-stuck not in any local set.

    const result = await healSharingCursorDrops({ rootDir });
    expect(result.totalForgotten).toBe(1);
    const cursor = readCursor('bkt-1');
    expect(cursor.processedById).toEqual({});
    expect(cursor.lastProcessedAt).toBeTruthy();
  });

  it('keeps cursor entries when every referenced record is present locally', async () => {
    registerBucket('bkt-1', 'TestBucket');
    writeManifest('sub-universe-uuid-ok.json', ['uuid-ok'], 'mfst-ok');
    writeJson(join(dataDir, 'universe-builder.json'), {
      universes: [{ id: 'uuid-ok', name: 'OK Universe' }],
    });
    writeCursor('bkt-1', { 'sub-universe-uuid-ok.json': 'mfst-ok' });

    const result = await healSharingCursorDrops({ rootDir });
    expect(result.totalForgotten).toBe(0);
    const cursor = readCursor('bkt-1');
    expect(cursor.processedById).toEqual({ 'sub-universe-uuid-ok.json': 'mfst-ok' });
  });

  it('leaves cursor alone when manifest is gone from the bucket (peer unshared)', async () => {
    registerBucket('bkt-1', 'TestBucket');
    // No manifest file on disk — peer unshared.
    writeCursor('bkt-1', { 'sub-universe-uuid-gone.json': 'mfst-gone' });

    const result = await healSharingCursorDrops({ rootDir });
    expect(result.totalForgotten).toBe(0);
    expect(readCursor('bkt-1').processedById).toEqual({ 'sub-universe-uuid-gone.json': 'mfst-gone' });
  });

  it('treats series + issue + universe (UUID) recordIds correctly', async () => {
    registerBucket('bkt-1', 'TestBucket');
    writeManifest('sub-series-ser-known.json',
      ['ser-known', 'iss-known', 'uuid-known'], 'mfst-mixed-present');
    writeManifest('sub-series-ser-partial.json',
      ['ser-known', 'iss-missing'], 'mfst-mixed-partial');
    writeJson(join(dataDir, 'pipeline-series.json'), { series: [{ id: 'ser-known' }] });
    writeJson(join(dataDir, 'pipeline-issues.json'), { issues: [{ id: 'iss-known' }] });
    writeJson(join(dataDir, 'universe-builder.json'), { universes: [{ id: 'uuid-known' }] });
    writeCursor('bkt-1', {
      'sub-series-ser-known.json': 'mfst-mixed-present',
      'sub-series-ser-partial.json': 'mfst-mixed-partial',
    });

    const result = await healSharingCursorDrops({ rootDir });
    expect(result.totalForgotten).toBe(1);
    const cursor = readCursor('bkt-1');
    expect(cursor.processedById).toEqual({ 'sub-series-ser-known.json': 'mfst-mixed-present' });
  });

  it('accepts UUID records that resolve via media-jobs instead of universes', async () => {
    registerBucket('bkt-1', 'TestBucket');
    writeManifest('sub-media-uuid-job.json', ['uuid-mediajob'], 'mfst-media');
    writeJson(join(dataDir, 'media-jobs.json'), { jobs: [{ id: 'uuid-mediajob' }] });
    writeCursor('bkt-1', { 'sub-media-uuid-job.json': 'mfst-media' });

    const result = await healSharingCursorDrops({ rootDir });
    expect(result.totalForgotten).toBe(0);
  });

  it('is idempotent on second run', async () => {
    registerBucket('bkt-1', 'TestBucket');
    writeManifest('sub-universe-uuid-stuck.json', ['uuid-stuck'], 'mfst-stuck');
    writeCursor('bkt-1', { 'sub-universe-uuid-stuck.json': 'mfst-stuck' });

    const first = await healSharingCursorDrops({ rootDir });
    expect(first.totalForgotten).toBe(1);
    const second = await healSharingCursorDrops({ rootDir });
    expect(second.totalForgotten).toBe(0);
  });

  it('no-ops on installs with no sharing buckets registered', async () => {
    // No buckets.json file at all.
    const result = await healSharingCursorDrops({ rootDir });
    expect(result.totalForgotten).toBe(0);
    expect(existsSync(join(dataDir, 'sharing', 'cursors'))).toBe(true);
  });
});
