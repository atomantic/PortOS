import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { makePathsProxy, mockNoPeerSync } from '../../lib/mockPathsDataRoot.js';

const root = mkdtempSync(join(tmpdir(), 'wr-bible-sync-'));
vi.mock('../../lib/fileUtils.js', async (original) => makePathsProxy(await original(), { dataRoot: () => root }));
vi.mock('../instances.js', () => ({ getPeers: vi.fn(async () => [{ instanceId: 'peer-a', address: '192.0.2.10', port: 5555 }]) }));
vi.mock('../sharing/peerSync.js', () => mockNoPeerSync());
vi.mock('../../lib/peerHttpClient.js', () => ({ peerFetch: vi.fn() }));
const { peerFetch } = await import('../../lib/peerHttpClient.js');
const { pullMissingWorkBibles } = await import('../sharing/peerSyncAssets.js');
const { buildWorkBibleManifest, diffWorkBibleManifest, workBiblePath } = await import('./bibleSync.js');
const { mergeWorksFromSync } = await import('./sync.js');
const { conflictJournalStore } = await import('../../lib/conflictJournal.js');
const { resolveConflict } = await import('../conflictJournalResolver.js');
const { listCharacters } = await import('./characters.js');
const { PORTOS_SCHEMA_VERSIONS } = await import('../../lib/schemaVersions.js');
const WORK = 'wr-work-aaaa';
const doc = (updatedAt, name = 'Example hero') => ({ characters: [{ id: 'wr-char-bbbb', name, psychology: { theoryOfControl: 'Planning brings safety' }, evolution: { outcome: 'full-change', stages: [{ stageId: 'final-proof', characterChoice: 'Trust the crew' }] } }], updatedAt });
function write(kind, value) {
  const path = workBiblePath(WORK, kind);
  mkdirSync(join(root, 'writers-room', 'works', WORK), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}
function serve(value, duringFetch) {
  const bytes = Buffer.from(JSON.stringify(value));
  vi.mocked(peerFetch).mockImplementation(async () => {
    duringFetch?.();
    return { ok: true, headers: new Headers({ 'content-length': String(bytes.length) }), arrayBuffer: async () => bytes };
  });
}
beforeEach(async () => {
  rmSync(join(root, 'writers-room'), { force: true, recursive: true });
  rmSync(join(root, 'conflict-journal'), { force: true, recursive: true });
  vi.clearAllMocks();
  await mergeWorksFromSync([{ id: WORK, title: 'Example work', drafts: [], updatedAt: '2026-01-01T00:00:00Z' }]);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('bible asset delivery', () => {
  it('ships only authored sibling files, pulls missing files, and preserves full cast fields for readers', async () => {
    const remote = doc('2026-02-01T00:00:00Z');
    write('character', remote);
    write('place', { places: [], updatedAt: remote.updatedAt });
    write('object', { objects: [], updatedAt: remote.updatedAt });
    mkdirSync(join(root, 'writers-room', 'works', WORK, 'analysis'), { recursive: true });
    writeFileSync(join(root, 'writers-room', 'works', WORK, 'analysis', 'private.json'), '{}');
    const manifest = await buildWorkBibleManifest({ id: WORK });
    expect(manifest.map((e) => e.kind)).toEqual(['character', 'place', 'object']);
    expect(PORTOS_SCHEMA_VERSIONS.writersRoomWorks).toBe(1);
    rmSync(workBiblePath(WORK, 'character'));
    const missing = await diffWorkBibleManifest(manifest);
    expect(missing).toEqual([manifest[0]]);
    serve(remote);
    await pullMissingWorkBibles('peer-a', missing);
    expect(JSON.parse(readFileSync(workBiblePath(WORK, 'character')))).toEqual(remote);
    expect((await listCharacters(WORK))[0].psychology.theoryOfControl).toBe('Planning brings safety');
    expect((await listCharacters(WORK))[0].evolution.stages[0].characterChoice).toBe('Trust the crew');
    expect(await diffWorkBibleManifest(manifest)).toEqual([]);
  });

  it('keeps newer local files, omission, and an edit that lands during download', async () => {
    const remote = doc('2026-02-01T00:00:00Z');
    write('character', remote);
    const manifest = await buildWorkBibleManifest({ id: WORK });
    const local = doc('2026-03-01T00:00:00Z', 'Local hero');
    write('character', local);
    expect(await diffWorkBibleManifest(manifest)).toEqual([]);
    expect(await diffWorkBibleManifest(undefined)).toEqual([]);
    write('character', doc('2026-01-01T00:00:00Z'));
    const missing = await diffWorkBibleManifest(manifest);
    serve(remote, () => write('character', local));
    await pullMissingWorkBibles('peer-a', missing);
    expect(JSON.parse(readFileSync(workBiblePath(WORK, 'character')))).toEqual(local);
  });

  it('keeps a corrupt download retryable and archives an overwritten file for restore', async () => {
    const remote = doc('2026-02-01T00:00:00Z');
    write('character', remote);
    const manifest = await buildWorkBibleManifest({ id: WORK });
    const local = doc('2026-01-01T00:00:00Z', 'Local hero');
    write('character', local);
    serve(doc(remote.updatedAt, 'Wrong bytes'));
    await pullMissingWorkBibles('peer-a', await diffWorkBibleManifest(manifest));
    expect(await diffWorkBibleManifest(manifest)).toEqual(manifest);
    serve(remote);
    await pullMissingWorkBibles('peer-a', manifest);
    const entries = await conflictJournalStore().loadAll();
    expect(entries).toHaveLength(1);
    expect(entries[0].localSnapshot).toEqual(local);
    await resolveConflict(entries[0].id, { action: 'restore-all' });
    expect((await listCharacters(WORK))[0].name).toBe('Local hero');
  });

  it('rejects traversal, analysis kinds, and corrupted incumbent files', async () => {
    const remote = doc('2026-02-01T00:00:00Z');
    write('character', remote);
    const manifest = await buildWorkBibleManifest({ id: WORK });
    expect(await diffWorkBibleManifest([{ ...manifest[0], workId: '../other' }, { ...manifest[0], kind: 'analysis' }])).toEqual([]);
    writeFileSync(workBiblePath(WORK, 'character'), '{');
    await expect(diffWorkBibleManifest(manifest)).rejects.toThrow();
    expect(await buildWorkBibleManifest({ id: WORK })).toEqual([]);
    expect(readFileSync(workBiblePath(WORK, 'character'), 'utf8')).toBe('{');
    const errors = [];
    const place = { workId: WORK, kind: 'place', sha256: 'c'.repeat(64), updatedAt: remote.updatedAt };
    expect(await diffWorkBibleManifest([...manifest, place], { onError: (err) => errors.push(err) })).toEqual([place]);
    expect(errors).toHaveLength(1);
    write('character', doc('2026-02-01'));
    expect(await buildWorkBibleManifest({ id: WORK })).toEqual([]);
  });
});
