/**
 * Author file-backend federation merge — conflict-journal + base-hash wiring.
 *
 * The `authors/db.test.js` round-trip pins the LWW outcomes (insert / newer-wins
 * / tombstone / malformed) against a real Postgres. This suite covers the
 * author-specific sync side effects that the shared mediaCollection tests do
 * NOT cover for authors — `setSyncBaseHash` seeding on insert and
 * `maybeJournalBeforeOverwrite` archiving the losing local version on a true
 * 3-way divergence — using the file backend against a tmpdir so it runs in the
 * normal (non-DB) suite without touching real `data/`.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// tmpdir backing data/authors.json + data/sharing/ (base hashes) +
// data/conflict-journal/. The fileUtils mock points PATHS.data here; everything
// else uses the real impl so atomicWrite/readJSONFile operate on a real tree.
const TEST_DATA_ROOT = mkdtempSync(join(tmpdir(), 'authors-file-test-'));

vi.mock('../../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, PATHS: { ...actual.PATHS, data: TEST_DATA_ROOT } };
});

const file = await import('./file.js');
const cj = await import('../../lib/conflictJournal.js');

function reset() {
  rmSync(join(TEST_DATA_ROOT, 'authors.json'), { force: true });
  rmSync(join(TEST_DATA_ROOT, 'sharing'), { recursive: true, force: true });
  rmSync(join(TEST_DATA_ROOT, 'conflict-journal'), { recursive: true, force: true });
  cj.__resetBaseHashCacheForTests();
}

const journalEntries = () => cj.conflictJournalStore().loadAll();

const author = (id, extra = {}) => ({
  id, name: id, writingStyle: '', bio: '', physicalDescription: '',
  headshotStyle: '', headshotImageUrl: '',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  deleted: false, deletedAt: null, ...extra,
});

beforeEach(reset);
afterAll(() => rmSync(TEST_DATA_ROOT, { recursive: true, force: true }));

describe('authors file backend — federation merge side effects', () => {
  it('seeds the base hash on first insert of a remote author', async () => {
    const remote = author('auth-1', { bio: 'inserted' });
    expect(await cj.getSyncBaseHash('author', 'auth-1')).toBeNull();
    await file.mergeAuthorsFromSync([remote]);
    expect(await cj.getSyncBaseHash('author', 'auth-1'))
      .toBe(cj.contentHashForRecord('author', remote));
  });

  it('journals the losing local version on a true 3-way divergence (both diverged from base)', async () => {
    // Persist a local record, then pin the synced base hash to a THIRD,
    // different version — so both the stored local and the incoming remote
    // differ from base (the 3-way-divergence precondition the journal detects).
    const local = author('auth-1', { bio: 'local edit', updatedAt: '2026-02-01T00:00:00.000Z' });
    await file.mergeAuthorsFromSync([local]); // inserts local + seeds base = local's hash
    const base = author('auth-1', { bio: 'common ancestor', updatedAt: '2026-01-01T00:00:00.000Z' });
    await cj.setSyncBaseHash('author', 'auth-1', cj.contentHashForRecord('author', base));

    const remoteWinner = author('auth-1', { bio: 'remote edit', updatedAt: '2026-03-01T00:00:00.000Z' });
    await file.mergeAuthorsFromSync([remoteWinner], { source: { via: 'peer-push', peerId: 'peer-A' } });

    const authorEntry = (await journalEntries()).find((e) => e.recordKind === 'author' && e.recordId === 'auth-1');
    expect(authorEntry).toBeTruthy();
    expect(authorEntry.source.peerId).toBe('peer-A');
    expect(authorEntry.localSnapshot.bio).toBe('local edit');   // the archived loser
    expect(authorEntry.remoteSnapshot.bio).toBe('remote edit'); // the winner
    // The remote winner became the persisted record + advanced the base hash.
    expect((await file.getAuthor('auth-1')).bio).toBe('remote edit');
    expect(await cj.getSyncBaseHash('author', 'auth-1'))
      .toBe(cj.contentHashForRecord('author', remoteWinner));
  });

  it('does NOT journal when local wins (older remote loses, base unchanged)', async () => {
    const base = author('auth-1', { bio: 'local', updatedAt: '2026-05-01T00:00:00.000Z' });
    await file.mergeAuthorsFromSync([base]);
    const baseHash = await cj.getSyncBaseHash('author', 'auth-1');
    const older = author('auth-1', { bio: 'stale remote', updatedAt: '2020-01-01T00:00:00.000Z' });
    const res = await file.mergeAuthorsFromSync([older], { source: { via: 'peer-push', peerId: 'peer-A' } });
    expect(res).toEqual({ applied: false, count: 0 });
    expect((await file.getAuthor('auth-1')).bio).toBe('local');
    // No new journal entry, base hash unchanged (local kept, nothing lost).
    expect((await journalEntries()).filter((e) => e.kind === 'author')).toHaveLength(0);
    expect(await cj.getSyncBaseHash('author', 'auth-1')).toBe(baseHash);
  });

  it('pruneTombstonedAuthors evicts the base hash for a hard-pruned tombstone', async () => {
    await file.mergeAuthorsFromSync([
      author('auth-dead', { deleted: true, deletedAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z' }),
    ]);
    expect(await cj.getSyncBaseHash('author', 'auth-dead')).not.toBeNull();
    await file.pruneTombstonedAuthors(Date.parse('2030-01-01T00:00:00.000Z'));
    expect(await cj.getSyncBaseHash('author', 'auth-dead')).toBeNull();
  });
});
