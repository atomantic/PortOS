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
const { sanitizeStoryboard } = await import('../../lib/storyboardRecord.js');
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
    const older = { ...PORTOS_SCHEMA_VERSIONS, storyboards: PORTOS_SCHEMA_VERSIONS.storyboards - 1 };
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
    const inventory = await svc.listStoryboardsForIntegrity();
    expect(referenceStoryboardAssetManifest(inventory.find((board) => board.id === id))).toEqual([
      expect.objectContaining({ kind: 'image', filename: 'example.png' }),
    ]);
  });

  it('prunes a tombstone only past the grace cutoff and restore brings a board back', async () => {
    const { id } = await boardWithArt();
    await svc.deleteStoryboard(id);
    expect(await svc.listStoryboardsForIntegrity()).toContainEqual(expect.objectContaining({ id, deleted: true }));
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

describe('storyboard merge from an older sender', () => {
  const TRACK = { filename: 'track.mp3', name: 'Demo', sections: [{ id: 'sec-1', label: 'Verse', at: 1 }], lines: [] };

  // A live board using every field an older sanitizer could not emit.
  async function richBoard() {
    const board = await svc.createStoryboard({ name: 'Rich Board' });
    const { beatId: openId } = await svc.addBeat(board.id, { title: 'Cold open' });
    const { beatId: verseId } = await svc.addBeat(board.id, { title: 'Verse' });
    const { panelId } = await svc.addPanel(board.id, verseId, { action: 'Wide of the gym doors' });
    const { board: local } = await svc.mutateStoryboard(board.id, (draft) => {
      draft.plot = 'The original plot';
      draft.tempTrack = TRACK;
      const [open, verse] = draft.beats;
      open.beforeSong = true;
      verse.pin = 'sec-1';
      Object.assign(verse.panels[0], {
        castIds: ['char-a1'],
        environmentIds: ['place-b1'],
        linkMedia: { 'char-a1': 'pick.png' },
        setShot: { environmentId: 'place-b1', shotId: 'wide' },
        move: 'push-in',
      });
    });
    return { local, openId, verseId, panelId };
  }

  // The local board as an older peer would push it: newer, with `omit` keys
  // missing from the board, every beat and every panel, and the panel edited.
  function olderPush(local, { board = [], beat = [], panel = [] } = {}) {
    const drop = (entry, keys) => Object.fromEntries(Object.entries(entry).filter(([key]) => !keys.includes(key)));
    const wire = asWire(local, { updatedAt: later(local.updatedAt, 60_000) });
    return {
      ...drop(wire, board),
      beats: wire.beats.map((b) => ({
        ...drop(b, beat),
        panels: b.panels.map((p) => ({ ...drop(p, panel), action: 'Edited on the older peer' })),
      })),
    };
  }

  const panelOf = (board, beatId) => board.beats.find((b) => b.id === beatId).panels[0];

  it('keeps linkMedia a version-14 sender omits and applies its other panel edits', async () => {
    const { local, verseId } = await richBoard();
    expect(await svc.mergeStoryboardsFromSync([olderPush(local, { panel: ['linkMedia'] })], { senderSchemaVersions: { storyboards: 14 } }))
      .toEqual({ applied: true, count: 1 });
    const panel = panelOf(await svc.getStoryboard(local.id), verseId);
    expect(panel.linkMedia).toEqual({ 'char-a1': 'pick.png' });
    expect(panel.action).toBe('Edited on the older peer');
  });

  it('clears linkMedia a version-15 sender omits', async () => {
    const { local, verseId } = await richBoard();
    await svc.mergeStoryboardsFromSync([olderPush(local, { panel: ['linkMedia'] })], { senderSchemaVersions: { storyboards: 15 } });
    expect(panelOf(await svc.getStoryboard(local.id), verseId)).not.toHaveProperty('linkMedia');
  });

  it('keeps beforeSong a sender below version 12 omits; a version-12 sender clears it', async () => {
    const first = await richBoard();
    await svc.mergeStoryboardsFromSync([olderPush(first.local, { beat: ['beforeSong'] })], { senderSchemaVersions: { storyboards: 11 } });
    expect((await svc.getStoryboard(first.local.id)).beats.find((b) => b.id === first.openId).beforeSong).toBe(true);

    const second = await richBoard();
    await svc.mergeStoryboardsFromSync([olderPush(second.local, { beat: ['beforeSong'] })], { senderSchemaVersions: { storyboards: 12 } });
    expect((await svc.getStoryboard(second.local.id)).beats.find((b) => b.id === second.openId)).not.toHaveProperty('beforeSong');
  });

  it('keeps setShot, tempTrack, plot, beat pin and panel move a raw remote omits; an explicit null clears them', async () => {
    const omitted = await richBoard();
    const push = olderPush(omitted.local, { board: ['tempTrack', 'plot'], beat: ['pin'], panel: ['setShot', 'move'] });
    await svc.mergeStoryboardsFromSync([push], { senderSchemaVersions: { storyboards: 15 } });
    const kept = await svc.getStoryboard(omitted.local.id);
    expect(kept).toMatchObject({ plot: 'The original plot', tempTrack: TRACK });
    expect(kept.beats.find((b) => b.id === omitted.verseId).pin).toBe('sec-1');
    expect(panelOf(kept, omitted.verseId)).toMatchObject({
      setShot: { environmentId: 'place-b1', shotId: 'wide' }, move: 'push-in', action: 'Edited on the older peer',
    });

    const nulled = await richBoard();
    const clear = olderPush(nulled.local);
    Object.assign(clear, { tempTrack: null, plot: null });
    for (const beat of clear.beats) {
      beat.pin = null;
      for (const panel of beat.panels) Object.assign(panel, { setShot: null, move: null });
    }
    await svc.mergeStoryboardsFromSync([clear], { senderSchemaVersions: { storyboards: 15 } });
    const cleared = await svc.getStoryboard(nulled.local.id);
    expect(cleared).toMatchObject({ plot: '', tempTrack: null });
    expect(cleared.beats.find((b) => b.id === nulled.verseId).pin).toBeNull();
    expect(panelOf(cleared, nulled.verseId)).toMatchObject({ setShot: null, move: null });
  });

  it('restores nothing onto a remote tombstone', async () => {
    const { local, verseId } = await richBoard();
    const push = olderPush(local, { board: ['tempTrack', 'plot'], beat: ['pin', 'beforeSong'], panel: ['linkMedia', 'setShot', 'move'] });
    const tomb = { ...push, deleted: true, deletedAt: push.updatedAt };
    expect(await svc.mergeStoryboardsFromSync([tomb], { senderSchemaVersions: { storyboards: 11 } })).toEqual({ applied: true, count: 1 });
    const stored = await svc.getStoryboardForSync(local.id);
    expect(stored).toMatchObject({ deleted: true, plot: '', tempTrack: null });
    expect(stored.beats.find((b) => b.id === verseId).pin).toBeNull();
    expect(panelOf(stored, verseId)).toMatchObject({ setShot: null, move: null });
    expect(panelOf(stored, verseId)).not.toHaveProperty('linkMedia');
  });

  it('stores a same-version full board exactly as sent', async () => {
    const { local } = await richBoard();
    const wire = asWire(local, { name: 'Renamed On Peer', updatedAt: later(local.updatedAt, 60_000) });
    delete wire.beats[0].beforeSong;
    await svc.mergeStoryboardsFromSync([wire], { senderSchemaVersions: { storyboards: PORTOS_SCHEMA_VERSIONS.storyboards } });
    expect(await svc.getStoryboardForSync(local.id)).toEqual(sanitizeStoryboard(wire));
  });
});
