import { plateReviewEvidence } from '../../lib/musicVideoPlateEvidence.js';
import { plateRequirements, selectedPlatePasses } from '../../lib/musicVideoPlateEvidence.js';
/**
 * Music Video file-backend round-trip (#1760). Runs against a tmpdir in the
 * normal (non-DB) suite — covers create/list/get/update/delete + the scene-board
 * mutators + analysis caching + soft-delete, without touching real `data/` or
 * needing Postgres. The PG backend shares the same projectsLogic decisions, so
 * its row I/O mirrors this.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TEST_DATA_ROOT = mkdtempSync(join(tmpdir(), 'mv-projects-file-test-'));
const writeCounter = vi.hoisted(() => ({ project: 0, baseHash: 0 }));

vi.mock('../../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    PATHS: { ...actual.PATHS, data: TEST_DATA_ROOT },
    atomicWrite: async (path, data) => {
      if (typeof path === 'string' && path.endsWith('music-video-projects.json')) writeCounter.project += 1;
      if (typeof path === 'string' && path.endsWith('sync_base_hashes.json')) writeCounter.baseHash += 1;
      return actual.atomicWrite(path, data);
    },
  };
});

const file = await import('./projectsFile.js');
const cj = await import('../../lib/conflictJournal.js');

function reset() {
  rmSync(join(TEST_DATA_ROOT, 'music-video-projects.json'), { force: true });
  rmSync(join(TEST_DATA_ROOT, 'sharing'), { recursive: true, force: true });
  rmSync(join(TEST_DATA_ROOT, 'conflict-journal'), { recursive: true, force: true });
  cj.__resetBaseHashCacheForTests();
  writeCounter.baseHash = 0;
  writeCounter.project = 0;
}
beforeEach(reset);
afterAll(() => rmSync(TEST_DATA_ROOT, { recursive: true, force: true }));

describe('projectsFile backend', () => {
  it('creates, lists, and gets a project', async () => {
    const created = await file.createProject({ name: 'MV One', trackId: 't1' });
    expect(created.id).toMatch(/^mv-/);
    const list = await file.listProjects();
    expect(list).toHaveLength(1);
    expect((await file.getProject(created.id)).name).toBe('MV One');
  });

  it('updates project metadata', async () => {
    const p = await file.createProject({ name: 'A' });
    const updated = await file.updateProject(p.id, { name: 'B', status: 'ready' });
    expect(updated.name).toBe('B');
    expect(updated.status).toBe('ready');
  });

  it('caches audio analysis and flips draft to analyzed', async () => {
    const p = await file.createProject({ name: 'A' });
    const analysis = { bpm: 128, beats: [0], downbeats: [0], sections: [], durationSec: 10 };
    const updated = await file.setProjectAnalysis(p.id, analysis);
    expect(updated.audioAnalysis).toEqual(analysis);
    expect(updated.status).toBe('analyzed');
  });

  it('runs the full scene-board lifecycle', async () => {
    const p = await file.createProject({ name: 'A' });
    const s1 = await file.addProjectScene(p.id, { prompt: 'one' });
    const s2 = await file.addProjectScene(p.id, { prompt: 'two' });
    expect(s1.order).toBe(0);
    expect(s2.order).toBe(1);

    const upd = await file.updateScene(p.id, s1.sceneId, { prompt: 'one-edited' });
    expect(upd.prompt).toBe('one-edited');

    let proj = await file.reorderProjectScenes(p.id, [s2.sceneId, s1.sceneId]);
    expect(proj.scenes.map((s) => s.sceneId)).toEqual([s2.sceneId, s1.sceneId]);

    proj = await file.deleteScene(p.id, s2.sceneId);
    expect(proj.scenes).toHaveLength(1);
    expect(proj.scenes[0].order).toBe(0);
  });

  it('soft-deletes a project (tombstone hidden from live list)', async () => {
    const p = await file.createProject({ name: 'A' });
    await file.deleteProject(p.id);
    expect(await file.listProjects()).toHaveLength(0);
    expect(await file.getProject(p.id)).toBeNull();
    expect(await file.listProjects({ includeDeleted: true })).toHaveLength(1);
  });

  it('404s mutating a deleted project (no resurrection)', async () => {
    const p = await file.createProject({ name: 'A' });
    await file.deleteProject(p.id);
    await expect(file.updateProject(p.id, { name: 'X' })).rejects.toThrow(/not found/i);
    await expect(file.addProjectScene(p.id, { prompt: 'x' })).rejects.toThrow(/not found/i);
  });
});

describe('projectsFile federation (#1770)', () => {
  it('listProjectIds returns live ids, or all when includeDeleted', async () => {
    const a = await file.createProject({ name: 'A' });
    const b = await file.createProject({ name: 'B' });
    await file.deleteProject(b.id);
    expect(await file.listProjectIds()).toEqual([a.id]);
    expect((await file.listProjectIds({ includeDeleted: true })).sort()).toEqual([a.id, b.id].sort());
  });

  // #8964 — timed lyric cues, phrase annotations, pacing, and per-shot loop
  // semantics are editable record state: they must survive reload, clone, and
  // a peer round trip, and an audio-source change must invalidate the timings
  // (derived from the old track) while keeping the director's text.
  it('persists timed text + shot fields through reload, clone, and peer sync; an audio change clears the timings', async () => {
    const p = await file.createProject({ name: 'Lyric MV', trackId: 't1' });
    expect(p).toMatchObject({ lyricCues: [], phrases: [], pacing: null });

    await file.updateProject(p.id, {
      lyricCues: [
        { text: '  first line  ', startSec: 1.25, endSec: 3 },
        { text: '   ', startSec: 4 }, // empty → dropped
        { text: 'second line', startSec: 5, endSec: 4 }, // backwards end → open end
        { text: 'untimed line' },
      ],
      phrases: [{ label: 'Lift', startSec: 8, endSec: 16, intent: 'rise above the city' }],
      pacing: { minShotSec: 1.5, maxShotSec: 6, hookSec: 2 },
    });
    const saved = await file.getProject(p.id);
    expect(saved.lyricCues).toEqual([
      { id: expect.stringMatching(/^lc-/), text: 'first line', startSec: 1.25, endSec: 3 },
      { id: expect.stringMatching(/^lc-/), text: 'second line', startSec: 5, endSec: null },
      { id: expect.stringMatching(/^lc-/), text: 'untimed line', startSec: null, endSec: null },
    ]);
    expect(saved.phrases).toEqual([
      { id: expect.stringMatching(/^mp-/), label: 'Lift', intent: 'rise above the city', startSec: 8, endSec: 16 },
    ]);
    // Editing a line keeps its id (the list is replaced whole, entries by id).
    const retimed = saved.lyricCues.map((c, i) => (i === 2 ? { ...c, startSec: 9 } : c));
    const edited = await file.updateProject(p.id, { lyricCues: retimed });
    expect(edited.lyricCues.map((c) => c.id)).toEqual(saved.lyricCues.map((c) => c.id));
    expect(edited.lyricCues[2].startSec).toBe(9);

    // A new scene never loops by default; planned shot fields persist.
    await file.addProjectScenes(p.id, [
      { label: 'Verse · 1/2', sectionLabel: 'Verse', sectionIndex: 0, startSec: 0, endSec: 4, beatAligned: true, lyricText: 'first line' },
      { label: 'Verse · 2/2', sectionLabel: 'Verse', sectionIndex: 0, startSec: 4, endSec: 8, beatAligned: true, loop: true, visualIntent: 'hold' },
    ]);
    const withScenes = await file.getProject(p.id);
    expect(withScenes.scenes.map((s) => [s.loop, s.sectionIndex, s.lyricText, s.visualIntent]))
      .toEqual([[false, 0, 'first line', null], [true, 0, null, 'hold']]);

    const clone = await file.cloneProject(p.id);
    expect(clone.lyricCues).toEqual(edited.lyricCues);
    expect(clone.phrases).toEqual(saved.phrases);
    expect(clone.pacing).toEqual({ minShotSec: 1.5, maxShotSec: 6, hookSec: 2 });
    expect(clone.scenes.map((s) => s.loop)).toEqual([false, true]);

    // Peer round trip: a record carrying these fields lands verbatim.
    const peerCopy = { ...withScenes, id: 'mv-peer-lyrics', updatedAt: '2099-01-01T00:00:00Z' };
    await file.mergeProjectsFromSync([peerCopy]);
    const received = await file.getProject('mv-peer-lyrics');
    expect(received.lyricCues).toEqual(withScenes.lyricCues);
    expect(received.phrases).toEqual(withScenes.phrases);
    expect(received.scenes).toEqual(withScenes.scenes);

    const swapped = await file.updateProject(p.id, { trackId: 't2' });
    expect(swapped.lyricCues.map((c) => [c.id, c.text, c.startSec, c.endSec]))
      .toEqual(edited.lyricCues.map((c) => [c.id, c.text, null, null]));
    expect(swapped.phrases).toEqual([{ ...saved.phrases[0], startSec: null, endSec: null }]);
  });

  it('keeps a nudged word boundary through reload and clone, and drops words when the audio changes (#9074)', async () => {
    const p = await file.createProject({ name: 'Karaoke', trackId: 't1' });
    const nudged = [
      { w: 'walking', startSec: 1, endSec: 1.55, conf: 'matched' },
      { w: 'home', startSec: 1.55, endSec: 2, conf: 'matched' },
    ];
    await file.updateProject(p.id, {
      lyricCues: [{ id: 'lc-1', text: 'walking home', startSec: 1, endSec: 2, words: nudged, matched: 0.4 }],
    });
    const saved = await file.getProject(p.id);
    expect(saved.lyricCues[0].words).toEqual(nudged);
    expect(saved.lyricCues[0].text).toBe('walking home');
    expect(saved.lyricCues[0].matched).toBe(0.4);
    expect((await file.cloneProject(p.id)).lyricCues[0].words).toEqual(nudged);

    const retitled = await file.updateProject(p.id, {
      lyricCues: [{ id: 'lc-1', text: 'walking house', startSec: 1, endSec: 2, words: nudged, matched: 0.4 }],
    });
    expect(retitled.lyricCues[0]).toMatchObject({ text: 'walking house', startSec: 1, endSec: 2 });
    expect(retitled.lyricCues[0].words).toBeUndefined();
    expect(retitled.lyricCues[0].matched).toBeUndefined();

    await file.updateProject(p.id, {
      lyricCues: [{ id: 'lc-1', text: 'walking home', startSec: 1, endSec: 2, words: nudged, matched: 0.4 }],
    });
    const swapped = await file.updateProject(p.id, { trackId: 't2' });
    expect(swapped.lyricCues[0].text).toBe('walking home');
    expect(swapped.lyricCues[0].words).toBeUndefined();
    expect(swapped.lyricCues[0].matched).toBeUndefined();
    expect(swapped.lyricCues[0].startSec).toBeNull();
    expect(swapped.lyricCues[0].endSec).toBeNull();
  });

  // #8984 — the composition manifest is editable record state like the lyric
  // cues: normalized on save, carried by clone and peer sync, and its timings
  // (cue times, poster frame) cleared with the audio source, text kept.
  it('persists the composition manifest through reload, clone, and peer sync; an audio change clears its timings', async () => {
    const p = await file.createProject({ name: 'Composed MV', trackId: 't1' });
    expect(p.composition).toBeNull();

    await file.updateProject(p.id, { composition: {
      mode: 'composed',
      grade: { preset: 'teal-night', grain: 0.012, sections: [{ sceneId: 'chorus', preset: 'golden-hour' }] },
      textCues: [
        { text: ' Hook line ', startSec: 1, endSec: 3, template: 'rise', placement: 'center', emphasis: 'hero' },
        { text: 'Tail', startSec: 4, endSec: 2 },
      ],
      style: { color: '#FFCC00' },
      posterSec: 2,
      reactiveSections: [{ sectionId: 'intro', gain: 0.5, maxGain: 0.2 }],
    } });
    const saved = await file.getProject(p.id);
    expect(saved.composition).toEqual({
      version: 1,
      mode: 'composed',
      grade: { preset: 'teal-night', grain: 0.012, sections: [{ sceneId: 'chorus', preset: 'golden-hour' }] },
      textCues: [
        { id: expect.stringMatching(/^mtc-/), text: 'Hook line', startSec: 1, endSec: 3, template: 'rise', placement: 'center', emphasis: 'hero' },
        { id: expect.stringMatching(/^mtc-/), text: 'Tail', startSec: 4, endSec: null, template: 'fade', placement: 'lower', emphasis: 'subtitle' },
      ],
      style: { color: '#ffcc00', font: 'sans' },
      posterSec: 2,
      reactiveSections: [{ sectionId: 'intro', gain: 0.5, maxGain: 0.2 }],
    });

    expect((await file.cloneProject(p.id)).composition).toEqual(saved.composition);
    await file.mergeProjectsFromSync([{ ...saved, id: 'mv-peer-composed', updatedAt: '2099-01-01T00:00:00Z' }]);
    expect((await file.getProject('mv-peer-composed')).composition).toEqual(saved.composition);

    const swapped = await file.updateProject(p.id, { uploadedAudioFilename: 'other.wav' });
    expect(swapped.composition.posterSec).toBeNull();
    // Section IDs belong to the previous song: stale gain entries cannot be
    // rebound in the editor and would block future document authoring.
    expect(swapped.composition.reactiveSections).toEqual([]);
    expect((await file.getProject(p.id)).composition.reactiveSections).toEqual([]);
    expect(swapped.composition.textCues.map((c) => [c.id, c.text, c.startSec, c.endSec]))
      .toEqual(saved.composition.textCues.map((c) => [c.id, c.text, null, null]));

    expect((await file.updateProject(p.id, { composition: null })).composition).toBeNull();
  });

  it('mergeProjectsFromSync inserts a brand-new peer record', async () => {
    const remote = { id: 'mv-peer-1', name: 'Peer', status: 'draft', updatedAt: '2026-02-01T00:00:00Z', createdAt: '2026-02-01T00:00:00Z', scenes: [] };
    const res = await file.mergeProjectsFromSync([remote]);
    expect(res).toEqual({ applied: true, count: 1 });
    expect((await file.getProject('mv-peer-1')).name).toBe('Peer');
  });

  it('mergeProjectsFromSync applies a newer remote and ignores an older one', async () => {
    const p = await file.createProject({ name: 'Local' });
    const newer = { ...p, name: 'RemoteNewer', updatedAt: '2099-01-01T00:00:00Z' };
    expect(await file.mergeProjectsFromSync([newer])).toEqual({ applied: true, count: 1 });
    expect((await file.getProject(p.id)).name).toBe('RemoteNewer');

    const older = { ...p, name: 'RemoteOlder', updatedAt: '2000-01-01T00:00:00Z' };
    expect(await file.mergeProjectsFromSync([older])).toEqual({ applied: false, count: 0 });
    expect((await file.getProject(p.id)).name).toBe('RemoteNewer');
  });

  it('same-updatedAt re-push is a no-op without project or base-hash writes', async () => {
    const remote = { id: 'mv-peer-1', name: 'Peer', status: 'draft', updatedAt: '2026-02-01T00:00:00Z', createdAt: '2026-02-01T00:00:00Z', scenes: [] };
    await file.mergeProjectsFromSync([remote]);
    writeCounter.project = 0;
    writeCounter.baseHash = 0;

    expect(await file.mergeProjectsFromSync([remote])).toEqual({ applied: false, count: 0 });
    expect(writeCounter).toEqual({ project: 0, baseHash: 0 });
  });

  it('mergeProjectsFromSync applies a remote tombstone (delete federates)', async () => {
    const p = await file.createProject({ name: 'Doomed' });
    const tombstone = { ...p, deleted: true, deletedAt: '2099-01-01T00:00:00Z', updatedAt: '2099-01-01T00:00:00Z' };
    expect(await file.mergeProjectsFromSync([tombstone])).toEqual({ applied: true, count: 1 });
    expect(await file.getProject(p.id)).toBeNull();
    expect(await file.getProject(p.id, { includeDeleted: true })).toMatchObject({ deleted: true });
  });

  it('pruneTombstonedProjects batches base-hash eviction for multiple tombstones', async () => {
    const keep = await file.createProject({ name: 'Live' });
    // Insert already-old tombstones via the sync insert path (insert applies
    // regardless of LWW), so their deletedAt values sit far enough in the past
    // to prune. The newer tombstone verifies the existing eligibility predicate.
    await file.mergeProjectsFromSync([{
      id: 'mv-old-tomb-1', name: 'Old 1', status: 'draft', scenes: [],
      createdAt: '2000-01-01T00:00:00Z', updatedAt: '2000-01-02T00:00:00Z',
      deleted: true, deletedAt: '2000-01-01T00:00:00Z',
    }, {
      id: 'mv-old-tomb-2', name: 'Old 2', status: 'draft', scenes: [],
      createdAt: '2000-01-02T00:00:00Z', updatedAt: '2000-01-03T00:00:00Z',
      deleted: true, deletedAt: '2000-01-02T00:00:00Z',
    }, {
      id: 'mv-new-tomb', name: 'New', status: 'draft', scenes: [],
      createdAt: '2099-01-01T00:00:00Z', updatedAt: '2099-01-02T00:00:00Z',
      deleted: true, deletedAt: '2099-01-01T00:00:00Z',
    }]);

    expect(await cj.getSyncBaseHash('musicVideoProject', 'mv-old-tomb-1')).not.toBeNull();
    expect(await cj.getSyncBaseHash('musicVideoProject', 'mv-old-tomb-2')).not.toBeNull();

    writeCounter.baseHash = 0;
    // A future cutoff prunes the old tombstone; a pre-tombstone cutoff would not.
    expect((await file.pruneTombstonedProjects(Date.parse('1990-01-01T00:00:00Z'))).pruned).toBe(0);
    expect(writeCounter.baseHash).toBe(0);
    const res = await file.pruneTombstonedProjects(Date.parse('2010-01-01T00:00:00Z'));
    expect(res).toEqual({ pruned: 2 });
    expect(writeCounter.baseHash).toBe(1);
    cj.__resetBaseHashCacheForTests();
    expect(await cj.getSyncBaseHash('musicVideoProject', 'mv-old-tomb-1')).toBeNull();
    expect(await cj.getSyncBaseHash('musicVideoProject', 'mv-old-tomb-2')).toBeNull();
    expect((await file.listProjectIds({ includeDeleted: true })).sort()).toEqual([keep.id, 'mv-new-tomb'].sort());
  });
});

it('roundtrips asset-bound plate evidence through the real serialized project store and retains it on selection', async () => {
  const project = await file.createProject({ name: 'Example Video' });
  const scene = await file.addProjectScene(project.id, { startSec: 0, endSec: 4 });
  await file.updateScene(project.id, scene.sceneId, { referenceImageId: 'example.png' });
  await file.mutateProjectRecord(project.id, (current) => {
    const live = { ...current.scenes[0], direction: { actionContract: { version: 1, purpose: 'Two people greet', activeSpeaker: 'Person A' } } };
    const evidence = plateReviewEvidence(live, 'example.png', 'run-example', JSON.stringify({ checks: plateRequirements(live).map(({ id }) => ({ id, status: 'pass', note: 'Visible' })) }));
    return { project: { ...current, scenes: [{ ...live, takes: live.takes.map((take) => ({ ...take, plateEvidence: evidence })) }] } };
  });
  const read = await file.getProject(project.id);
  expect(selectedPlatePasses(read.scenes[0], 'run-example')).toBe(true);
  expect(read.scenes[0].takes[0].plateEvidence.assetId).toBe('example.png');
  await file.updateScene(project.id, scene.sceneId, { referenceImageId: 'changed.png' });
  const changed = await file.getProject(project.id);
  expect(selectedPlatePasses(changed.scenes[0], 'run-example')).toBe(false);
  expect(changed.scenes[0].takes.find((take) => take.assetId === 'example.png').plateEvidence.verdict).toBe('pass');
});

describe('editable code revisions and footage variants', () => {
  it('keeps scene-based code addressable in a revision and isolates subsequent edits', async () => {
    const { prepareCodeRender } = await import('./codeRender.js');
    const source = await file.createProject({ name: 'Example Animation', trackId: 'example-track' });
    const scene = await file.addProjectScene(source.id, { startSec: 0, endSec: 4 });
    const originalSource = 'function render(ctx) { ctx.fillRect(0, 0, 10, 10); }';
    await file.updateProject(source.id, { composition: { mode: 'code',
      codeVideo: { sections: [{ id: scene.sceneId, source: originalSource }] },
      reactiveSections: [{ sectionId: scene.sceneId, gain: 0.2, maxGain: 0.3 }],
    } });
    const original = await file.getProject(source.id);
    const revision = await file.cloneProject(source.id);
    const sectionId = revision.scenes[0].sceneId;
    expect(sectionId).not.toBe(scene.sceneId);
    expect(prepareCodeRender(revision).song.sections[0].id).toBe(sectionId);
    expect(revision.composition.codeVideo.sections).toEqual([{ id: sectionId, source: originalSource }]);
    expect(revision.composition.reactiveSections[0].sectionId).toBe(sectionId);
    await file.updateProject(revision.id, { composition: { ...revision.composition,
      codeVideo: { sections: [{ id: sectionId, source: 'function render(ctx) { ctx.fillRect(0, 0, 20, 20); }' }] },
    } });
    expect((await file.getProject(revision.id)).composition.codeVideo).not.toEqual(original.composition.codeVideo);
    expect(await file.getProject(source.id)).toEqual(original);
  });

  it('forks a document into independent photographic production with song, storyboard and immutable assets', async () => {
    const { castAndSetsMedium } = await import('./castAndSetsDirection.js');
    const { startProductionOnProject, nextProductionStep } = await import('./production.js');
    const source = await file.createProject({ name: 'Example Film', trackId: 'example-track', mediaMode: 'code-images-video',
      concept: { prompt: 'A journey home', subjects: [{ kind: 'character', name: 'Paper protagonist' }], moodBoardStyle: 'Paper world' },
      visualSpec: { moodBoardId: 'board-original', references: [{ imageId: 'original.png', role: 'character' }] },
      composition: { mode: 'document' }, productionPolicy: { strategy: 'code-first' },
      automation: { tools: ['code:render'], moodBoardId: 'board-original' },
      lyricCues: [{ text: 'Example lyric', startSec: 0, endSec: 4 }],
    });
    await file.setProjectAnalysis(source.id, { durationSec: 4, bpm: 120, beats: [0, 0.5], downbeats: [0], sections: [{ label: 'Verse', startSec: 0, endSec: 4 }] });
    const scene = await file.addProjectScene(source.id, { startSec: 0, endSec: 4, visualLayer: 'card', prompt: 'Journey home' });
    await file.updateScene(source.id, scene.sceneId, { referenceImageId: 'source.png', videoHistoryId: 'source-video' });
    await file.mutateProjectRecord(source.id, (project) => ({ project: { ...project,
      composition: { ...project.composition, document: { directory: `music-video/${source.id}/composition/example-version`, entry: 'index.html' } },
      castAndSets: { status: 'approved', direction: { medium: 'procedural' } },
      publishKit: { master: { filename: 'source-final.mp4' }, posts: { youtube: { url: 'https://example.com/source' } } },
      devArtifacts: [{ id: 'sheet-original', kind: 'cast-sets', file: 'music-video/example/dev/sheet/v1.html', versions: [{ version: 1 }] }],
      treatment: { revision: 1, appliedRevision: 1, shotDirections: [{ sceneId: scene.sceneId, route: 'code-2d', medium: 'procedural', focalSubject: 'Traveler' }], proofs: [] },
    } }));
    const original = await file.getProject(source.id);
    const fork = await file.cloneProject(source.id, { variant: 'video-generation', includeGeneratedMedia: true });
    expect(fork).toMatchObject({ parentProjectId: source.id, rootProjectId: source.id,
      trackId: original.trackId, audioAnalysis: original.audioAnalysis, lyricCues: original.lyricCues,
      composition: { mode: 'composed', document: original.composition.document },
      devArtifacts: original.devArtifacts, castAndSets: null, publishKit: null,
      productionPolicy: { strategy: 'legacy', maxGeneratedVideoPercent: 100 },
      visualSpec: { references: [], moodBoardId: null },
      concept: { prompt: 'A journey home', subjects: [], moodBoardStyle: '' },
    });
    expect(fork.scenes[0]).toMatchObject({ startSec: 0, endSec: 4, visualLayer: 'footage', referenceImageId: null, videoHistoryId: null, takes: [] });
    expect(fork.treatment.shotDirections[0]).toMatchObject({ sceneId: fork.scenes[0].sceneId, route: 'generated', medium: 'generated-footage', focalSubject: 'Traveler' });
    expect(fork.treatment.appliedRevision).toBeNull();
    expect(castAndSetsMedium(fork)).toBe('photographic');
    // Planning is pure: no queue or provider is used by this test.
    const started = startProductionOnProject(fork, { pool: [{ kind: 'image', mode: 'local' }, { kind: 'video', mode: 'local' }], processId: 'test-process', limits: { maxGenerations: 10, maxReviewAttempts: 1 } });
    expect(nextProductionStep(started.project, started.run, { processId: 'test-process' }).type).toBe('plan-pilots');
    await file.updateProject(fork.id, { visualSpec: { moodBoardId: 'board-variant' } });
    await file.mutateProjectRecord(fork.id, (project) => ({ project: { ...project, castAndSets: { status: 'review', direction: { protagonist: { name: 'New cast' } } } } }));
    expect((await file.getProject(fork.id)).visualSpec.moodBoardId).toBe('board-variant');
    expect(await file.getProject(source.id)).toEqual(original);
  });
});
