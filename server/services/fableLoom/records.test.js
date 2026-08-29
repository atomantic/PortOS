import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Real per-suite tmpdir backing the fableloom/ collectionStore layout (the
// NODE_ENV=test escape-hatch backend). Wiped per test.
const TEST_DATA_ROOT = mkdtempSync(join(tmpdir(), 'fableloom-records-test-'));

vi.mock('../../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    PATHS: { ...actual.PATHS, data: TEST_DATA_ROOT },
  };
});

// createLoom/updateLoom validate soft refs through these services; default to
// "exists" so fixtures with a universeId/seriesId pass, and individual tests
// flip them to null to exercise the rejection.
const getUniverseMock = vi.hoisted(() => vi.fn(async (id) => ({ id })));
vi.mock('../universeBuilder.js', () => ({ getUniverse: getUniverseMock }));
const getSeriesMock = vi.hoisted(() => vi.fn(async (id) => ({ id })));
vi.mock('../pipeline/series.js', () => ({ getSeries: getSeriesMock }));

const {
  LOOM_LIMITS, addEpisode, addNode, addNodeTransition, attachNodeImage, attachNodeVideo, createLoom,
  deleteEpisode, deleteLoom, deleteNode, deleteNodeTransition, getLoom,
  listLooms, listLoomSummaries, mergeLoomsFromSync, pruneTombstonedLooms,
  restoreLoom, sanitizeLoom, updateEpisode, updateLoom,
  updateNode, updateNodeTransition,
} = await import('./records.js');
const { _resetFableLoomBackend } = await import('./store.js');
const conflictJournal = await import('../../lib/conflictJournal.js');
const { registerSubscriptionAdapter, __resetSubscriptionAdapter } = await import('../sharing/recordEvents.js');
const autoSubscribeMock = vi.fn(async () => []);

beforeEach(() => {
  rmSync(join(TEST_DATA_ROOT, 'fableloom'), { recursive: true, force: true });
  rmSync(join(TEST_DATA_ROOT, 'sharing'), { recursive: true, force: true });
  rmSync(join(TEST_DATA_ROOT, 'conflict-journal'), { recursive: true, force: true });
  conflictJournal.__resetBaseHashCacheForTests();
  _resetFableLoomBackend();
  getUniverseMock.mockClear().mockImplementation(async (id) => ({ id }));
  getSeriesMock.mockClear().mockImplementation(async (id) => ({ id }));
  autoSubscribeMock.mockClear();
  registerSubscriptionAdapter({ autoSubscribeRecordToAllPeers: autoSubscribeMock });
});

afterAll(() => {
  __resetSubscriptionAdapter();
  rmSync(TEST_DATA_ROOT, { recursive: true, force: true });
});

const makeLoom = (fields = {}) => createLoom({ name: 'The Hollow Crown', ...fields });

describe('sanitizeLoom', () => {
  it('rejects records without an id or name', () => {
    expect(sanitizeLoom(null)).toBeNull();
    expect(sanitizeLoom({ id: 'loom-1' })).toBeNull();
    expect(sanitizeLoom({ name: 'x' })).toBeNull();
  });

  it('drops malformed nodes and transitions but keeps authored dangling targets', () => {
    const loom = sanitizeLoom({
      id: 'loom-1',
      name: 'X',
      episodes: [{
        id: 'ep-1',
        startNodeId: 'n1',
        nodes: [
          { id: 'n1', title: 'A', transitions: [
            { id: 't1', targetNodeId: 'n-gone', intent: 'leap' }, // dangling: kept (validation surfaces it)
            { targetNodeId: '', intent: 'no target' },            // no target: dropped
            'garbage',
          ] },
          { title: 'no id — dropped' },
        ],
      }],
    });
    expect(loom.episodes[0].nodes).toHaveLength(1);
    expect(loom.episodes[0].nodes[0].transitions).toHaveLength(1);
    expect(loom.episodes[0].nodes[0].transitions[0].targetNodeId).toBe('n-gone');
  });

  it('repoints a missing startNodeId at the first node', () => {
    const loom = sanitizeLoom({
      id: 'loom-1',
      name: 'X',
      episodes: [{ id: 'ep-1', startNodeId: 'gone', nodes: [{ id: 'n1' }] }],
    });
    expect(loom.episodes[0].startNodeId).toBe('n1');
  });

  it('preserves single-cut video direction and camera movement metadata', () => {
    const loom = sanitizeLoom({
      id: 'loom-1',
      name: 'X',
      episodes: [{ id: 'ep-1', nodes: [{
        id: 'n1', videoPrompt: 'A figure turns as the camera arcs.', cameraMovement: 'cinematic-arc',
      }] }],
    });
    expect(loom.episodes[0].nodes[0]).toMatchObject({
      videoPrompt: 'A figure turns as the camera arcs.', cameraMovement: 'cinematic-arc', playbackMode: 'decision',
    });
  });

  it('keeps known playback modes and defaults legacy or invalid nodes to decision', () => {
    const loom = sanitizeLoom({
      id: 'loom-1', name: 'X', episodes: [{ id: 'ep-1', nodes: [
        { id: 'n1', playbackMode: 'cut' },
        { id: 'n2', playbackMode: 'unknown' },
        { id: 'n3' },
      ] }],
    });
    expect(loom.episodes[0].nodes.map((node) => node.playbackMode)).toEqual(['cut', 'decision', 'decision']);
  });

  it('defaults the scene format and keeps only a known one', () => {
    expect(sanitizeLoom({ id: 'loom-1', name: 'X' }).format).toBe('prose');
    expect(sanitizeLoom({ id: 'loom-1', name: 'X', format: 'teleplay' }).format).toBe('teleplay');
    expect(sanitizeLoom({ id: 'loom-1', name: 'X', format: 'haiku' }).format).toBe('prose');
  });

  it('preserves legacy protagonist behavior and defaults old scenes to a disconnected channel', () => {
    const loom = sanitizeLoom({
      id: 'loom-1', name: 'X', episodes: [{ id: 'ep-1', nodes: [{ id: 'n1' }] }],
    });
    expect(loom.participationMode).toBe('protagonist');
    expect(loom.audienceCommunicationMedium).toBe('');
    expect(loom.episodes[0].nodes[0].audienceConnection).toBe('disconnected');
  });

  it('keeps a partial play pin but collapses an all-empty one to null', () => {
    const pinned = sanitizeLoom({
      id: 'loom-1', name: 'X', playSettings: { providerId: '  claude  ', model: '', effort: null },
    });
    expect(pinned.playSettings).toEqual({ providerId: 'claude', model: null, effort: null });
    expect(sanitizeLoom({ id: 'loom-1', name: 'X', playSettings: { providerId: '' } }).playSettings).toBeNull();
    expect(sanitizeLoom({ id: 'loom-1', name: 'X' }).playSettings).toBeNull();
  });

  it('rejects unsafe image filenames', () => {
    const loom = sanitizeLoom({
      id: 'loom-1',
      name: 'X',
      episodes: [{ id: 'ep-1', nodes: [{ id: 'n1', image: '../../etc/passwd' }, { id: 'n2', image: 'render.png' }] }],
    });
    expect(loom.episodes[0].nodes[0].image).toBeNull();
    expect(loom.episodes[0].nodes[1].image).toBe('render.png');
  });

  it('sanitizes the series plan and clears episode references that no longer resolve', () => {
    const loom = sanitizeLoom({
      id: 'loom-1',
      name: 'X',
      episodes: [{ id: 'ep-1', number: 1 }],
      seriesPlan: {
        storyArc: 'A long transformation.',
        plotPoints: [{ title: 'Midpoint', description: 'The truth lands.', episodeId: 'ep-1' }],
        sideQuests: [{ title: 'Map', description: 'Find it.', status: 'bogus', startEpisodeId: 'gone', endEpisodeId: 'ep-1' }],
      },
    });
    expect(loom.seriesPlan.storyArc).toBe('A long transformation.');
    expect(loom.seriesPlan.plotPoints[0]).toMatchObject({ title: 'Midpoint', episodeId: 'ep-1' });
    expect(loom.seriesPlan.plotPoints[0].id).toMatch(/^plot-/);
    expect(loom.seriesPlan.sideQuests[0]).toMatchObject({ status: 'idea', startEpisodeId: null, endEpisodeId: 'ep-1' });
  });

  it('re-mints duplicate planning ids so each editable row remains addressable', () => {
    const loom = sanitizeLoom({
      id: 'loom-1', name: 'X',
      seriesPlan: {
        storyArc: '',
        plotPoints: [
          { id: 'plot-same', title: 'One', description: '' },
          { id: 'plot-same', title: 'Two', description: '' },
        ],
        sideQuests: [],
      },
    });
    expect(new Set(loom.seriesPlan.plotPoints.map((item) => item.id)).size).toBe(2);
  });
});

describe('loom CRUD', () => {
  it('creates, lists, patches, and deletes a loom', async () => {
    const loom = await makeLoom({ logline: 'A crown that remembers.', universeId: 'uni-1' });
    expect(loom.id).toMatch(/^loom-/);
    expect(loom.universeId).toBe('uni-1');
    expect(autoSubscribeMock).toHaveBeenCalledWith('fableLoom', loom.id);

    expect((await listLooms()).map((l) => l.id)).toEqual([loom.id]);

    const patched = await updateLoom(loom.id, { logline: 'New logline', seriesId: 'ser-9' });
    expect(patched.logline).toBe('New logline');
    expect(patched.seriesId).toBe('ser-9');
    // Absent keys preserve current values.
    expect(patched.universeId).toBe('uni-1');

    await deleteLoom(loom.id);
    expect(await getLoom(loom.id)).toBeNull();
    expect(await getLoom(loom.id, { includeDeleted: true })).toMatchObject({
      id: loom.id,
      deleted: true,
    });
    expect(await listLooms()).toEqual([]);
    expect(await listLooms({ includeDeleted: true })).toHaveLength(1);
  });

  it('merges peer records by updatedAt and lets tombstones converge', async () => {
    const local = await makeLoom({ name: 'Local draft' });
    const newer = {
      ...local,
      name: 'Peer draft',
      updatedAt: '2099-01-01T00:00:00.000Z',
    };
    expect(await mergeLoomsFromSync([newer])).toEqual({ applied: true, count: 1 });
    expect((await getLoom(local.id)).name).toBe('Peer draft');

    const stale = { ...newer, name: 'Stale peer draft', updatedAt: '2000-01-01T00:00:00.000Z' };
    expect(await mergeLoomsFromSync([stale])).toEqual({ applied: false, count: 0 });
    expect((await getLoom(local.id)).name).toBe('Peer draft');

    const tombstone = {
      ...newer,
      deleted: true,
      deletedAt: '2100-01-01T00:00:00.000Z',
      updatedAt: '2100-01-01T00:00:00.000Z',
    };
    expect(await mergeLoomsFromSync([tombstone])).toEqual({ applied: true, count: 1 });
    expect(await getLoom(local.id)).toBeNull();
  });

  it('journals divergent story edits and can restore the authored snapshot', async () => {
    const local = await makeLoom({ name: 'Local story', premise: 'Local premise' });
    const base = { ...local, name: 'Shared story', premise: 'Shared premise' };
    await conflictJournal.setSyncBaseHash(
      'fableLoom',
      local.id,
      conflictJournal.contentHashForRecord('fableLoom', base),
    );

    const remote = {
      ...local,
      name: 'Remote story',
      premise: 'Remote premise',
      updatedAt: '2099-01-01T00:00:00.000Z',
    };
    await mergeLoomsFromSync([remote], {
      source: { via: 'peer-push', peerId: 'peer-example' },
    });

    const entries = await conflictJournal.conflictJournalStore().loadAll();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      recordKind: 'fableLoom',
      recordId: local.id,
      source: { via: 'peer-push', peerId: 'peer-example' },
      localSnapshot: { name: 'Local story', premise: 'Local premise' },
      remoteSnapshot: { name: 'Remote story', premise: 'Remote premise' },
    });

    await restoreLoom(local.id, entries[0].localSnapshot);
    expect(await getLoom(local.id)).toMatchObject({
      name: 'Local story',
      premise: 'Local premise',
    });
  });

  it('hard-prunes only tombstones older than the safe federation cutoff', async () => {
    const loom = await makeLoom();
    await mergeLoomsFromSync([{
      ...loom,
      deleted: true,
      deletedAt: '2099-01-01T00:00:00.000Z',
      updatedAt: '2099-01-01T00:00:00.000Z',
    }]);
    expect(await conflictJournal.getSyncBaseHash('fableLoom', loom.id)).not.toBeNull();
    expect(await pruneTombstonedLooms(Date.parse('2999-01-01T00:00:00.000Z')))
      .toEqual({ pruned: 1 });
    expect(await getLoom(loom.id, { includeDeleted: true })).toBeNull();
    expect(await conflictJournal.getSyncBaseHash('fableLoom', loom.id)).toBeNull();
  });

  it('rejects creating a loom without a name', async () => {
    await expect(createLoom({ name: '   ' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('rejects refs to a missing universe or series at the service layer', async () => {
    getUniverseMock.mockResolvedValue(null);
    await expect(createLoom({ name: 'X', universeId: 'uni-gone' }))
      .rejects.toMatchObject({ code: 'INVALID_UNIVERSE' });

    const loom = await makeLoom();
    getSeriesMock.mockResolvedValue(null);
    await expect(updateLoom(loom.id, { seriesId: 'ser-gone' }))
      .rejects.toMatchObject({ code: 'INVALID_SERIES' });
    // Clearing a ref is always allowed — no lookup fires for null.
    const cleared = await updateLoom(loom.id, { seriesId: null });
    expect(cleared.seriesId).toBeNull();
  });
});

describe('format and play settings round-trip', () => {
  it('keeps them across an unrelated patch, and accepts them at create', async () => {
    const loom = await makeLoom({ format: 'teleplay', playSettings: { providerId: 'claude', model: 'opus', effort: null } });
    expect(loom.format).toBe('teleplay');
    expect(loom.playSettings).toEqual({ providerId: 'claude', model: 'opus', effort: null });

    // A rename must not silently reset the pin or the format — the exact drift
    // a PATCH_FIELDS / schema mismatch would produce.
    const renamed = await updateLoom(loom.id, { name: 'Renamed' });
    expect(renamed.format).toBe('teleplay');
    expect(renamed.playSettings).toEqual({ providerId: 'claude', model: 'opus', effort: null });

    const cleared = await updateLoom(loom.id, { playSettings: null });
    expect(cleared.playSettings).toBeNull();
    expect(cleared.format).toBe('teleplay');
  });
});

describe('audience participation round-trip', () => {
  it('requires a communication medium in helper mode and persists connection state', async () => {
    await expect(makeLoom({ participationMode: 'helper' }))
      .rejects.toMatchObject({ code: 'AUDIENCE_MEDIUM_REQUIRED' });

    let loom = await makeLoom({
      participationMode: 'helper',
      audienceCommunicationMedium: 'A hand-cranked radio carried by the protagonist.',
    });
    expect(loom).toMatchObject({
      participationMode: 'helper',
      audienceCommunicationMedium: 'A hand-cranked radio carried by the protagonist.',
    });
    loom = await addEpisode(loom.id, { title: 'Pilot' });
    loom = await addNode(loom.id, loom.episodes[0].id);
    expect(loom.episodes[0].nodes[0]).toMatchObject({
      audienceConnection: 'disconnected',
      playbackMode: 'cut',
    });
    loom = await addNode(loom.id, loom.episodes[0].id, { audienceConnection: 'connected' });
    expect(loom.episodes[0].nodes[1].audienceConnection).toBe('connected');

    await expect(updateLoom(loom.id, { audienceCommunicationMedium: '' }))
      .rejects.toMatchObject({ code: 'AUDIENCE_MEDIUM_REQUIRED' });
  });
});

describe('series plan round-trip', () => {
  it('persists ordered plot points and side quests without changing them on unrelated patches', async () => {
    let loom = await makeLoom();
    loom = await addEpisode(loom.id, { title: 'Pilot' });
    const episodeId = loom.episodes[0].id;
    const seriesPlan = {
      storyArc: 'The courier learns to lead.',
      plotPoints: [{ id: 'plot-1', title: 'Refusal', description: 'She turns away.', episodeId }],
      sideQuests: [{ id: 'quest-1', title: 'The map', description: 'A hidden route.', status: 'planned', startEpisodeId: episodeId, endEpisodeId: null }],
    };
    const planned = await updateLoom(loom.id, { seriesPlan });
    expect(planned.seriesPlan).toEqual(seriesPlan);
    const renamed = await updateLoom(loom.id, { name: 'Renamed' });
    expect(renamed.seriesPlan).toEqual(seriesPlan);
  });
});

describe('listLoomSummaries', () => {
  it('projects counts without the episode graphs', async () => {
    const loom = await makeLoom({ logline: 'A crown that remembers.' });
    const withEp = await addEpisode(loom.id, { title: 'Pilot' });
    const episodeId = withEp.episodes[0].id;
    await addNode(loom.id, episodeId, { title: 'A' });
    await addNode(loom.id, episodeId, { title: 'B', isEnding: true });

    const [summary] = await listLoomSummaries();
    expect(summary).toMatchObject({
      id: loom.id,
      name: 'The Hollow Crown',
      logline: 'A crown that remembers.',
      episodeCount: 1,
      sceneCount: 2,
      endingCount: 1,
    });
    expect(summary.episodes).toBeUndefined();
  });

  it('scopes the list to one series when seriesId is passed', async () => {
    const linked = await makeLoom({ name: 'Linked', seriesId: 'ser-1' });
    await makeLoom({ name: 'Other series', seriesId: 'ser-2' });
    await makeLoom({ name: 'Standalone' });

    const scoped = await listLoomSummaries({ seriesId: 'ser-1' });
    expect(scoped.map((l) => l.id)).toEqual([linked.id]);
    expect(await listLoomSummaries()).toHaveLength(3);
  });

  it('returns nothing (never throws) for a series id nothing links to', async () => {
    await makeLoom({ name: 'Standalone' });
    expect(await listLoomSummaries({ seriesId: 'ser-deleted' })).toEqual([]);
  });
});

describe('episodes', () => {
  it('adds episodes with sequential numbers and deletes them', async () => {
    const loom = await makeLoom();
    let updated = await addEpisode(loom.id, { title: 'Pilot' });
    updated = await addEpisode(loom.id, { title: 'Second' });
    expect(updated.episodes.map((e) => [e.number, e.title])).toEqual([[1, 'Pilot'], [2, 'Second']]);

    const [first] = updated.episodes;
    updated = await updateEpisode(loom.id, first.id, { synopsis: 'It begins.' });
    expect(updated.episodes[0].synopsis).toBe('It begins.');

    updated = await deleteEpisode(loom.id, first.id);
    expect(updated.episodes.map((e) => e.title)).toEqual(['Second']);
    await expect(deleteEpisode(loom.id, 'ep-missing')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('nodes and transitions', () => {
  const setup = async () => {
    const loom = await makeLoom();
    const withEp = await addEpisode(loom.id, { title: 'Pilot' });
    return { loomId: loom.id, episodeId: withEp.episodes[0].id };
  };

  it('first node becomes the start node; fromNodeId wires a branch', async () => {
    const { loomId, episodeId } = await setup();
    let updated = await addNode(loomId, episodeId, { title: 'Opening', prose: 'You wake.' });
    const ep = () => updated.episodes[0];
    const start = ep().nodes[0];
    expect(ep().startNodeId).toBe(start.id);

    updated = await addNode(loomId, episodeId, {
      title: 'The Door', fromNodeId: start.id, fromIntent: 'open the door',
    });
    const startNow = updated.episodes[0].nodes.find((n) => n.id === start.id);
    const door = updated.episodes[0].nodes.find((n) => n.title === 'The Door');
    expect(startNow.transitions).toHaveLength(1);
    expect(startNow.transitions[0]).toMatchObject({ targetNodeId: door.id, intent: 'open the door' });
  });

  it('patches node fields and replaces transitions', async () => {
    const { loomId, episodeId } = await setup();
    let updated = await addNode(loomId, episodeId, { title: 'A' });
    updated = await addNode(loomId, episodeId, { title: 'B' });
    const [a, b] = updated.episodes[0].nodes;

    updated = await updateNode(loomId, episodeId, a.id, {
      prose: 'New prose',
      isEnding: false,
      transitions: [{ targetNodeId: b.id, intent: 'press on', triggers: ['keep going'] }],
    });
    const aNow = updated.episodes[0].nodes.find((n) => n.id === a.id);
    expect(aNow.prose).toBe('New prose');
    expect(aNow.transitions[0]).toMatchObject({ targetNodeId: b.id, intent: 'press on', triggers: ['keep going'] });
    expect(aNow.transitions[0].id).toMatch(/^tr-/);
  });

  it('deleting a node strips inbound transitions and repoints the start', async () => {
    const { loomId, episodeId } = await setup();
    let updated = await addNode(loomId, episodeId, { title: 'A' });
    const a = updated.episodes[0].nodes[0];
    updated = await addNode(loomId, episodeId, { title: 'B', fromNodeId: a.id, fromIntent: 'go' });
    const b = updated.episodes[0].nodes.find((n) => n.title === 'B');

    updated = await deleteNode(loomId, episodeId, b.id);
    const aNow = updated.episodes[0].nodes.find((n) => n.id === a.id);
    expect(aNow.transitions).toEqual([]);

    updated = await deleteNode(loomId, episodeId, a.id);
    expect(updated.episodes[0].startNodeId).toBeNull();
  });
});

describe('transition sub-resources', () => {
  const setup = async () => {
    const created = await makeLoom();
    const withEp = await addEpisode(created.id, { title: 'Pilot' });
    const episodeId = withEp.episodes[0].id;
    let updated = await addNode(created.id, episodeId, { title: 'A' });
    updated = await addNode(created.id, episodeId, { title: 'B' });
    updated = await addNode(created.id, episodeId, { title: 'C' });
    const [a, b, c] = updated.episodes[0].nodes;
    return { loomId: created.id, episodeId, a, b, c };
  };
  const rowsOf = (record, episodeId, nodeId) => record.episodes.find((e) => e.id === episodeId)
    .nodes.find((n) => n.id === nodeId).transitions;

  it('adds one path and hands back the minted row', async () => {
    const { loomId, episodeId, a, b } = await setup();
    const { loom, transition } = await addNodeTransition(loomId, episodeId, a.id, {
      targetNodeId: b.id, intent: 'press on', triggers: ['keep going', ''],
    });
    expect(transition.id).toMatch(/^tr-/);
    expect(transition).toMatchObject({ targetNodeId: b.id, intent: 'press on', triggers: ['keep going'] });
    expect(rowsOf(loom, episodeId, a.id)).toEqual([transition]);
  });

  it('adding a second path leaves the first one alone', async () => {
    const { loomId, episodeId, a, b, c } = await setup();
    const first = (await addNodeTransition(loomId, episodeId, a.id, { targetNodeId: b.id, intent: 'left' })).transition;
    const second = (await addNodeTransition(loomId, episodeId, a.id, { targetNodeId: c.id, intent: 'right' })).transition;
    const rows = rowsOf(await getLoom(loomId), episodeId, a.id);
    expect(rows.map((t) => t.id)).toEqual([first.id, second.id]);
    expect(rows[0].intent).toBe('left');
  });

  it('patches only the provided fields and keeps the id', async () => {
    const { loomId, episodeId, a, b, c } = await setup();
    const { transition } = await addNodeTransition(loomId, episodeId, a.id, {
      targetNodeId: b.id, intent: 'press on', triggers: ['keep going'], description: 'the long way',
    });
    const updated = await updateNodeTransition(loomId, episodeId, a.id, transition.id, {
      intent: '', targetNodeId: c.id,
    });
    expect(rowsOf(updated, episodeId, a.id)[0]).toMatchObject({
      id: transition.id,
      targetNodeId: c.id,
      intent: '',
      triggers: ['keep going'],
      description: 'the long way',
    });
  });

  it('deletes one path without touching its siblings', async () => {
    const { loomId, episodeId, a, b, c } = await setup();
    const doomed = (await addNodeTransition(loomId, episodeId, a.id, { targetNodeId: b.id, intent: 'left' })).transition;
    const kept = (await addNodeTransition(loomId, episodeId, a.id, { targetNodeId: c.id, intent: 'right' })).transition;
    const updated = await deleteNodeTransition(loomId, episodeId, a.id, doomed.id);
    expect(rowsOf(updated, episodeId, a.id).map((t) => t.id)).toEqual([kept.id]);
  });

  it('404s on an unknown transition and refuses to exceed the cap', async () => {
    const { loomId, episodeId, a, b } = await setup();
    await expect(updateNodeTransition(loomId, episodeId, a.id, 'tr-nope', { intent: 'x' }))
      .rejects.toMatchObject({ status: 404 });
    await expect(deleteNodeTransition(loomId, episodeId, a.id, 'tr-nope'))
      .rejects.toMatchObject({ status: 404 });

    for (let i = 0; i < LOOM_LIMITS.TRANSITIONS_MAX; i += 1) {
      await addNodeTransition(loomId, episodeId, a.id, { targetNodeId: b.id, intent: `path ${i}` });
    }
    await expect(addNodeTransition(loomId, episodeId, a.id, { targetNodeId: b.id, intent: 'one too many' }))
      .rejects.toMatchObject({ status: 400, code: 'LIMIT_REACHED' });
  });
});

describe('attachNodeImage', () => {
  it('files a completed render onto its node', async () => {
    const loom = await makeLoom();
    let updated = await addEpisode(loom.id, {});
    const episodeId = updated.episodes[0].id;
    updated = await addNode(loom.id, episodeId, { title: 'A' });
    const node = updated.episodes[0].nodes[0];

    const attached = await attachNodeImage(loom.id, episodeId, node.id, { filename: 'job-1.png', jobId: 'job-1' });
    expect(attached).toMatchObject({ id: node.id, image: 'job-1.png', imageJobId: 'job-1' });
    expect((await getLoom(loom.id)).episodes[0].nodes[0].image).toBe('job-1.png');
  });

  it('returns null (no throw) when the target is gone or the filename is unsafe', async () => {
    const loom = await makeLoom();
    const updated = await addEpisode(loom.id, {});
    const episodeId = updated.episodes[0].id;
    expect(await attachNodeImage(loom.id, episodeId, 'node-gone', { filename: 'x.png' })).toBeNull();
    expect(await attachNodeImage(loom.id, episodeId, 'node-gone', { filename: '../x.png' })).toBeNull();
    expect(await attachNodeImage('loom-missing', episodeId, 'node-gone', { filename: 'x.png' })).toBeNull();
  });
});

describe('attachNodeVideo', () => {
  it('files a completed video history id onto its node', async () => {
    const loom = await makeLoom();
    let updated = await addEpisode(loom.id, {});
    const episodeId = updated.episodes[0].id;
    updated = await addNode(loom.id, episodeId, { title: 'A' });
    const node = updated.episodes[0].nodes[0];

    const attached = await attachNodeVideo(loom.id, episodeId, node.id, { videoHistoryId: 'video-1' });
    expect(attached).toMatchObject({ id: node.id, videoHistoryId: 'video-1' });
    expect((await getLoom(loom.id)).episodes[0].nodes[0].videoHistoryId).toBe('video-1');
  });

  it('returns null when the target or history id is unsafe', async () => {
    const loom = await makeLoom();
    const updated = await addEpisode(loom.id, {});
    const episodeId = updated.episodes[0].id;
    expect(await attachNodeVideo(loom.id, episodeId, 'node-gone', { videoHistoryId: '../video' })).toBeNull();
    expect(await attachNodeVideo(loom.id, episodeId, 'node-gone', { videoHistoryId: 'video-1' })).toBeNull();
  });
});
