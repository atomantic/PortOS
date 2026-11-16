import { afterEach, expect, it, vi } from 'vitest';
import * as checksums from './snapshotChecksum.js';
import { captureImageFrameDependencies, captureMusicVideoEvidence, captureTakeDependencies, musicVideoTakeChanges, presentMusicVideoDependencies } from './musicVideoDependencies.js';
import { musicVideoSceneCastIds } from './musicVideoConditioning.js';

afterEach(() => vi.restoreAllMocks());

const projectFixture = () => ({
  id: 'mv-synthetic',
  lyricCues: [{ id: 'cue', text: 'Synthetic lyric', startSec: 0, endSec: 10 }],
  composition: { cues: [{ startSec: 0, endSec: 5, text: 'First' }, { startSec: 5, endSec: 10, text: 'Second' }] },
  scenes: [0, 1].map(i => ({ sceneId: `scene-${i}`, startSec: i * 5, endSec: i * 5 + 5,
    visualLayer: 'still', referenceImageId: `image-${i}.png`, takes: [] })),
});

it('bounds checksum work by distinct current inputs across historical snapshots and refreshes after edits', () => {
  const project = projectFixture();
  const dependencies = captureMusicVideoEvidence(project);
  project.renderHistoryId = 'final';
  project.renderDependencies = dependencies;
  project.excerpts = Array.from({ length: 40 }, (_, i) => ({ id: `excerpt-${i}`, dependencies: structuredClone(dependencies) }));
  const checksum = vi.spyOn(checksums, 'canonicalSnapshotChecksum');

  presentMusicVideoDependencies({ ...project, excerpts: project.excerpts.slice(0, 1) });
  const oneSnapshotWork = checksum.mock.calls.length;
  checksum.mockClear();
  const current = presentMusicVideoDependencies(project);
  expect(current.excerpts.every(excerpt => excerpt.dependencyState.status === 'current')).toBe(true);
  expect(checksum.mock.calls.length).toBe(oneSnapshotWork);

  project.lyricCues[0].text = 'Revised synthetic lyric';
  const songChanged = presentMusicVideoDependencies(project);
  expect(songChanged.renderDependencyState.status).toBe('stale');
  expect(songChanged.excerpts.every(excerpt => excerpt.dependencyState.reasons.includes('Master audio, lyrics or alignment changed'))).toBe(true);

  project.lyricCues[0].text = 'Synthetic lyric';
  project.scenes[0].referenceImageId = 'replacement.png';
  expect(presentMusicVideoDependencies(project).renderDependencyState.reasons).toEqual(['Selected plate or its crop/mask inputs changed']);
  expect(dependencies).toEqual(project.excerpts[0].dependencies);
});

it('marks a reviewed render stale when Use end frame turns off', () => {
  const project = projectFixture();
  project.scenes[0].imageEffect = 'end-flash';
  project.scenes[0].endImageId = 'end.png';
  project.renderHistoryId = 'final';
  project.renderDependencies = captureMusicVideoEvidence(project);
  expect(presentMusicVideoDependencies(project).renderDependencyState.status).toBe('current');
  project.scenes[0].endFrameOff = true;
  expect(presentMusicVideoDependencies(project).renderDependencyState.reasons).toContain('Shot timing or composition layer changed');
});

// Uniquely catches a final render going out of date at once because a kept clip was made from an older plate.
it('keeps a final render current when its selected clip was made from a different plate', () => {
  const project = projectFixture();
  Object.assign(project.scenes[0], { visualLayer: 'footage', referenceImageId: 'new.png', videoHistoryId: 'clip.mp4',
    takes: [{ takeId: 't1', kind: 'video', assetId: 'clip.mp4', sourceImageId: 'old.png', status: 'selected' }] });
  project.renderHistoryId = 'final';
  project.renderDependencies = captureMusicVideoEvidence(project, { clipFrames: false });
  expect(presentMusicVideoDependencies(project).renderDependencyState.status).toBe('current');
  project.renderDependencies = captureMusicVideoEvidence(project);
  expect(presentMusicVideoDependencies(project).renderDependencyState.status).toBe('stale');
});

const frameState = (project, scene, take) => presentMusicVideoDependencies({
  ...project, scenes: [{ ...scene, takes: [take] }],
}).scenes[0].takes[0].dependencyState;

const frameShot = (over = {}) => ({
  sceneId: 's1', framePrompt: 'Ada rides away at dusk', referenceImageId: 'a.png',
  shotSheet: { cameraId: 'cam-1', location: 'Harbor', characters: ['Ada'] },
  camera: { move: 'push', speed: 'slow' }, frameReferenceIds: ['ref-a.png'], takes: [], ...over,
});

it('marks a selected frame stale when its prompt, camera, location, cast or references change, and current again when they are restored', () => {
  const project = { id: 'mv-synthetic', scenes: [frameShot()] };
  const scene = project.scenes[0];
  const frame = { kind: 'image', assetId: 'a.png', prompt: 'Ada rides away at dusk, grain.',
    frameDependencies: captureImageFrameDependencies(project, scene, { slot: 'start' }) };
  scene.takes = [frame];
  expect(frameState(project, scene, frame)).toEqual({ status: 'current', reasons: [] });

  scene.framePrompt = 'Ada waits at the curb';
  expect(frameState(project, scene, frame)).toEqual({ status: 'stale', reasons: ['Frame prompt changed'] });
  expect(frame.prompt).toBe('Ada rides away at dusk, grain.');
  expect(frame.assetId).toBe('a.png');
  expect(scene.referenceImageId).toBe('a.png');
  scene.framePrompt = 'Ada rides away at dusk';
  expect(frameState(project, scene, frame).status).toBe('current');

  scene.camera = { move: 'pan', speed: 'slow' };
  expect(frameState(project, scene, frame).reasons).toEqual(['Camera changed']);
  scene.camera = { move: 'push', speed: 'slow' };
  scene.shotSheet = { ...scene.shotSheet, cameraId: 'cam-2' };
  expect(frameState(project, scene, frame).reasons).toEqual(['Camera changed']);
  delete scene.shotSheet.cameraId;
  expect(frameState(project, scene, frame).reasons).toEqual(['Camera changed']);
  scene.shotSheet = { ...scene.shotSheet, cameraId: 'cam-1', location: 'Alley' };
  expect(frameState(project, scene, frame).reasons).toEqual(['Location changed']);
  scene.shotSheet = { cameraId: 'cam-1', location: 'Harbor', characters: ['Ben'] };
  expect(frameState(project, scene, frame).reasons).toEqual(['Cast changed']);
  scene.shotSheet = { cameraId: 'cam-1', location: 'Harbor', characters: ['Ada'] };
  scene.frameReferenceIds = ['ref-b.png'];
  expect(frameState(project, scene, frame).reasons).toEqual(['Reference image replaced']);
  scene.frameReferenceIds = ['ref-a.png'];
  expect(frameState(project, scene, frame).status).toBe('current');
});

it('keeps ambiguous legacy prompt inclusion unknown without blocking selection, but detects a definite replacement', () => {
  const scene = frameShot();
  const project = { scenes: [scene] };
  const composed = { kind: 'image', assetId: 'a.png', prompt: 'Style. Ada rides away at dusk, grain.' };
  expect(frameState(project, scene, composed).status).toBe('unknown');
  expect(frameState(project, scene, { ...composed, prompt: scene.framePrompt })).toEqual({ status: 'current', reasons: [] });
  scene.framePrompt = 'Ada rides';
  expect(frameState(project, scene, composed).status).toBe('unknown');
  const rewritten = { ...composed, prompt: 'A different street' };
  expect(frameState(project, scene, rewritten)).toEqual({ status: 'stale', reasons: ['Frame prompt changed'] });
  const imported = { kind: 'image', assetId: 'a.png', prompt: null };
  expect(frameState(project, scene, imported).status).toBe('unknown');
  expect(musicVideoTakeChanges(project, scene, imported)).toEqual([]);
  scene.takes = [rewritten, { kind: 'video', assetId: 'clip', sourceImageId: 'a.png', dependencies: captureTakeDependencies(scene, 'a.png') }];
  const clip = presentMusicVideoDependencies(project).scenes[0].takes[1];
  expect(clip.dependencyState.status).toBe('stale');
  expect(clip.dependencyState.reasons).toContain('Frame prompt changed');
});

it('records an unset reference choice so later adding a reference stales the frame', () => {
  const scene = frameShot({ frameReferenceIds: undefined });
  const project = { scenes: [scene] };
  const frame = { kind: 'image', assetId: 'a.png', frameDependencies: captureImageFrameDependencies(project, scene) };
  const older = { ...frame, frameDependencies: { ...frame.frameDependencies,
    references: frame.frameDependencies.references.filter((ref) => ref.role !== 'frameReferences') } };
  expect(frameState(project, scene, frame).status).toBe('current');
  expect(frameState(project, scene, older).status).toBe('current');
  scene.frameReferenceIds = ['new-reference.png'];
  expect(frameState(project, scene, frame)).toEqual({ status: 'stale', reasons: ['Reference image replaced'] });
  expect(frameState(project, scene, older)).toEqual({ status: 'stale', reasons: ['Reference image replaced'] });
  scene.frameReferenceIds = undefined;
  expect(frameState(project, scene, frame).status).toBe('current');
});

it('lists thirty rewritten shots as stale frames from one read', () => {
  const scenes = Array.from({ length: 30 }, (_, i) => {
    const scene = { sceneId: `s${i}`, framePrompt: `Original ${i}`, referenceImageId: `f${i}.png`, takes: [] };
    const frame = { kind: 'image', assetId: `f${i}.png`, prompt: `Original ${i}, grain.`,
      frameDependencies: captureImageFrameDependencies({ scenes: [scene] }, scene, { slot: 'start' }) };
    scene.takes = [frame, { kind: 'video', assetId: `c${i}`, sourceImageId: frame.assetId, dependencies: captureTakeDependencies({ ...scene, takes: [frame] }, frame.assetId) }];
    scene.framePrompt = `Rewritten ${i}`;
    return scene;
  });
  const presented = presentMusicVideoDependencies({ scenes });
  const staleFrames = presented.scenes.filter((scene) => scene.takes.find((take) => take.kind === 'image').dependencyState.reasons.includes('Frame prompt changed'));
  expect(staleFrames).toHaveLength(30);
  expect(staleFrames.every((scene) => scene.takes.find((take) => take.kind === 'video').dependencyState.status === 'stale')).toBe(true);
  expect(staleFrames[0].referenceImageId).toBe('f0.png');
  expect(staleFrames[0].takes[0].prompt).toBe('Original 0, grain.');
});

it('keeps distinct rendered windows independent when caching composition and scene-set references', () => {
  const project = projectFixture();
  project.excerpts = [0, 5].map(startSec => ({ dependencies: captureMusicVideoEvidence(project, { startSec, endSec: startSec + 5 }) }));
  project.composition.cues[0].text = 'Revised first window';

  const changed = presentMusicVideoDependencies(project);
  expect(changed.excerpts.map(excerpt => excerpt.dependencyState.status)).toEqual(['stale', 'current']);
  expect(changed.excerpts[0].dependencyState.reasons).toEqual(['Composition changed']);

  project.scenes[0].endSec = 6;
  expect(presentMusicVideoDependencies(project).excerpts.map(excerpt => excerpt.dependencyState.status)).toEqual(['stale', 'stale']);
});

// #16274: a catalog project's check-in is resolved on read and never stored, so the cast fingerprint
// must not read it. `presented` is the same record as GET shows it, with its check-in.
const castProject = () => {
  const subject = (id, kind, name, ingredientId) => ({ id, kind, name, ingredientId });
  const subjects = [subject('subj-a', 'character', 'Ada', 'cat-chr-a'), subject('subj-b', 'character', 'Ben', 'cat-chr-b'),
    subject('subj-p', 'place', 'Harbor', 'cat-plc')];
  const scene = frameShot({ frameReferenceIds: ['mvr-linked-0000000000000001'] });
  const stored = { id: 'mv-synthetic', concept: { subjects }, castAndSets: { source: 'catalog' }, scenes: [scene] };
  const items = subjects.map(({ id, kind, name, ingredientId }) => ({ subjectId: id, kind, name, ingredientId, images: [] }));
  const presented = { ...stored, castAndSets: { ...stored.castAndSets, catalogCheckin: { items, problems: [] } } };
  return { stored, presented, scene };
};
const confirmedFrame = (project, scene) => ({ kind: 'image', assetId: 'a.png', frameDependencies: captureImageFrameDependencies(project, scene) });

it('fingerprints a frame the same on the stored and the presented record', () => {
  const { stored, presented, scene } = castProject();
  // The legacy forms differ on these records, so the check-in really changes the old fingerprint.
  expect(musicVideoSceneCastIds(presented, scene).sort()).toEqual(['cat-chr-a', 'cat-plc']);
  expect(musicVideoSceneCastIds(stored, scene).sort()).toEqual(['cat-chr-a', 'cat-chr-b', 'cat-plc']);
  expect(captureImageFrameDependencies(stored, scene)).toEqual(captureImageFrameDependencies(presented, scene));
  expect(frameState(presented, scene, confirmedFrame(stored, scene))).toEqual({ status: 'current', reasons: [] });
  expect(frameState(stored, scene, confirmedFrame(presented, scene))).toEqual({ status: 'current', reasons: [] });
});

it('keeps a confirmed frame current through the done flag and unrelated edits, and reports a real cast change', () => {
  const { stored, presented, scene } = castProject();
  const frame = confirmedFrame(stored, scene);
  const edited = { ...scene, description: 'Ben waits by the water', shotSheet: { ...scene.shotSheet, checked: true } };
  expect(frameState(presented, edited, frame)).toEqual({ status: 'current', reasons: [] });
  expect(frameState(stored, edited, frame)).toEqual({ status: 'current', reasons: [] });
  const recast = { ...edited, shotSheet: { ...edited.shotSheet, characters: ['Ada', 'Ben'] } };
  expect(frameState(presented, recast, frame)).toEqual({ status: 'stale', reasons: ['Cast changed'] });
  expect(frameState(stored, recast, frame)).toEqual({ status: 'stale', reasons: ['Cast changed'] });
});

it('accepts a frame stamped with either pre-#16274 cast form while nothing changed', () => {
  const { stored, presented, scene } = castProject();
  const stampedWith = (ids) => {
    const frame = confirmedFrame(stored, scene);
    const revision = checksums.canonicalSnapshotChecksum({ names: ['Ada'], ids: ids.slice().sort() });
    return { ...frame, frameDependencies: { ...frame.frameDependencies, references: frame.frameDependencies.references
      .map((ref) => (ref.role === 'frameCast' ? { ...ref, revision } : ref)) } };
  };
  const narrowed = stampedWith(musicVideoSceneCastIds(presented, scene));
  const unnarrowed = stampedWith(musicVideoSceneCastIds(stored, scene));
  expect(narrowed.frameDependencies).not.toEqual(confirmedFrame(stored, scene).frameDependencies);
  for (const frame of [narrowed, unnarrowed]) {
    expect(frameState(presented, scene, frame)).toEqual({ status: 'current', reasons: [] });
  }
  expect(frameState(stored, scene, unnarrowed)).toEqual({ status: 'current', reasons: [] });
  const recast = { ...scene, shotSheet: { ...scene.shotSheet, characters: ['Ada', 'Ben'] } };
  for (const frame of [narrowed, unnarrowed]) {
    expect(frameState(presented, recast, frame)).toEqual({ status: 'stale', reasons: ['Cast changed'] });
  }
  expect(frameState(presented, scene, stampedWith(['cat-chr-b']))).toEqual({ status: 'stale', reasons: ['Cast changed'] });
});
