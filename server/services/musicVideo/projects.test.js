/**
 * Music Video dispatcher — peer-sync record-event wiring (#1770). Asserts the
 * dispatcher fires the recordEvents emits (announce on create, updated on every
 * structural mutator, deleted on tombstone) so a project federates after a local
 * edit. The backend is exercised for real via the file backend (NODE_ENV=test);
 * only recordEvents is mocked so we can spy on the emits.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
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
