/**
 * Migration 220 — backfill `source: 'auto'` on machine-created media
 * collections (#3311). Lays down one record per marker the classifier honors
 * plus the four records it must leave alone (user-made, already stamped,
 * tombstoned, unparseable) and asserts exactly the auto ones gain the stamp —
 * with `updatedAt` untouched, since a derived classification must not advance
 * the LWW clock.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { mkdir, writeFile, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import migration, { isAutoCreated, stampAutoSource } from './220-backfill-media-collection-source.js';

let ROOT;
const typeDir = () => join(ROOT, 'data', 'media-collections');

const STAMP = '2026-01-01T00:00:00.000Z';

async function writeRecord(id, patch) {
  await mkdir(join(typeDir(), id), { recursive: true });
  await writeFile(join(typeDir(), id, 'index.json'), JSON.stringify({
    id,
    name: 'Concept Art',
    description: '',
    coverKey: null,
    universeId: null,
    seriesId: null,
    items: [],
    createdAt: STAMP,
    updatedAt: STAMP,
    deleted: false,
    deletedAt: null,
    ...patch,
  }, null, 2));
}

const readRecord = async (id) => JSON.parse(await readFile(join(typeDir(), id, 'index.json'), 'utf-8'));

beforeEach(async () => {
  ROOT = mkdtempSync(join(tmpdir(), 'migration-220-'));
  await mkdir(typeDir(), { recursive: true });
});

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

describe('migration 220 — backfill media collection source', () => {
  it('stamps every non-forgeable marker and leaves user-made, stamped, and tombstoned records alone', async () => {
    await writeRecord('cd-1', { name: 'Creative Director: Example Project', description: 'Auto-created for project cd-1' });
    await writeRecord('wr-1', { name: 'Writers Room: Example Work', description: 'Auto-generated images for "Example Work"' });
    await writeRecord('desc-1', { description: 'Auto-created for project abc' });
    await writeRecord('desc-2', { description: 'Auto-generated images for "Example Work"' });
    await writeRecord('uc-universe-1', { name: 'Universe: Example Universe', universeId: 'universe-1' });
    await writeRecord('sc-series-1', { name: 'Series: Example Series', seriesId: 'series-1' });
    await writeRecord('linked-legacy', { name: 'Renamed Bucket', universeId: 'universe-2' });
    // Left alone:
    await writeRecord('user-1', {});
    // A user is free to NAME a collection with an auto-creator's prefix — the
    // create route reserves nothing — so a bare name match must never freeze a
    // permanent 'auto' stamp. It keeps flowing through the client fallback.
    await writeRecord('name-only-1', { name: 'Universe: Notes I Made Myself' });
    await writeRecord('user-2', { source: 'user', name: 'Universe: Named Like An Auto One' });
    await writeRecord('already-auto', { source: 'auto', name: 'Creative Director: Example Project' });
    await writeRecord('tombstone-1', { name: 'Universe: Deleted One', universeId: 'universe-3', deleted: true, deletedAt: STAMP });
    // Unparseable record — skipped without failing the run.
    await mkdir(join(typeDir(), 'broken-1'), { recursive: true });
    await writeFile(join(typeDir(), 'broken-1', 'index.json'), '{ not json');
    // The type-level index is a FILE, not a record dir — must not be touched.
    await writeFile(join(typeDir(), 'index.json'), JSON.stringify({ schemaVersion: 1, type: 'mediaCollections' }));

    const result = await migration.up({ rootDir: ROOT });
    expect(result).toMatchObject({ ok: true, reason: 'migrated', stamped: 7 });

    for (const id of ['cd-1', 'wr-1', 'desc-1', 'desc-2', 'uc-universe-1', 'sc-series-1', 'linked-legacy']) {
      const rec = await readRecord(id);
      expect(rec.source, id).toBe('auto');
      // A derived classification must not look like a user edit to a peer.
      expect(rec.updatedAt, id).toBe(STAMP);
    }
    expect((await readRecord('user-1')).source).toBeUndefined();
    expect((await readRecord('name-only-1')).source).toBeUndefined();
    expect((await readRecord('user-2')).source).toBe('user');
    expect((await readRecord('already-auto')).source).toBe('auto');
    expect((await readRecord('tombstone-1')).source).toBeUndefined();
    expect(JSON.parse(await readFile(join(typeDir(), 'index.json'), 'utf-8')).schemaVersion).toBe(1);
  });

  it('is idempotent — a second pass stamps nothing', async () => {
    await writeRecord('uc-universe-1', { name: 'Universe: Example Universe', universeId: 'universe-1' });
    expect((await migration.up({ rootDir: ROOT })).stamped).toBe(1);
    const second = await migration.up({ rootDir: ROOT });
    expect(second).toMatchObject({ reason: 'nothing-to-stamp', stamped: 0, scanned: 1 });
  });

  it('no-ops on a fresh install with no media-collections dir', async () => {
    rmSync(typeDir(), { recursive: true, force: true });
    expect(await migration.up({ rootDir: ROOT })).toMatchObject({ ok: true, reason: 'no-collections' });
  });

  it('ignores the user-forgeable name prefix and tolerates non-record input', () => {
    // The create route takes a free name, so a prefix alone proves nothing.
    expect(isAutoCreated({ id: 'x', name: 'Universe: Example' })).toBe(false);
    // The same record with a marker the create form cannot produce does qualify.
    expect(isAutoCreated({ id: 'x', name: 'Universe: Example', universeId: 'u1' })).toBe(true);
    expect(isAutoCreated({ id: 'x', description: 'Auto-created for project x' })).toBe(true);
    // A corrupt owner link is not a marker — `sanitizeCollection` drops a
    // non-string universeId/seriesId on the next read, so stamping from one
    // would classify a record that has no machine-owned marker at all.
    expect(isAutoCreated({ id: 'x', universeId: true })).toBe(false);
    expect(isAutoCreated({ id: 'x', seriesId: '' })).toBe(false);
    expect(isAutoCreated(null)).toBe(false);
    expect(stampAutoSource('nope')).toBe(null);
  });
});
