/**
 * Track file-backend store — CRUD + LWW merge outcomes.
 *
 * Covers the CRUD round-trip + `mergeTracksFromSync` LWW outcomes. Conflict-
 * journal side effects are NOT asserted (track kind not yet registered in
 * syncWire/peerSync — deferred, local-only; see issue #1502). tmpdir-backed.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const TEST_DATA_ROOT = mkdtempSync(join(tmpdir(), 'tracks-file-test-'));

vi.mock('../../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, PATHS: { ...actual.PATHS, data: TEST_DATA_ROOT } };
});

const file = await import('./file.js');

function reset() {
  rmSync(join(TEST_DATA_ROOT, 'tracks.json'), { force: true });
  rmSync(join(TEST_DATA_ROOT, 'sharing'), { recursive: true, force: true });
  rmSync(join(TEST_DATA_ROOT, 'conflict-journal'), { recursive: true, force: true });
}

const track = (id, extra = {}) => ({
  id, title: id, albumId: '', artistId: '', artist: '', lyrics: '', prompt: '',
  engine: '', modelId: '', durationSec: null, audioFilename: '',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  deleted: false, deletedAt: null, ...extra,
});

beforeEach(reset);
afterAll(() => rmSync(TEST_DATA_ROOT, { recursive: true, force: true }));

describe('tracks file backend — CRUD', () => {
  it('creates, reads, updates and soft-deletes a track', async () => {
    const created = await file.createTrack({ title: 'Intro', audioFilename: 'music-1.mp3' });
    expect(created.id).toMatch(/^track-/);
    expect((await file.getTrack(created.id)).audioFilename).toBe('music-1.mp3');

    const updated = await file.updateTrack(created.id, { audioFilename: '' });
    expect(updated.audioFilename).toBe('');

    await file.deleteTrack(created.id);
    expect(await file.getTrack(created.id)).toBeNull();
    expect(await file.listTracks()).toHaveLength(0);
  });
});

describe('tracks file backend — mergeTracksFromSync (LWW outcomes)', () => {
  it('inserts, then newer wins / older no-ops', async () => {
    expect(await file.mergeTracksFromSync([track('track-1', { prompt: 'v1', updatedAt: '2026-02-01T00:00:00.000Z' })]))
      .toEqual({ applied: true, count: 1 });
    expect(await file.mergeTracksFromSync([track('track-1', { prompt: 'v2', updatedAt: '2026-03-01T00:00:00.000Z' })]))
      .toEqual({ applied: true, count: 1 });
    expect((await file.getTrack('track-1')).prompt).toBe('v2');
    expect(await file.mergeTracksFromSync([track('track-1', { prompt: 'stale', updatedAt: '2020-01-01T00:00:00.000Z' })]))
      .toEqual({ applied: false, count: 0 });
  });

  it('pruneTombstonedTracks hard-removes an old tombstone', async () => {
    await file.mergeTracksFromSync([track('track-dead', { deleted: true, deletedAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z' })]);
    expect(await file.pruneTombstonedTracks(Date.parse('2030-01-01T00:00:00.000Z'))).toEqual({ pruned: 1 });
    expect(await file.getTrack('track-dead', { includeDeleted: true })).toBeNull();
  });
});
