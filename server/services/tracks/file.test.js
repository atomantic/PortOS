/**
 * Track file-backend store — CRUD + LWW merge outcomes.
 *
 * Covers the CRUD round-trip + `mergeTracksFromSync` LWW outcomes plus the sync
 * side effects that make federation safe: base-hash seeding and conflict
 * journaling before overwrite. tmpdir-backed.
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
const cj = await import('../../lib/conflictJournal.js');

function reset() {
  rmSync(join(TEST_DATA_ROOT, 'tracks.json'), { force: true });
  rmSync(join(TEST_DATA_ROOT, 'sharing'), { recursive: true, force: true });
  rmSync(join(TEST_DATA_ROOT, 'conflict-journal'), { recursive: true, force: true });
  cj.__resetBaseHashCacheForTests();
}

const journalEntries = () => cj.conflictJournalStore().loadAll();

// chiptuneScore/chiptunePrompt default to sanitizeTrack's own untouched shape
// (null/'') so a fixture that omits them hashes identically to what
// mergeTracksFromSync actually persists (the fields participate in the
// content hash as of #2912 — see conflictJournal.js HASH_FIELDS).
const track = (id, extra = {}) => ({
  id, title: id, albumId: '', artistId: '', artist: '', lyrics: '', prompt: '',
  engine: '', modelId: '', durationSec: null, audioFilename: '',
  chiptuneScore: null, chiptunePrompt: '',
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

describe('tracks content hash', () => {
  it('excludes the render history (additive backfilled field stays base-hash compatible)', () => {
    // A pre-renders track and the same track carrying a render history must hash
    // identically, so backfilling renders onto existing synced tracks can't
    // invalidate stored base hashes and journal a false conflict on first edit.
    const base = track('track-h', { audioFilename: 'a.wav', engine: 'musicgen', durationSec: 12 });
    const withRenders = { ...base, renders: [
      { id: 'r1', audioFilename: 'a.wav', engine: 'musicgen', durationSec: 12, prompt: 'x', lyrics: '', createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'r2', audioFilename: 'b.wav', engine: 'audioldm2', durationSec: 20, prompt: 'y', lyrics: '', createdAt: '2026-01-02T00:00:00.000Z' },
    ] };
    expect(cj.contentHashForRecord('track', withRenders)).toBe(cj.contentHashForRecord('track', base));
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

  it('seeds the base hash on first insert of a remote track', async () => {
    const remote = track('track-2', { prompt: 'inserted' });
    expect(await cj.getSyncBaseHash('track', 'track-2')).toBeNull();
    await file.mergeTracksFromSync([remote]);
    expect(await cj.getSyncBaseHash('track', 'track-2'))
      .toBe(cj.contentHashForRecord('track', remote));
  });

  it('journals the losing local track on true 3-way divergence', async () => {
    const local = track('track-3', { prompt: 'local prompt', updatedAt: '2026-02-01T00:00:00.000Z' });
    await file.mergeTracksFromSync([local]);
    const base = track('track-3', { prompt: 'common prompt', updatedAt: '2026-01-01T00:00:00.000Z' });
    await cj.setSyncBaseHash('track', 'track-3', cj.contentHashForRecord('track', base));

    const remoteWinner = track('track-3', { prompt: 'remote prompt', updatedAt: '2026-03-01T00:00:00.000Z' });
    await file.mergeTracksFromSync([remoteWinner], { source: { via: 'peer-push', peerId: 'peer-A' } });

    const entry = (await journalEntries()).find((e) => e.recordKind === 'track' && e.recordId === 'track-3');
    expect(entry).toBeTruthy();
    expect(entry.source.peerId).toBe('peer-A');
    expect(entry.localSnapshot.prompt).toBe('local prompt');
    expect(entry.remoteSnapshot.prompt).toBe('remote prompt');
    expect((await file.getTrack('track-3')).prompt).toBe('remote prompt');
    expect(await cj.getSyncBaseHash('track', 'track-3'))
      .toBe(cj.contentHashForRecord('track', remoteWinner));
  });

  it('pruneTombstonedTracks evicts the base hash for a hard-pruned tombstone', async () => {
    await file.mergeTracksFromSync([
      track('track-dead-base', { deleted: true, deletedAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z' }),
    ]);
    expect(await cj.getSyncBaseHash('track', 'track-dead-base')).not.toBeNull();
    await file.pruneTombstonedTracks(Date.parse('2030-01-01T00:00:00.000Z'));
    expect(await cj.getSyncBaseHash('track', 'track-dead-base')).toBeNull();
  });
});
