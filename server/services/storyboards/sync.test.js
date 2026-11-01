import { afterAll, describe, expect, it, vi } from 'vitest';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';

vi.mock('../../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-storyboards-sync-') }));
vi.mock('../sharing/recordEvents.js', () => ({
  emitRecordUpdated: vi.fn(),
  emitRecordDeleted: vi.fn(),
  autoSubscribeRecordToAllPeers: vi.fn(() => Promise.resolve()),
}));

const { flushBaseHashes, __resetBaseHashCacheForTests } = await import('../../lib/conflictJournal.js');
const { sanitizeRecordForWire } = await import('../../lib/syncWire.js');
const { buildStoryboardAssetManifest } = await import('../sharing/peerSyncAssets.js');
const { PORTOS_SCHEMA_VERSIONS, RECORD_KIND_SCHEMA_CATEGORIES, compareSchemaVersions, scopeVersionDiff } = await import('../../lib/schemaVersions.js');
const events = await import('../sharing/recordEvents.js');
const svc = await import('./index.js');

afterAll(async () => {
  await flushBaseHashes();
  __resetBaseHashCacheForTests();
  cleanupTempDataRoots();
});

const later = (iso, ms) => new Date(Date.parse(iso) + ms).toISOString();
const asWire = (board, patch = {}) => ({ ...sanitizeRecordForWire('storyboard', board), ...patch });

async function boardWithArt() {
  const board = await svc.createStoryboard({ name: 'Wire Board' });
  const { beatId } = await svc.addBeat(board.id, { title: 'Opening' });
  const { panelId } = await svc.addPanel(board.id, beatId, { action: 'Wide of the gym doors' });
  await svc.addPanelTake(board.id, panelId, { source: 'upload', image: 'example.png' });
  await svc.addPanelTake(board.id, panelId, { source: 'sketch', sketchKey: 'sketch:abc-123' });
  return { id: board.id, panelId, beatId };
}

describe('storyboard federation', () => {
  it('declares its own version-gated sync category', () => {
    expect(PORTOS_SCHEMA_VERSIONS.storyboards).toBe(15);
    const older = { ...PORTOS_SCHEMA_VERSIONS, storyboards: 14 };
    expect(scopeVersionDiff(compareSchemaVersions(PORTOS_SCHEMA_VERSIONS, older), RECORD_KIND_SCHEMA_CATEGORIES.storyboard)).toEqual({
      compatible: false,
      ahead: [{ category: 'storyboards', senderV: 15, receiverV: 14 }],
      behind: [],
    });
  });

  it('emits a record event on create, edit and delete so subscribed peers get each revision', async () => {
    events.emitRecordUpdated.mockClear();
    events.emitRecordDeleted.mockClear();
    const { id } = await boardWithArt();
    expect(events.autoSubscribeRecordToAllPeers).toHaveBeenCalledWith('storyboard', id);
    expect(events.emitRecordUpdated).toHaveBeenCalledWith('storyboard', id);
    await svc.deleteStoryboard(id);
    expect(events.emitRecordDeleted).toHaveBeenCalledWith('storyboard', id);
  });

  it('merges a newer remote board whole and leaves an older one alone (LWW on updatedAt)', async () => {
    const { id } = await boardWithArt();
    const local = await svc.getStoryboard(id);
    const stale = asWire(local, { name: 'Stale Peer Edit', updatedAt: later(local.updatedAt, -60_000) });
    expect(await svc.mergeStoryboardsFromSync([stale])).toEqual({ applied: false, count: 0 });
    expect((await svc.getStoryboard(id)).name).toBe('Wire Board');

    const fresh = asWire(local, { name: 'Renamed On Peer', updatedAt: later(local.updatedAt, 60_000) });
    expect(await svc.mergeStoryboardsFromSync([fresh])).toEqual({ applied: true, count: 1 });
    expect((await svc.getStoryboard(id)).name).toBe('Renamed On Peer');
  });

  it('creates a board that only exists remotely; a repeated tombstone does not restart its grace period', async () => {
    const { id } = await boardWithArt();
    const wire = asWire(await svc.getStoryboard(id));
    await svc.deleteStoryboard(id);
    // The local tombstone is newer than the pushed live copy → the live copy loses.
    expect(await svc.mergeStoryboardsFromSync([wire])).toEqual({ applied: false, count: 0 });
    await expect(svc.getStoryboard(id)).rejects.toMatchObject({ status: 404 });

    const coldId = 'sb-00000000-0000-4000-8000-000000000001';
    const cold = { ...wire, id: coldId };
    expect(await svc.mergeStoryboardsFromSync([cold])).toEqual({ applied: true, count: 1 });
    expect((await svc.getStoryboard(coldId)).name).toBe('Wire Board');
    const tomb = { ...cold, deleted: true, deletedAt: later(cold.updatedAt, 1000), updatedAt: later(cold.updatedAt, 1000) };
    expect(await svc.mergeStoryboardsFromSync([tomb])).toEqual({ applied: true, count: 1 });
    expect(await svc.mergeStoryboardsFromSync([tomb])).toEqual({ applied: false, count: 0 });
    expect(await svc.listStoryboards()).not.toContainEqual(expect.objectContaining({ id: coldId }));
  });

  it('ships in-flight panel-maker state as idle and keeps sketch takes as references', async () => {
    const { id, panelId } = await boardWithArt();
    await svc.mutateStoryboard(id, (draft) => {
      const panel = draft.beats[0].panels.find((p) => p.id === panelId);
      panel.make = { nodes: { 'node-image': { status: 'running', jobIds: ['job-1'], runId: 'run-1' } } };
    });
    const wire = sanitizeRecordForWire('storyboard', await svc.getStoryboard(id));
    const state = wire.beats[0].panels[0].make.nodes['node-image'];
    expect(state).toMatchObject({ status: 'idle', jobIds: [], runId: 'run-1' });
    expect(wire.beats[0].panels[0].takes.map((t) => t.sketchKey ?? t.image)).toEqual(['example.png', 'sketch:abc-123']);
    // The local record is untouched.
    expect((await svc.getStoryboard(id)).beats[0].panels[0].make.nodes['node-image'].status).toBe('running');
  });

  it('advertises each gallery take image in the asset manifest and none for a sketch take', async () => {
    const { id } = await boardWithArt();
    const { referenceStoryboardAssetManifest } = await import('../sharing/peerSyncAssets.js');
    expect(referenceStoryboardAssetManifest(await svc.getStoryboard(id))).toEqual([
      expect.objectContaining({ kind: 'image', filename: 'example.png' }),
    ]);
    // No bytes on disk in this test → the hashed manifest drops the unreadable entry.
    expect(await buildStoryboardAssetManifest(await svc.getStoryboard(id))).toEqual([]);
  });

  it('prunes a tombstone only past the grace cutoff and restore brings a board back', async () => {
    const { id } = await boardWithArt();
    await svc.deleteStoryboard(id);
    expect(await svc.listStoryboardIdsForSync({ includeDeleted: true })).toContain(id);
    expect(await svc.listStoryboardIdsForSync()).not.toContain(id);
    expect(await svc.pruneTombstonedStoryboards(Date.now() - 86_400_000)).toEqual({ pruned: 0 });
    expect(await svc.listStoryboardIdsForSync({ includeDeleted: true })).toContain(id);

    const restored = await svc.restoreStoryboard(id, { name: 'Restored Name', beats: [] });
    expect(restored).toMatchObject({ name: 'Restored Name', deleted: false, beats: [] });
    expect(await svc.listStoryboardsForSync()).toContainEqual(expect.objectContaining({ id }));

    await svc.deleteStoryboard(id);
    expect((await svc.pruneTombstonedStoryboards(Date.now() + 86_400_000)).pruned).toBeGreaterThanOrEqual(1);
    expect(await svc.listStoryboardIdsForSync({ includeDeleted: true })).not.toContain(id);
    expect(await svc.restoreStoryboard(id, {})).toBeNull();
  });
});

describe('storyboard conflict restore', () => {
  it('restores plot, temp track and beat pins together', async () => {
    const board = await svc.createStoryboard({ name: 'Pinned' });
    const { beatId } = await svc.addBeat(board.id, { title: 'Opening' });
    const original = {
      ...(await svc.getStoryboard(board.id)),
      plot: 'The original plot',
      tempTrack: { filename: 'track.mp3', name: 'Demo', sections: [{ id: 'sec-1', label: 'Verse', at: 1 }], lines: [] },
    };
    original.beats = original.beats.map((beat) => (beat.id === beatId ? { ...beat, pin: 'sec-1' } : beat));
    // The peer's revision replaced plot and track; the pin lost its marker.
    await svc.restoreStoryboard(board.id, { plot: 'Peer plot', tempTrack: null, beats: original.beats });
    expect((await svc.getStoryboard(board.id)).beats[0].pin).toBeNull();

    const restored = await svc.restoreStoryboard(board.id, original);
    expect(restored.plot).toBe('The original plot');
    expect(restored.tempTrack.sections.map((s) => s.id)).toEqual(['sec-1']);
    expect(restored.beats[0].pin).toBe('sec-1');
  });
});
