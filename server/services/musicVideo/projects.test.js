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

// Passthrough spy: counts the catalog check-in resolutions a write pays for.
const withCatalogCheckin = vi.fn();
vi.mock('./catalogCheckin.js', async (importOriginal) => {
  const actual = await importOriginal();
  withCatalogCheckin.mockImplementation(actual.withCatalogCheckin);
  return { ...actual, withCatalogCheckin: (...a) => withCatalogCheckin(...a) };
});

// Stills a test selects without a real gallery file; every other name resolves as it does live.
const seededImages = new Set();
vi.mock('../../lib/pathSafety.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, resolveGalleryImage: (name, ...rest) => (seededImages.has(name) ? join(TEST_DATA_ROOT, name) : actual.resolveGalleryImage(name, ...rest)) };
});

const projects = await import('./projects.js');
const boardEdits = await import('./projectBoardEdits.js');
const filmActions = await import('./projectFilmActions.js');

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
    const { scenes: [s1] } = await projects.addProjectScenes(p.id, [{ prompt: 'one' }]);
    const { scenes: [s2] } = await projects.addProjectScenes(p.id, [{ prompt: 'two' }]);
    await projects.updateScene(p.id, s1.sceneId, { prompt: 'one-edited' });
    await boardEdits.reorderProjectScenes(p.id, [s2.sceneId, s1.sceneId]);
    await boardEdits.deleteScene(p.id, s2.sceneId);

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
  it('seeds the upscale default from credentials and preserves an explicit project choice', async () => {
    vi.stubEnv('FAL_KEY', '');
    try {
      const local = await projects.createProject({ name: 'Local draft' });
      expect(local.videoSettings).toMatchObject({ upscaleMethod: 'lanczos', upscaleTargetResolution: '1080p' });
      getSettings.mockResolvedValue({ videoGen: { fal: { apiKey: 'synthetic-key' } } });
      const hosted = await projects.createProject({ name: 'Hosted draft', videoSettings: { backend: 'grok' } });
      expect(hosted.videoSettings).toMatchObject({ backend: 'grok', upscaleMethod: 'fal-seedvr2', upscaleTargetResolution: '1080p' });
      await projects.updateProject(hosted.id, { videoSettings: { upscaleTargetResolution: '1440p' } });
      expect((await projects.getProject(hosted.id)).videoSettings).toMatchObject({ backend: 'grok', upscaleMethod: 'fal-seedvr2', upscaleTargetResolution: '1440p' });
      const explicit = await projects.createProject({ name: 'Explicit local upscale', videoSettings: { upscaleMethod: 'lanczos' } });
      expect(explicit.videoSettings.upscaleMethod).toBe('lanczos');
    } finally {
      vi.unstubAllEnvs();
    }
  });
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
    const { project: updated, excludedStylesKnown } = await filmActions.refreshSongStyleFromSuno(project.id, 'https://suno.com/song/x');
    expect(excludedStylesKnown).toBe(true);
    expect(updated.concept).toMatchObject({ style: 'soft analog glow', songStyle: 'synth-pop, -metal' });
    expect(updateTrack).toHaveBeenCalledWith('track-1', { prompt: 'synth-pop, -metal' });
  });
});


// The clip approval a project saved before lock removal still carries; nothing writes one now.
const withLegacyClipLock = (project, sceneId, videoHistoryId) => ({ ...project,
  productionReview: { ...project.productionReview, clipApprovals: { ...project.productionReview?.clipApprovals, [sceneId]: { videoHistoryId } } } });

describe('legacy shot approvals', () => {
  it('allows automation and the director to edit and select a different clip without losing existing takes', async () => {
    const { applySceneUpdate } = await import('./projectsLogic.js');
    const p = await projects.createProject({ name: 'Legacy approvals' });
    const { scenes: [scene] } = await projects.addProjectScenes(p.id, [{ startSec: 0, endSec: 2, prompt: 'Original' }]);
    const { appended } = await projects.appendSceneTakes(p.id, scene.sceneId, [
      { kind: 'video', assetId: 'approved-clip' }, { kind: 'video', assetId: 'alternate-clip' },
    ]);
    await projects.mutateProjectRecord(p.id, current => ({ project: withLegacyClipLock(current, scene.sceneId, 'approved-clip') }));
    const automated = await projects.mutateProjectRecord(p.id, current => applySceneUpdate(current, scene.sceneId, { prompt: 'Automation edit' }), { source: 'orchestrator' });
    expect(automated.project.scenes[0]).toMatchObject({ prompt: 'Automation edit', videoHistoryId: 'approved-clip' });
    await projects.updateScene(p.id, scene.sceneId, { prompt: 'Director edit' });
    const selected = await projects.selectSceneTake(p.id, scene.sceneId, appended[1].takeId);
    expect(selected).toMatchObject({ prompt: 'Director edit', videoHistoryId: 'alternate-clip' });
    expect(selected.takes.map(take => take.assetId)).toEqual(['approved-clip', 'alternate-clip']);
  });
});

describe('take decisions', () => {
  it('selects a take for final upgrade without catalog check-in and persists board take decisions', async () => {
    const p = await projects.createProject({ name: 'Take decisions' });
    const { scenes: [scene] } = await projects.addProjectScenes(p.id, [{ startSec: 0, endSec: 2, prompt: 'One' }]);
    const { appended } = await projects.appendSceneTakes(p.id, scene.sceneId, [
      { kind: 'video', assetId: 'clip-a' }, { kind: 'video', assetId: 'clip-b' }, { kind: 'video', assetId: 'clip-c' },
    ]);
    await projects.mutateProjectRecord(p.id, current => ({ project: { ...current, castAndSets: { ...current.castAndSets, source: 'catalog' } } }));
    withCatalogCheckin.mockClear();

    const selected = await projects.selectSceneTake(p.id, scene.sceneId, appended[1].takeId);
    expect(selected.videoHistoryId).toBe('clip-b');
    expect(withCatalogCheckin).not.toHaveBeenCalled();

    const { scene: reviewed, edit: reviewEdit } = await boardEdits.reviewSceneTake(p.id, scene.sceneId, appended[0].takeId, { status: 'rejected' });
    expect(reviewed.takes.find(take => take.takeId === appended[0].takeId).status).toBe('rejected');
    expect(reviewEdit.scenes).toContainEqual(reviewed);
    const marked = await boardEdits.markMediaPoolAssets(p.id, ['video:clip-a'], 'bad');
    expect(marked.assetMarks).toEqual({ 'video:clip-a': 'bad' });
    const { scene: rejected, edit: rejectEdit, rejected: count } = await boardEdits.rejectUnusedSceneTakes(p.id, scene.sceneId);
    expect(count).toBe(1);
    expect(rejected.takes.find(take => take.takeId === appended[2].takeId).status).toBe('rejected');
    expect(rejectEdit.scenes).toContainEqual(expect.objectContaining({
      sceneId: scene.sceneId,
      takes: expect.arrayContaining([expect.objectContaining({ takeId: appended[2].takeId, status: 'rejected' })]),
    }));
    withCatalogCheckin.mockClear();

    // An ordinary edit still resolves it under the write for the stale-pick clean-up, and only
    // there: it answers with the shot, so the saved project is not presented again (#16210).
    await projects.updateScene(p.id, scene.sceneId, { prompt: 'Edited' });
    expect(withCatalogCheckin).toHaveBeenCalledTimes(1);
    expect((await projects.getProject(p.id)).scenes[0]).toMatchObject({ prompt: 'Edited', videoHistoryId: 'clip-b' });
  });

  // Uniquely catches a frame confirmation answering with take states read without the catalog
  // check-in, which differ from what the next GET shows, so the board needs a second press (#16274).
  it('answers a frame confirmation with the take states the next read shows', async () => {
    const { captureImageFrameDependencies } = await import('../../lib/musicVideo/musicVideoDependencies.js');
    const { musicVideoSceneCastIds } = await import('../../lib/musicVideo/musicVideoConditioning.js');
    const { canonicalSnapshotChecksum } = await import('../../lib/snapshotChecksum.js');
    const subjects = [{ id: 'subj-a', kind: 'character', name: 'Ada', ingredientId: 'cat-chr-a' },
      { id: 'subj-b', kind: 'character', name: 'Ben', ingredientId: 'cat-chr-b' },
      { id: 'subj-p', kind: 'place', name: 'Harbor', ingredientId: 'cat-plc' }];
    const checkin = { items: subjects.map(({ id, kind, name, ingredientId }) => ({ subjectId: id, kind, name, ingredientId, images: [] })), problems: [] };
    const actual = withCatalogCheckin.getMockImplementation();
    withCatalogCheckin.mockImplementation(async (project) => ({ ...project, castAndSets: { ...project.castAndSets, catalogCheckin: checkin } }));
    for (const name of ['frame-a.png', 'frame-b.png']) seededImages.add(name);
    const p = await projects.createProject({ name: 'Frame confirmation' });
    const { scenes: [{ sceneId }] } = await projects.addProjectScenes(p.id, [{ startSec: 0, endSec: 2, prompt: 'One' }]);
    const shot = { sceneId, framePrompt: 'A rider at dusk', endFramePrompt: 'The rider gone', referenceImageId: 'frame-a.png', endImageId: 'frame-b.png',
      frameReferenceIds: ['mvr-linked-0000000000000001'], shotSheet: { characters: ['Ada'], location: 'Harbor' } };
    const presented = { concept: { subjects }, castAndSets: { source: 'catalog', catalogCheckin: checkin }, scenes: [shot] };
    // The start frame was made for an earlier prompt; the end frame carries a pre-#16274 cast stamp that
    // only the check-in can recognise (narrowed to the shot's named cast and place).
    const startDeps = captureImageFrameDependencies(presented, { ...shot, framePrompt: 'An earlier prompt' });
    const endDeps = captureImageFrameDependencies(presented, shot, { slot: 'end' });
    const narrowed = canonicalSnapshotChecksum({ names: ['Ada'], ids: musicVideoSceneCastIds(presented, shot).slice().sort() });
    endDeps.references = endDeps.references.map((ref) => (ref.role === 'frameCast' ? { ...ref, revision: narrowed } : ref));
    expect(endDeps).not.toEqual(captureImageFrameDependencies(presented, shot, { slot: 'end' }));
    await projects.mutateProjectRecord(p.id, (current) => ({ project: { ...current, concept: { subjects },
      castAndSets: { ...current.castAndSets, source: 'catalog' },
      scenes: current.scenes.map((scene) => ({ ...scene, ...shot, takes: [
        { takeId: 't-start', kind: 'image', assetId: 'frame-a.png', status: 'candidate', source: 'generated', frameDependencies: startDeps },
        { takeId: 't-end', kind: 'endImage', assetId: 'frame-b.png', status: 'candidate', source: 'generated', frameDependencies: endDeps },
      ] })) } }), { sceneOnly: true });
    const states = (scene) => scene.takes.map((take) => take.dependencyState?.status);
    expect(states((await projects.getProject(p.id)).scenes[0])).toEqual(['stale', 'current']);

    const { scene: reviewed, edit } = await boardEdits.reviewSceneTake(p.id, sceneId, 't-start', { confirmFrame: true, reviewer: { kind: 'local' } });
    expect(states(reviewed)).toEqual(['current', 'current']);
    expect(states(edit.scenes.find((scene) => scene.sceneId === sceneId))).toEqual(['current', 'current']);
    expect(states((await projects.getProject(p.id)).scenes[0])).toEqual(['current', 'current']);
    withCatalogCheckin.mockImplementation(actual);
  });

  // Uniquely catches a board take decision's edit result presenting takes without the catalog check-in:
  // a frame whose stamp only the check-in recognises would read stale until the next reload (#16270).
  it('answers board take decisions on a catalog project with the take states the next read shows', async () => {
    const { captureImageFrameDependencies } = await import('../../lib/musicVideo/musicVideoDependencies.js');
    const { musicVideoSceneCastIds } = await import('../../lib/musicVideo/musicVideoConditioning.js');
    const { canonicalSnapshotChecksum } = await import('../../lib/snapshotChecksum.js');
    const subjects = [{ id: 'subj-a', kind: 'character', name: 'Ada', ingredientId: 'cat-chr-a' }, { id: 'subj-b', kind: 'character', name: 'Ben', ingredientId: 'cat-chr-b' }];
    const checkin = { items: subjects.map(({ id, kind, name, ingredientId }) => ({ subjectId: id, kind, name, ingredientId, images: [] })), problems: [] };
    const actual = withCatalogCheckin.getMockImplementation();
    withCatalogCheckin.mockImplementation(async (project) => ({ ...project, castAndSets: { ...project.castAndSets, catalogCheckin: checkin } }));
    for (const name of ['frame-a.png', 'frame-b.png', 'frame-c.png']) seededImages.add(name);
    const p = await projects.createProject({ name: 'Catalog take decisions' });
    const { scenes: [{ sceneId }] } = await projects.addProjectScenes(p.id, [{ startSec: 0, endSec: 2, prompt: 'One' }]);
    const shot = { sceneId, framePrompt: 'A rider at dusk', referenceImageId: 'frame-a.png', frameReferenceIds: ['mvr-linked-0000000000000001'], shotSheet: { characters: ['Ada'] } };
    const presented = { concept: { subjects }, castAndSets: { source: 'catalog', catalogCheckin: checkin }, scenes: [shot] };
    // A pre-#16274 cast stamp, narrowed by the check-in: current only when presented with it.
    const deps = captureImageFrameDependencies(presented, shot);
    deps.references = deps.references.map((ref) => (ref.role === 'frameCast' ? { ...ref, revision: canonicalSnapshotChecksum({ names: ['Ada'], ids: musicVideoSceneCastIds(presented, shot).slice().sort() }) } : ref));
    const frame = (takeId, assetId) => ({ takeId, kind: 'image', assetId, status: 'candidate', source: 'generated', frameDependencies: deps });
    await projects.mutateProjectRecord(p.id, (current) => ({ project: { ...current, concept: { subjects }, castAndSets: { ...current.castAndSets, source: 'catalog' },
      scenes: current.scenes.map((scene) => ({ ...scene, ...shot, takes: [frame('t-a', 'frame-a.png'), frame('t-b', 'frame-b.png'), frame('t-c', 'frame-c.png')] })) } }), { sceneOnly: true });
    const states = (scene) => scene.takes.map((take) => `${take.takeId}:${take.status}:${take.dependencyState?.status}`);
    const sceneOf = (edit) => edit.scenes.find((scene) => scene.sceneId === sceneId);
    const reviewed = await boardEdits.reviewSceneTake(p.id, sceneId, 't-b', { status: 'rejected' });
    expect(states(sceneOf(reviewed.edit))).toEqual(states((await projects.getProject(p.id)).scenes[0]));
    expect(states(sceneOf(reviewed.edit))[0]).toBe('t-a:candidate:current');
    const unused = await boardEdits.rejectUnusedSceneTakes(p.id, sceneId);
    expect(states(sceneOf(unused.edit))).toEqual(states((await projects.getProject(p.id)).scenes[0]));
    const selected = await boardEdits.selectSceneTake(p.id, sceneId, 't-c', {});
    expect(states(sceneOf(selected.edit))).toEqual(states((await projects.getProject(p.id)).scenes[0]));
    withCatalogCheckin.mockImplementation(actual);
  });

  it.each(['legacy', 'new'])('reads %s clip evidence through a catalog outage and recovery', async (version) => {
    const { captureClipReferenceDependency } = await import('../../lib/musicVideo/musicVideoDependencies.js');
    const { musicVideoCatalogReferenceId } = await import('../../lib/musicVideo/musicVideoConditioning.js');
    const { getDependencyImpact } = await import('./revisionService.js');
    await import('./catalogCheckin.js');
    const catalogId = musicVideoCatalogReferenceId('lead', 'catalog.png');
    const local = { id: 'local', imageId: 'local.png', label: 'Local guide', role: 'character', condition: true };
    const replaced = { ...local, id: 'replaced', imageId: 'before.png' };
    const subject = { id: 'lead', kind: 'character', name: 'Ada', ingredientId: 'cat-lead' };
    const item = { subjectId: subject.id, ingredientId: subject.ingredientId, kind: subject.kind, name: subject.name, images: ['catalog.png'] };
    const checkin = { items: [item], problems: [] };
    const p = await projects.createProject({ name: 'Catalog outage' });
    const addShot = async (clipReferenceIds) => {
      const { scenes: [{ sceneId }] } = await projects.addProjectScenes(p.id, [{ startSec: 0, endSec: 2, prompt: 'Ada' }]);
      return { sceneId, clipReferenceIds };
    };
    const catalog = await addShot([catalogId]);
    const localOnly = await addShot([local.id]);
    const changed = await addShot([catalogId]);
    const auto = await addShot(null);
    const mixed = await addShot([catalogId, replaced.id]);
    const shots = new Map([catalog, localOnly, changed, auto, mixed].map(shot => [shot.sceneId, shot]));
    const project = { concept: { subjects: [subject] }, visualSpec: { references: [local, replaced] },
      castAndSets: { source: 'catalog', catalogCheckin: checkin } };
    const record = (scene) => {
      const ref = captureClipReferenceDependency(project, scene);
      if (version === 'new') return ref;
      const { role, sceneId, assetId, revision, untrackedCastGuides } = ref;
      return { role, sceneId, assetId, revision, untrackedCastGuides };
    };
    const catalogRef = record(catalog);
    const localRef = record(localOnly);
    const changedRef = record({ ...changed, clipReferenceIds: [] });
    const autoRef = record({ ...auto, frameReferenceIds: [local.id] });
    const mixedRef = record(mixed);
    const refs = new Map([catalogRef, localRef, changedRef, autoRef, mixedRef].map(ref => [ref.sceneId, ref]));
    await projects.mutateProjectRecord(p.id, current => ({
      project: {
        ...current, concept: project.concept, castAndSets: { source: 'catalog' },
        visualSpec: { references: [local, { ...replaced, imageId: 'after.png' }] },
        renderHistoryId: 'render-1',
        renderDependencies: { version: 1, references: [catalogRef, changedRef] },
        scenes: current.scenes.map(scene => ({
          ...scene, ...shots.get(scene.sceneId),
          ...(scene.sceneId === auto.sceneId ? { frameReferenceIds: [local.id] } : {}),
          videoHistoryId: 'clip-1',
          takes: [{ takeId: 'take', kind: 'video', assetId: 'clip-1', source: 'generated', status: 'candidate',
            dependencies: { version: 1, references: [refs.get(scene.sceneId)] } }],
        })),
      },
    }), { sceneOnly: true, presentProject: false });

    const actual = withCatalogCheckin.getMockImplementation();
    let currentCheckin = checkin;
    withCatalogCheckin.mockImplementation(async stored => ({
      ...stored, castAndSets: { ...stored.castAndSets, catalogCheckin: currentCheckin },
    }));
    const statuses = result => Object.fromEntries(result.scenes.map(scene => [scene.sceneId, scene.takes[0].dependencyState.status]));
    try {
      const before = await projects.getProject(p.id);
      expect(statuses(before)).toEqual({
        [catalog.sceneId]: 'current', [localOnly.sceneId]: 'current', [changed.sceneId]: 'stale', [auto.sceneId]: 'current', [mixed.sceneId]: 'stale',
      });

      currentCheckin = { items: [{ ...item, images: [] }], problems: [{ code: 'CATALOG_UNAVAILABLE', subjectId: subject.id }] };
      const during = await projects.getProject(p.id);
      expect(statuses(during)).toEqual({
        [catalog.sceneId]: 'unknown', [localOnly.sceneId]: 'current', [changed.sceneId]: 'stale', [auto.sceneId]: 'current',
        [mixed.sceneId]: version === 'legacy' ? 'unknown' : 'stale',
      });
      expect(during.renderDependencyState).toEqual({ status: 'stale',
        reasons: ['Catalog references could not be read; review again', 'Selected clip references changed'] });
      const impact = await getDependencyImpact(p.id);
      expect(new Set(impact.shots.map(shot => shot.sceneId))).toEqual(new Set(
        version === 'legacy' ? [changed.sceneId] : [changed.sceneId, mixed.sceneId],
      ));

      currentCheckin = checkin;
      const restored = await projects.getProject(p.id);
      expect(statuses(restored)).toEqual(statuses(before));
      expect(restored.renderDependencyState).toEqual({ status: 'stale', reasons: ['Selected clip references changed'] });
      expect(restored.scenes.flatMap(scene => scene.takes[0].dependencies.references)).toEqual(restored.scenes.map(scene => refs.get(scene.sceneId)));
    } finally {
      withCatalogCheckin.mockImplementation(actual);
    }
  });
});

// Hold a public mutation immediately before the real backend acquires its write
// queue, allowing another request to commit first.
async function pauseSceneWrite(start) {
  const backend = await import('./projectsFile.js');
  let entered;
  let resume;
  const reached = new Promise(resolve => { entered = resolve; });
  const released = new Promise(resolve => { resume = resolve; });
  const original = backend.mutateProjectRecord;
  const spy = vi.spyOn(backend, 'mutateProjectRecord').mockImplementationOnce(async (...args) => {
    entered();
    await released;
    return original(...args);
  });
  const result = start();
  // Attach immediately: rejected service calls must not become unhandled while
  // the test is committing the intervening lock.
  const settled = result.then(value => ({ value }), error => ({ error }));
  await reached;
  spy.mockRestore();
  return { settled, resume };
}

describe('scene mutation transactions', () => {
  it('marks Done against the persisted shot sheet without reverting a concurrent direction edit', async () => {
    const p = await projects.createProject({ name: 'Concurrent shot direction' });
    const { scenes: [scene] } = await projects.addProjectScenes(p.id, [{ prompt: 'Original' }]);
    await projects.updateScene(p.id, scene.sceneId, { shotSheet: { location: 'Park' } });
    const pending = await pauseSceneWrite(() => projects.updateScene(p.id, scene.sceneId, { shotSheet: { checked: true } }));
    try {
      await projects.updateScene(p.id, scene.sceneId, { shotSheet: { location: 'Station', emotion: 'Hopeful' } });
    } finally {
      pending.resume();
    }
    expect(await pending.settled).toMatchObject({ value: { shotSheet: { checked: true, location: 'Station', emotion: 'Hopeful' } } });
    expect((await projects.getProject(p.id)).scenes[0].shotSheet).toEqual({ checked: true, location: 'Station', emotion: 'Hopeful' });
    // Existing complete rewrites and explicit clears retain their replacement contract.
    expect((await projects.updateScene(p.id, scene.sceneId, { shotSheet: { location: 'Home' } })).shotSheet).toEqual({ location: 'Home' });
    expect((await projects.updateScene(p.id, scene.sceneId, { shotSheet: null })).shotSheet).toBeNull();
  });

  it('applies a pending edit to the fresh scene without overwriting a concurrent edit', async () => {
    const p = await projects.createProject({ name: 'Concurrent scene edit' });
    const { scenes: [scene] } = await projects.addProjectScenes(p.id, [{ startSec: 0, endSec: 2, prompt: 'Original' }]);
    const pending = await pauseSceneWrite(() => projects.updateScene(p.id, scene.sceneId, { prompt: 'Pending edit' }));
    try {
      await projects.updateScene(p.id, scene.sceneId, { framePrompt: 'Concurrent reference direction' });
    } finally {
      pending.resume();
    }
    expect(await pending.settled).toMatchObject({ value: { prompt: 'Pending edit', framePrompt: 'Concurrent reference direction' } });
    expect((await projects.getProject(p.id)).scenes[0]).toMatchObject({ prompt: 'Pending edit', framePrompt: 'Concurrent reference direction' });
  });

  it('merges the current neighbor after a concurrent reorder', async () => {
    const p = await projects.createProject({ name: 'Merge neighbor race' });
    const { scenes: [a, b, c] } = await projects.addProjectScenes(p.id, [
      { startSec: 0, endSec: 1, prompt: 'First' },
      { startSec: 1, endSec: 2, prompt: 'Original next' },
      { startSec: 2, endSec: 3, prompt: 'New next' },
    ]);
    const pending = await pauseSceneWrite(() => boardEdits.mergeProjectNextScene(p.id, a.sceneId));
    try {
      await boardEdits.reorderProjectScenes(p.id, [a.sceneId, c.sceneId, b.sceneId]);
    } finally {
      pending.resume();
    }
    const { value } = await pending.settled;
    expect(value.project.scenes.map(scene => scene.sceneId)).toEqual([a.sceneId, b.sceneId]);
    expect(value.scene.endSec).toBe(2);
  });
});

describe('automatic shot clean-up (#15317)', () => {
  // Uniquely catches a delete or split leaving default labels on their old numbers ("Shot 40 · Shot 41").
  it('renumbers default "Shot N" labels after a delete and a split, leaving custom labels alone', async () => {
    const p = await projects.createProject({ name: 'Renumber shots' });
    const { scenes: [a, b, c, d] } = await projects.addProjectScenes(p.id, [
      { startSec: 0, endSec: 2, label: 'Shot 1' },
      { startSec: 2, endSec: 4, label: 'Shot 2' },
      { startSec: 4, endSec: 6, label: 'Shot 3' },
      { startSec: 6, endSec: 8, label: 'Fence run' },
    ]);
    const { project: deleted } = await boardEdits.deleteScene(p.id, b.sceneId);
    expect(deleted.scenes.map(scene => scene.label)).toEqual(['Shot 1', 'Shot 2', 'Fence run']);
    const { scenes: pieces } = await boardEdits.splitProjectScene(p.id, a.sceneId, { atSec: 1 });
    expect(pieces.map(scene => scene.label)).toEqual(['Shot 1', 'Shot 2']);
    const stored = await projects.getProject(p.id);
    expect(stored.scenes.map(scene => [scene.sceneId === c.sceneId || scene.sceneId === d.sceneId ? scene.sceneId : 'piece', scene.label]))
      .toEqual([['piece', 'Shot 1'], ['piece', 'Shot 2'], [c.sceneId, 'Shot 3'], [d.sceneId, 'Fence run']]);
  });
});

describe('moving the cut before a shot', () => {
  // Uniquely catches a start move that leaves a gap or overlap with the shot before.
  it('starts the shot at the new time and ends the shot before it there, even with legacy video locks', async () => {
    const p = await projects.createProject({ name: 'Move a cut' });
    const { scenes: [a, b] } = await projects.addProjectScenes(p.id, [
      { startSec: 0, endSec: 2, prompt: 'First' },
      { startSec: 2, endSec: 4, prompt: 'Second' },
    ]);
    const later = await boardEdits.moveProjectSceneStart(p.id, b.sceneId, { startSec: 2.5 });
    expect([later.previous.endSec, later.scene.startSec, later.scene.endSec]).toEqual([2.5, 2.5, 4]);
    const earlier = await boardEdits.moveProjectSceneStart(p.id, b.sceneId, { startSec: 1.25 });
    expect(earlier.project.scenes.map((scene) => [scene.startSec, scene.endSec])).toEqual([[0, 1.25], [1.25, 4]]);
    await expect(boardEdits.moveProjectSceneStart(p.id, b.sceneId, { startSec: 4 })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(boardEdits.moveProjectSceneStart(p.id, b.sceneId, { startSec: 0 })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await projects.updateScene(p.id, a.sceneId, { videoHistoryId: 'clip-a' });
    await projects.mutateProjectRecord(p.id, (current) => ({ project: withLegacyClipLock(current, a.sceneId, 'clip-a') }));
    await boardEdits.moveProjectSceneStart(p.id, b.sceneId, { startSec: 1.5 });
    expect((await projects.getProject(p.id)).scenes.map((scene) => [scene.startSec, scene.endSec])).toEqual([[0, 1.5], [1.5, 4]]);
  });
});

describe('anchoring shots to the sung lyrics', () => {
  // Both shots follow the sung lyric even if an old video lock exists.
  it('re-anchors the named shots and refreshes their lyrics despite legacy locks', async () => {
    const { syncLyricAnchors } = await import('./productionReviewService.js');
    const p = await projects.createProject({ name: 'Anchor lyrics' });
    const { scenes: [a, b] } = await projects.addProjectScenes(p.id, [
      { startSec: 0, endSec: 2, prompt: 'First', lyricText: 'old line' },
      { startSec: 2, endSec: 4, prompt: 'Second', lyricText: 'old line' },
    ]);
    await projects.mutateProjectRecord(p.id, (current) => ({ project: { ...current,
      lyricCues: [{ id: 'c1', text: 'sung over both', startSec: 0, endSec: 4 }],
      productionReview: { draft: { storyboard: [a, b].map((s) => ({ sceneId: s.sceneId, lyricCueIds: [] })) } } } }));
    await projects.updateScene(p.id, b.sceneId, { videoHistoryId: 'clip-b' });
    await projects.mutateProjectRecord(p.id, (current) => ({ project: withLegacyClipLock(current, b.sceneId, 'clip-b') }));
    const { project } = await syncLyricAnchors(p.id, { sceneIds: [a.sceneId, b.sceneId] });
    expect(project.productionReview.draft.storyboard.map((row) => row.lyricCueIds)).toEqual([['c1'], ['c1']]);
    expect(project.scenes.map((scene) => scene.lyricText)).toEqual(['sung over both', 'sung over both']);
  });
});

describe('board time order (#16117)', () => {
  // Uniquely catches a cut move on a board saved out of time order taking the stored neighbour
  // instead of the shot that plays before it.
  it('reads a board saved out of order in time order and moves a cut against the real previous shot', async () => {
    const p = await projects.createProject({ name: 'Out of order' });
    const { scenes: [a, b, c] } = await projects.addProjectScenes(p.id, [
      { startSec: 0, endSec: 2, prompt: 'First' },
      { startSec: 2, endSec: 4, prompt: 'Second' },
      { startSec: 4, endSec: 6, prompt: 'Third' },
    ]);
    const file = await import('./projectsFile.js');
    const all = await file.loadAll();
    const saved = all.find((record) => record.id === p.id);
    saved.scenes = [saved.scenes[2], saved.scenes[0], saved.scenes[1]].map((scene, order) => ({ ...scene, order }));
    await file.saveAll(all);
    const ids = (project) => project.scenes.map((scene) => scene.sceneId);
    const read = await projects.getProject(p.id);
    expect(ids(read)).toEqual([a.sceneId, b.sceneId, c.sceneId]);
    expect(read.scenes.map((scene) => scene.order)).toEqual([0, 1, 2]);
    expect(read.updatedAt).toBe(saved.updatedAt);
    const moved = await boardEdits.moveProjectSceneStart(p.id, c.sceneId, { startSec: 3 });
    expect(moved.previous.sceneId).toBe(b.sceneId);
    expect((await file.getProject(p.id)).scenes.map((scene) => [scene.sceneId, scene.startSec, scene.endSec, scene.order]))
      .toEqual([[a.sceneId, 0, 2, 0], [b.sceneId, 2, 3, 1], [c.sceneId, 3, 6, 2]]);
  });
});
