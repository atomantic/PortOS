/**
 * Music Video dispatcher — peer-sync record-event wiring (#1770). Asserts the
 * dispatcher fires the recordEvents emits (announce on create, updated on every
 * structural mutator, deleted on tombstone) so a project federates after a local
 * edit. The backend is exercised for real via the file backend (NODE_ENV=test);
 * only recordEvents is mocked so we can spy on the emits.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const TEST_DATA_ROOT = mkdtempSync(join(tmpdir(), 'mv-projects-dispatch-test-'));

vi.mock('../../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, PATHS: { ...actual.PATHS, data: TEST_DATA_ROOT } };
});

const emitRecordUpdated = vi.fn();
const emitRecordDeleted = vi.fn();
const autoSubscribeRecordToAllPeers = vi.fn(async () => {});
vi.mock('../sharing/recordEvents.js', () => ({
  emitRecordUpdated: (...a) => emitRecordUpdated(...a),
  emitRecordDeleted: (...a) => emitRecordDeleted(...a),
  autoSubscribeRecordToAllPeers: (...a) => autoSubscribeRecordToAllPeers(...a),
}));

// Settings feed the create-time video-backend seed (#3231 Phase 4) — mocked so
// each test controls the pin ladder deterministically.
const getSettings = vi.fn(async () => ({}));
vi.mock('../settings.js', () => ({ getSettings: (...a) => getSettings(...a) }));

const getTrack = vi.fn(async () => null);
const updateTrack = vi.fn(async () => ({}));
vi.mock('../tracks/index.js', () => ({ getTrack: (...a) => getTrack(...a), updateTrack: (...a) => updateTrack(...a) }));
const readSunoSongStyle = vi.fn();
vi.mock('../trackSunoImport.js', () => ({ readSunoSongStyle: (...a) => readSunoSongStyle(...a) }));

const projects = await import('./projects.js');

function reset() {
  rmSync(join(TEST_DATA_ROOT, 'music-video-projects.json'), { force: true });
  writeFileSync(join(TEST_DATA_ROOT, 'video-history.json'), JSON.stringify(
    ['run-clip', 'new-clip', 'clip-1', 'clip-2', 'approved-clip', 'alternate-clip', 'keep-clip', 'candidate-clip', 'clip-a', 'clip-b']
      .map(id => ({ id, filename: `${id}.mp4` })),
  ));
  emitRecordUpdated.mockClear();
  emitRecordDeleted.mockClear();
  autoSubscribeRecordToAllPeers.mockClear();
  getSettings.mockClear();
  getSettings.mockResolvedValue({});
  getTrack.mockClear();
  getTrack.mockResolvedValue(null);
}
beforeEach(reset);
afterAll(() => rmSync(TEST_DATA_ROOT, { recursive: true, force: true }));

describe('musicVideo dispatcher — record-event emit (#1770)', () => {
  it('announces a new project (emit updated + auto-subscribe peers)', async () => {
    const p = await projects.createProject({ name: 'A' });
    expect(emitRecordUpdated).toHaveBeenCalledWith('musicVideoProject', p.id);
    expect(autoSubscribeRecordToAllPeers).toHaveBeenCalledWith('musicVideoProject', p.id);
  });

  it('emits updated on metadata edits, analysis, and every scene mutator', async () => {
    const p = await projects.createProject({ name: 'A' });
    emitRecordUpdated.mockClear();

    await projects.updateProject(p.id, { name: 'B' });
    await projects.setProjectAnalysis(p.id, { bpm: 120, beats: [0], downbeats: [0], sections: [], durationSec: 5 });
    const s1 = await projects.addProjectScene(p.id, { prompt: 'one' });
    const s2 = await projects.addProjectScene(p.id, { prompt: 'two' });
    await projects.updateScene(p.id, s1.sceneId, { prompt: 'one-edited' });
    await projects.reorderProjectScenes(p.id, [s2.sceneId, s1.sceneId]);
    await projects.deleteScene(p.id, s2.sceneId);

    // update + analysis + 2 add + update + reorder + deleteScene = 7 structural emits
    expect(emitRecordUpdated).toHaveBeenCalledTimes(7);
    expect(emitRecordUpdated.mock.calls.every(([kind, id]) => kind === 'musicVideoProject' && id === p.id)).toBe(true);
    expect(emitRecordDeleted).not.toHaveBeenCalled();
  });

  it('addProjectScenes bulk-appends, emits exactly one updated (not one per scene), and returns the freshly-persisted project', async () => {
    const p = await projects.createProject({ name: 'A' });
    emitRecordUpdated.mockClear();

    const { project, scenes } = await projects.addProjectScenes(p.id, [{ prompt: 'one' }, { prompt: 'two' }, { prompt: 'three' }]);

    expect(scenes).toHaveLength(3);
    expect(scenes.map((s) => s.order)).toEqual([0, 1, 2]);
    expect(project.scenes).toHaveLength(3);
    expect(emitRecordUpdated).toHaveBeenCalledTimes(1);
    expect(emitRecordUpdated).toHaveBeenCalledWith('musicVideoProject', p.id);

    const fresh = await projects.getProject(p.id);
    expect(fresh.scenes).toHaveLength(3);
  });

  it('emits deleted on soft-delete (tombstone federates)', async () => {
    const p = await projects.createProject({ name: 'A' });
    emitRecordDeleted.mockClear();
    await projects.deleteProject(p.id);
    expect(emitRecordDeleted).toHaveBeenCalledWith('musicVideoProject', p.id);
  });

  it('re-exports the federation merge/prune helpers for peerSync + GC', async () => {
    expect(typeof projects.mergeProjectsFromSync).toBe('function');
    expect(typeof projects.pruneTombstonedProjects).toBe('function');
    expect(typeof projects.listProjectIds).toBe('function');
  });
});

describe('create-time video-backend seeding (#3231 Phase 4)', () => {
  const grokPinned = (pins) => ({
    imageGen: { grok: { enabled: true } },
    ...pins,
  });

  it('seeds videoSettings.backend from renderDefaults[music-video].videoMode', async () => {
    getSettings.mockResolvedValue(grokPinned({ renderDefaults: { 'music-video': { videoMode: 'grok' } } }));
    const p = await projects.createProject({ name: 'A' });
    expect(p.videoSettings.backend).toBe('grok');
  });

  it('seeds from settings.videoGen.mode when no target pin exists', async () => {
    getSettings.mockResolvedValue(grokPinned({ videoGen: { mode: 'grok' } }));
    const p = await projects.createProject({ name: 'A' });
    expect(p.videoSettings.backend).toBe('grok');
  });

  it('an explicit input backend wins over every pin', async () => {
    getSettings.mockResolvedValue(grokPinned({ videoGen: { mode: 'grok' } }));
    const p = await projects.createProject({ name: 'A', videoSettings: { backend: 'local' } });
    expect(p.videoSettings.backend).toBe('local');
  });

  it('defaults to local with no pin anywhere — and a disabled grok pin degrades', async () => {
    const p1 = await projects.createProject({ name: 'A' });
    expect(p1.videoSettings.backend).toBe('local');
    // Pin present but the grok toggle is off → usability gate degrades to local.
    getSettings.mockResolvedValue({ renderDefaults: { 'music-video': { videoMode: 'grok' } } });
    const p2 = await projects.createProject({ name: 'B' });
    expect(p2.videoSettings.backend).toBe('local');
  });

  it('a settings read failure leaves creation working (seed is best-effort)', async () => {
    getSettings.mockRejectedValue(new Error('boom'));
    const p = await projects.createProject({ name: 'A' });
    expect(p.videoSettings.backend).toBe('local');
  });
});

describe('track metadata and lyrics auto-reading on create and update', () => {
  it('automatically reads lyrics, concept, prompt, and title from linked track at creation', async () => {
    getTrack.mockResolvedValue({
      id: 'track-1',
      title: 'Midnight Echoes',
      lyrics: '[00:01.00] Echoes in the dark\n[00:04.00] Shining like a spark',
      concept: 'A cyberpunk nocturnal story',
      prompt: 'Neon noir 80s anime style',
    });

    const project = await projects.createProject({ trackId: 'track-1' });

    expect(project.name).toBe('Midnight Echoes');
    expect(project.lyricCues).toHaveLength(2);
    expect(project.lyricCues[0].text).toBe('Echoes in the dark');
    expect(project.lyricCues[1].text).toBe('Shining like a spark');
    expect(project.concept).toMatchObject({
      prompt: 'A cyberpunk nocturnal story',
      songStyle: 'Neon noir 80s anime style',
    });
    // The Suno style is the song's sound, never the visual style appended to frame prompts.
    expect(project.concept.style).toBeUndefined();
  });

  it('preserves explicitly authored project fields over track defaults at creation', async () => {
    getTrack.mockResolvedValue({
      id: 'track-1',
      title: 'Midnight Echoes',
      lyrics: 'Line from track',
      concept: 'Track concept',
      prompt: 'Track style',
    });

    const project = await projects.createProject({
      name: 'Custom Name',
      trackId: 'track-1',
      lyricCues: [{ text: 'Custom cue' }],
      concept: { prompt: 'Custom concept', style: 'Custom style' },
    });

    expect(project.name).toBe('Custom Name');
    expect(project.lyricCues).toHaveLength(1);
    expect(project.lyricCues[0].text).toBe('Custom cue');
    expect(project.concept).toMatchObject({
      prompt: 'Custom concept',
      style: 'Custom style',
      songStyle: 'Track style',
    });
  });

  it('automatically reads lyrics and concept when changing track via updateProject', async () => {
    getTrack.mockImplementation(async (id) => {
      if (id === 'track-2') {
        return {
          id: 'track-2',
          title: 'Morning Sun',
          lyrics: 'Golden light breaks through',
          concept: 'Dawn over the horizon',
          prompt: 'Impressionist pastel colors',
        };
      }
      return null;
    });

    const project = await projects.createProject({ name: 'Initial Project' });
    const updated = await projects.updateProject(project.id, { trackId: 'track-2' });

    expect(updated.trackId).toBe('track-2');
    expect(updated.lyricCues).toHaveLength(1);
    expect(updated.lyricCues[0].text).toBe('Golden light breaks through');
    expect(updated.concept).toMatchObject({
      prompt: 'Dawn over the horizon',
      songStyle: 'Impressionist pastel colors',
    });
    expect(updated.concept.style).toBeUndefined();
  });
});


describe('refreshSongStyleFromSuno', () => {
  it('sets the song style read from Suno on the project and its track, leaving the visual style alone', async () => {
    getTrack.mockResolvedValue({ id: 'track-1', title: 'Example', prompt: 'synth-pop' });
    const project = await projects.createProject({ trackId: 'track-1', concept: { style: 'soft analog glow' } });
    readSunoSongStyle.mockResolvedValue({ style: 'synth-pop, -metal', excludedStylesKnown: true });
    const { project: updated, excludedStylesKnown } = await projects.refreshSongStyleFromSuno(project.id, 'https://suno.com/song/x');
    expect(excludedStylesKnown).toBe(true);
    expect(updated.concept).toMatchObject({ style: 'soft analog glow', songStyle: 'synth-pop, -metal' });
    expect(updateTrack).toHaveBeenCalledWith('track-1', { prompt: 'synth-pop, -metal' });
  });
});


describe('automation respects persisted shot locks (#11218)', () => {
  it('records run edits, cuts and merges as proposals, allows open edits and director edits', async () => {
    const { applySceneUpdate, removeScene, mergeNextScene } = await import('./projectsLogic.js');
    const { setShotLocks, shotLocks } = await import('./productionReview.js');
    const p = await projects.createProject({ name: 'Locks' });
    const a = await projects.addProjectScene(p.id, { startSec: 0, endSec: 2, prompt: 'Keep this' });
    const b = await projects.addProjectScene(p.id, { startSec: 2, endSec: 4, prompt: 'Open shot' });
    await projects.mutateProjectRecord(p.id, current => ({ project: setShotLocks(current, { sceneIds: [a.sceneId], locked: true }) }));
    const attempt = await projects.mutateProjectRecord(p.id, current => applySceneUpdate(current, a.sceneId, { prompt: 'Automation edit' }), { source: 'orchestrator' });
    expect(attempt.project.scenes[0].prompt).toBe('Keep this');
    expect(attempt.project.productionReview.feedback.at(-1)).toMatchObject({ target: a.sceneId, decision: 'comment', text: expect.stringContaining('Automation edit') });
    for (const transform of [current => ({ project: removeScene(current, a.sceneId) }), current => mergeNextScene(current, a.sceneId)]) {
      const out = await projects.mutateProjectRecord(p.id, transform, { source: 'production-run' });
      expect(out.project.scenes.map(s => s.sceneId)).toEqual([a.sceneId, b.sceneId]);
      expect(shotLocks(out.project)[a.sceneId]).toBe('locked');
    }
    await projects.mutateProjectRecord(p.id, current => applySceneUpdate(current, b.sceneId, { prompt: 'Allowed run edit' }), { source: 'orchestrator' });
    expect((await projects.getProject(p.id)).scenes[1].prompt).toBe('Allowed run edit');
    await projects.updateScene(p.id, a.sceneId, { prompt: 'Director edit' });
    expect(shotLocks(await projects.getProject(p.id))).toEqual({ [a.sceneId]: 'locked', [b.sceneId]: 'open' });
  });

  it('keeps locked storyboard rows and the original board when a planner replaces its IDs', async () => {
    const { setShotLocks, shotLocks } = await import('./productionReview.js');
    const { replaceScenes } = await import('./projectsLogic.js');
    const p = await projects.createProject({ name: 'Locked plan' });
    const scene = await projects.addProjectScene(p.id, { startSec: 0, endSec: 4, prompt: 'Original' });
    await projects.mutateProjectRecord(p.id, current => ({ project: setShotLocks({ ...current,
      productionReview: { draft: { storyboard: [{ sceneId: scene.sceneId, action: 'Stay' }] } } }, { sceneIds: [scene.sceneId], locked: true }) }));
    const revised = await projects.mutateProjectRecord(p.id, current => ({ project: { ...current,
      productionReview: { ...current.productionReview, draft: { storyboard: [{ sceneId: scene.sceneId, action: 'Move' }] } } } }), { source: 'orchestrator' });
    expect(revised.project.productionReview.draft.storyboard[0].action).toBe('Stay');
    const replaced = await projects.mutateProjectRecord(p.id, current => {
      const outcome = replaceScenes(current, [{ startSec: 0, endSec: 2, prompt: 'New span' }]);
      outcome.project.composition = { ...current.composition, mode: 'composed' };
      return outcome;
    }, { source: 'shot-planner' });
    expect(replaced.project.scenes.map(s => s.sceneId)).toEqual([scene.sceneId]);
    expect(replaced).toMatchObject({ rejected: true, replaced: 0 });
    expect(replaced.project.composition?.mode).toBe(p.composition?.mode);
    expect(replaced.scenes).toEqual((await projects.getProject(p.id)).scenes);
    expect(shotLocks(await projects.getProject(p.id))[scene.sceneId]).toBe('locked');
    expect(replaced.project.productionReview.feedback).toHaveLength(2);
  });

  it('checks fresh locks when an asynchronous repair lands and preserves generated clip output', async () => {
    const { setShotLocks, shotLocks } = await import('./productionReview.js');
    const p = await projects.createProject({ name: 'Repair race' });
    const scene = await projects.addProjectScene(p.id, { startSec: 0, endSec: 2, prompt: 'Approved input' });
    await projects.mutateProjectRecord(p.id, current => ({ project: setShotLocks(current, { sceneIds: [scene.sceneId], locked: true }) }));
    const repair = await projects.mutateProjectRecord(p.id, current => ({ project: { ...current, scenes: current.scenes.map(s => ({ ...s, clipFixes: { text: 'New motion' } })) } }), { source: 'orchestrator' });
    expect(repair.project.scenes[0].clipFixes).toBeUndefined();
    const frame = await projects.appendSceneTakes(p.id, scene.sceneId, [{ kind: 'image', assetId: 'candidate.png', source: 'generated' }]);
    expect(frame.scene.referenceImageId).toBeNull();
    expect(frame.scene.takes.some(take => take.assetId === 'candidate.png')).toBe(true);
    expect(shotLocks(await projects.getProject(p.id))[scene.sceneId]).toBe('locked');
    const clip = await projects.mutateProjectRecord(p.id, current => ({ project: { ...current, scenes: current.scenes.map(s => ({ ...s, videoHistoryId: 'new-clip' })) } }), { source: 'production-run' });
    expect(clip.project.scenes[0].videoHistoryId).toBe('new-clip');
    expect(shotLocks(clip.project)[scene.sceneId]).toBe('locked');
  });
});

describe('a locked shot video', () => {
  // Uniquely catches a video lock that only labels the shot: edits, split, merges either way, take choice and a run must all be refused.
  it('freezes the shot for the director and for automation until its video is unlocked', async () => {
    const { setShotLocks, clipLocks } = await import('./productionReview.js');
    const p = await projects.createProject({ name: 'Video lock' });
    const scene = await projects.addProjectScene(p.id, { startSec: 0, endSec: 2, prompt: 'Approved' });
    await projects.updateScene(p.id, scene.sceneId, { videoHistoryId: 'clip-1' });
    const lock = (locked, stage) => projects.mutateProjectRecord(p.id, current => ({ project: setShotLocks(current, { sceneIds: [scene.sceneId], locked, stage }) }));
    await lock(true, 'still');
    await lock(true, 'video');
    expect(clipLocks(await projects.getProject(p.id))[scene.sceneId]).toBe('locked');
    await expect(projects.updateScene(p.id, scene.sceneId, { prompt: 'Director edit' })).rejects.toMatchObject({ code: 'MUSIC_VIDEO_SHOT_LOCKED' });
    await expect(projects.updateScene(p.id, scene.sceneId, { videoHistoryId: 'clip-2' })).rejects.toMatchObject({ code: 'MUSIC_VIDEO_SHOT_LOCKED' });
    await expect(projects.deleteScene(p.id, scene.sceneId)).rejects.toMatchObject({ code: 'MUSIC_VIDEO_SHOT_LOCKED' });
    await expect(projects.splitProjectScene(p.id, scene.sceneId, { atSec: 1 })).rejects.toMatchObject({ code: 'MUSIC_VIDEO_SHOT_LOCKED' });
    await expect(projects.selectSceneTake(p.id, scene.sceneId, 'take-1')).rejects.toMatchObject({ code: 'MUSIC_VIDEO_SHOT_LOCKED' });
    const after = await projects.addProjectScene(p.id, { startSec: 2, endSec: 3, prompt: 'After' });
    await expect(projects.mergeProjectNextScene(p.id, scene.sceneId)).rejects.toMatchObject({ code: 'MUSIC_VIDEO_SHOT_LOCKED' });
    await expect(projects.mergeProjectPreviousScene(p.id, after.sceneId)).rejects.toMatchObject({ code: 'MUSIC_VIDEO_SHOT_LOCKED' });
    // A field that doesn't change what the shot shows stays editable.
    await projects.updateScene(p.id, scene.sceneId, { prompt: 'Approved', textZone: 'upper' });
    const run = await projects.mutateProjectRecord(p.id, current => ({ project: { ...current, scenes: current.scenes.map(s => ({ ...s, videoHistoryId: 'run-clip' })) } }), { source: 'production-run' });
    expect(run.project.scenes[0].videoHistoryId).toBe('clip-1');
    await lock(false, 'video');
    await projects.updateScene(p.id, scene.sceneId, { videoHistoryId: 'clip-2' });
    expect((await projects.getProject(p.id)).scenes[0].videoHistoryId).toBe('clip-2');
  });
});

// Hold a public mutation immediately before the real backend acquires its write
// queue, allowing another request to commit a video lock first. Both old direct
// backend methods and the generic transactional path pass through this barrier.
async function pauseSceneWrite(start) {
  const backend = await import('./projectsFile.js');
  let entered;
  let resume;
  const reached = new Promise(resolve => { entered = resolve; });
  const released = new Promise(resolve => { resume = resolve; });
  const spies = ['mutateProjectRecord', 'updateScene', 'deleteScene', 'selectSceneTake', 'reviewSceneTake'].map(name => {
    const original = backend[name];
    return vi.spyOn(backend, name).mockImplementationOnce(async (...args) => {
      entered();
      await released;
      return original(...args);
    });
  });
  const result = start();
  // Attach immediately: rejected service calls must not become unhandled while
  // the test is committing the intervening lock.
  const settled = result.then(value => ({ value }), error => ({ error }));
  await reached;
  spies.forEach(spy => spy.mockRestore());
  return { settled, resume };
}

describe('video lock transactions', () => {
  // Each case crosses a distinct dispatcher mutation path. A preflight-only
  // check lets a completed lock be overwritten after this barrier releases.
  it.each(['edit', 'delete', 'split', 'select'])('refuses a pending %s when another request locks the video first', async (operation) => {
    const { setShotLocks } = await import('./productionReview.js');
    const p = await projects.createProject({ name: 'Concurrent video lock' });
    const scene = await projects.addProjectScene(p.id, { startSec: 0, endSec: 2, prompt: 'Keep this shot' });
    const { appended } = await projects.appendSceneTakes(p.id, scene.sceneId, [
      { kind: 'video', assetId: 'approved-clip' }, { kind: 'video', assetId: 'alternate-clip' },
    ]);
    const operations = {
      edit: () => projects.updateScene(p.id, scene.sceneId, { prompt: 'Pending edit' }),
      delete: () => projects.deleteScene(p.id, scene.sceneId),
      split: () => projects.splitProjectScene(p.id, scene.sceneId, { atSec: 1 }),
      select: () => projects.selectSceneTake(p.id, scene.sceneId, appended[1].takeId),
    };
    const pending = await pauseSceneWrite(operations[operation]);
    let locked;
    try {
      locked = (await projects.mutateProjectRecord(p.id, current => ({ project: setShotLocks(
        setShotLocks(current, { sceneIds: [scene.sceneId], locked: true, stage: 'still' }),
        { sceneIds: [scene.sceneId], locked: true, stage: 'video' },
      ) }))).project;
    } finally {
      pending.resume();
    }
    expect(await pending.settled).toMatchObject({ error: { code: 'MUSIC_VIDEO_SHOT_LOCKED' } });
    expect((await projects.getProject(p.id)).scenes).toEqual(locked.scenes);
    await projects.mutateProjectRecord(p.id, current => ({ project: setShotLocks(current, { sceneIds: [scene.sceneId], locked: false, stage: 'video' }) }));
    await expect(operations[operation]()).resolves.toBeDefined();
  });

  it('checks the actual merge neighbor after a concurrent reorder and lock', async () => {
    const { setShotLocks } = await import('./productionReview.js');
    const p = await projects.createProject({ name: 'Merge neighbor race' });
    const { scenes: [a, b, c] } = await projects.addProjectScenes(p.id, [
      { startSec: 0, endSec: 1, prompt: 'First' },
      { startSec: 1, endSec: 2, prompt: 'Original next' },
      { startSec: 2, endSec: 3, prompt: 'New next' },
    ]);
    await projects.updateScene(p.id, c.sceneId, { videoHistoryId: 'keep-clip' });
    const pending = await pauseSceneWrite(() => projects.mergeProjectNextScene(p.id, a.sceneId));
    let locked;
    try {
      await projects.reorderProjectScenes(p.id, [a.sceneId, c.sceneId, b.sceneId]);
      locked = (await projects.mutateProjectRecord(p.id, current => ({ project: setShotLocks(
        setShotLocks(current, { sceneIds: [c.sceneId], locked: true, stage: 'still' }),
        { sceneIds: [c.sceneId], locked: true, stage: 'video' },
      ) }))).project;
    } finally {
      pending.resume();
    }
    expect(await pending.settled).toMatchObject({ error: { code: 'MUSIC_VIDEO_SHOT_LOCKED', context: { sceneId: c.sceneId } } });
    expect((await projects.getProject(p.id)).scenes).toEqual(locked.scenes);
    await projects.mutateProjectRecord(p.id, current => ({ project: setShotLocks(current, { sceneIds: [c.sceneId], locked: false, stage: 'video' }) }));
    const merged = await projects.mergeProjectNextScene(p.id, a.sceneId);
    expect(merged.project.scenes.map(scene => scene.sceneId)).toEqual([a.sceneId, b.sceneId]);
    expect(merged.scene.endSec).toBe(locked.scenes[1].endSec);
  });

  it('refuses a reorder that would retime a locked video, while allowing no-op and unlocked reorders', async () => {
    const { setShotLocks } = await import('./productionReview.js');
    const p = await projects.createProject({ name: 'Locked timeline slot' });
    const { scenes: [a, b] } = await projects.addProjectScenes(p.id, [
      { startSec: 0, endSec: 1, prompt: 'Keep timing' },
      { startSec: 1, endSec: 2, prompt: 'Other shot' },
    ]);
    await projects.updateScene(p.id, a.sceneId, { videoHistoryId: 'approved-clip' });
    await projects.mutateProjectRecord(p.id, current => ({ project: setShotLocks(
      setShotLocks(current, { sceneIds: [a.sceneId], locked: true, stage: 'still' }),
      { sceneIds: [a.sceneId], locked: true, stage: 'video' },
    ) }));
    await expect(projects.reorderProjectScenes(p.id, [b.sceneId, a.sceneId]))
      .rejects.toMatchObject({ code: 'MUSIC_VIDEO_SHOT_LOCKED' });
    const unchanged = await projects.reorderProjectScenes(p.id, [a.sceneId, b.sceneId]);
    expect(unchanged.scenes[0]).toMatchObject({ sceneId: a.sceneId, startSec: 0, endSec: 1, videoHistoryId: 'approved-clip' });
    await projects.mutateProjectRecord(p.id, current => ({ project: setShotLocks(current, { sceneIds: [a.sceneId], locked: false, stage: 'video' }) }));
    const reordered = await projects.reorderProjectScenes(p.id, [b.sceneId, a.sceneId]);
    expect(reordered.scenes[1]).toMatchObject({ sceneId: a.sceneId, startSec: 1, endSec: 2, videoHistoryId: 'approved-clip' });
  });

  it('keeps a selected locked take when rejected, while allowing notes and other candidate reviews', async () => {
    const { setShotLocks } = await import('./productionReview.js');
    const p = await projects.createProject({ name: 'Locked take review' });
    const scene = await projects.addProjectScene(p.id, { startSec: 0, endSec: 2, prompt: 'Keep this' });
    const { appended } = await projects.appendSceneTakes(p.id, scene.sceneId, [
      { kind: 'video', assetId: 'approved-clip' }, { kind: 'video', assetId: 'candidate-clip' },
    ]);
    await projects.mutateProjectRecord(p.id, current => ({ project: setShotLocks(
      setShotLocks(current, { sceneIds: [scene.sceneId], locked: true, stage: 'still' }),
      { sceneIds: [scene.sceneId], locked: true, stage: 'video' },
    ) }));
    await expect(projects.reviewSceneTake(p.id, scene.sceneId, appended[0].takeId, { status: 'rejected' }))
      .rejects.toMatchObject({ code: 'MUSIC_VIDEO_SHOT_LOCKED' });
    await projects.reviewSceneTake(p.id, scene.sceneId, appended[0].takeId, { note: 'Keep the approved take' });
    const reviewed = await projects.reviewSceneTake(p.id, scene.sceneId, appended[1].takeId, { status: 'rejected' });
    expect(reviewed.videoHistoryId).toBe('approved-clip');
    expect(reviewed.takes).toEqual(expect.arrayContaining([
      expect.objectContaining({ takeId: appended[0].takeId, status: 'candidate', note: 'Keep the approved take' }),
      expect.objectContaining({ takeId: appended[1].takeId, status: 'rejected' }),
    ]));
    await projects.mutateProjectRecord(p.id, current => ({ project: setShotLocks(current, { sceneIds: [scene.sceneId], locked: false, stage: 'video' }) }));
    expect((await projects.reviewSceneTake(p.id, scene.sceneId, appended[0].takeId, { status: 'rejected' })).videoHistoryId).toBeNull();
  });
});

describe('moving the cut before a shot', () => {
  // Uniquely catches a start move that leaves a gap or overlap with the shot before, or retimes a locked video.
  it('starts the shot at the new time and ends the shot before it there, unless either video is locked', async () => {
    const { setShotLocks } = await import('./productionReview.js');
    const p = await projects.createProject({ name: 'Move a cut' });
    const { scenes: [a, b] } = await projects.addProjectScenes(p.id, [
      { startSec: 0, endSec: 2, prompt: 'First' },
      { startSec: 2, endSec: 4, prompt: 'Second' },
    ]);
    const later = await projects.moveProjectSceneStart(p.id, b.sceneId, { startSec: 2.5 });
    expect([later.previous.endSec, later.scene.startSec, later.scene.endSec]).toEqual([2.5, 2.5, 4]);
    const earlier = await projects.moveProjectSceneStart(p.id, b.sceneId, { startSec: 1.25 });
    expect(earlier.project.scenes.map((scene) => [scene.startSec, scene.endSec])).toEqual([[0, 1.25], [1.25, 4]]);
    await expect(projects.moveProjectSceneStart(p.id, b.sceneId, { startSec: 4 })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(projects.moveProjectSceneStart(p.id, b.sceneId, { startSec: 0 })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await projects.updateScene(p.id, a.sceneId, { videoHistoryId: 'clip-a' });
    await projects.mutateProjectRecord(p.id, (current) => ({ project: setShotLocks(setShotLocks(current, { sceneIds: [a.sceneId], locked: true, stage: 'still' }),
      { sceneIds: [a.sceneId], locked: true, stage: 'video' }) }));
    await expect(projects.moveProjectSceneStart(p.id, b.sceneId, { startSec: 1.5 })).rejects.toMatchObject({ code: 'MUSIC_VIDEO_SHOT_LOCKED' });
    expect((await projects.getProject(p.id)).scenes.map((scene) => [scene.startSec, scene.endSec])).toEqual([[0, 1.25], [1.25, 4]]);
  });
});

describe('anchoring shots to the sung lyrics', () => {
  // Uniquely catches the anchor fix rewriting the lyric of a shot whose video is locked.
  it('re-anchors the named shots and refreshes their lyric, leaving a locked video\'s lyric alone', async () => {
    const [{ setShotLocks }, { syncLyricAnchors }] = await Promise.all([import('./productionReview.js'), import('./productionReviewService.js')]);
    const p = await projects.createProject({ name: 'Anchor lyrics' });
    const { scenes: [a, b] } = await projects.addProjectScenes(p.id, [
      { startSec: 0, endSec: 2, prompt: 'First', lyricText: 'old line' },
      { startSec: 2, endSec: 4, prompt: 'Second', lyricText: 'old line' },
    ]);
    await projects.mutateProjectRecord(p.id, (current) => ({ project: { ...current,
      lyricCues: [{ id: 'c1', text: 'sung over both', startSec: 0, endSec: 4 }],
      productionReview: { draft: { storyboard: [a, b].map((s) => ({ sceneId: s.sceneId, lyricCueIds: [] })) } } } }));
    await projects.updateScene(p.id, b.sceneId, { videoHistoryId: 'clip-b' });
    await projects.mutateProjectRecord(p.id, (current) => ({ project: setShotLocks(setShotLocks(current, { sceneIds: [b.sceneId], locked: true, stage: 'still' }),
      { sceneIds: [b.sceneId], locked: true, stage: 'video' }) }));
    const { project } = await syncLyricAnchors(p.id, { sceneIds: [a.sceneId, b.sceneId] });
    expect(project.productionReview.draft.storyboard.map((row) => row.lyricCueIds)).toEqual([['c1'], ['c1']]);
    expect(project.scenes.map((scene) => scene.lyricText)).toEqual(['sung over both', 'old line']);
  });
});
