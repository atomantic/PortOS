import { describe, expect, it } from 'vitest';
import { captureImageFrameDependencies } from '../../lib/musicVideoDependencies.js';
import { musicVideoSceneCastIds } from '../../lib/musicVideoConditioning.js';
import { canonicalSnapshotChecksum } from '../../lib/snapshotChecksum.js';
import { appendSceneTakes, appendTakesAcrossScenes, rejectUnusedTakes, reviewSceneTake, selectSceneTake, swapSceneFrames } from './takes.js';
import { captureClipReferenceDependency, captureMusicVideoEvidence, captureTakeDependencies } from '../../lib/musicVideoDependencies.js';

const project = () => ({ id: 'mv-1', scenes: [{ sceneId: 's1' }] });

it('keeps an LTX take as a candidate when its selected guide changes during rendering', () => {
  const item = { id: 'mv-1', visualSpec: { references: [
    { id: 'rider', imageId: 'rider.png', role: 'character' },
    { id: 'other', imageId: 'other.png', role: 'character' },
  ] }, scenes: [{ sceneId: 's1', referenceImageId: 'start.png', clipReferenceIds: ['rider'] }] };
  const dependencies = captureTakeDependencies(item.scenes[0]);
  dependencies.references.push(captureClipReferenceDependency(item, item.scenes[0]));
  const take = { kind: 'video', assetId: 'clip', source: 'generated', dependencies };
  expect(appendSceneTakes(item, 's1', [take]).scene.videoHistoryId).toBe('clip');
  item.scenes[0].clipReferenceIds = ['other'];
  const result = appendSceneTakes(item, 's1', [take]).scene;
  expect(result.videoHistoryId).toBeUndefined();
  expect(result.takes.at(-1).status).toBe('candidate');
});

it('does not auto-select a candidate when its external cast guide cannot be tracked', () => {
  const item = { id: 'mv-1', scenes: [{ sceneId: 's1', referenceImageId: 'start.png',
    characterVariant: { ingredientId: 'rider' }, clipReferenceIds: ['mvr-guide-rider.png'] }] };
  const dependency = captureClipReferenceDependency(item, item.scenes[0]);
  expect(dependency.untrackedCastGuides).toBe(true);
  const { scene } = appendSceneTakes(item, 's1', [{ kind: 'video', assetId: 'clip', source: 'generated',
    dependencies: { version: 1, references: [dependency] }, autoSelect: false }]);
  expect(scene.videoHistoryId).toBeUndefined();
  expect(scene.takes.at(-1).status).toBe('candidate');
});

describe('take generation cost (#10157)', () => {
  it('stores a finite quote and its spend kind, and omits both when unpriced or invalid', () => {
    const input = { kind: 'video', source: 'generated' };
    const { appended } = appendSceneTakes(project(), 's1', [
      { ...input, assetId: 'a', costUsd: 0.4, spendKind: 'autoReview', costModelId: 'fal-ai/kling-video/v3/pro/image-to-video' },
      { ...input, assetId: 'b', costUsd: 0.1 },
      { ...input, assetId: 'c', costUsd: null, costModelId: 'fal-ai/kling-video/v3/pro/image-to-video' },
      { ...input, assetId: 'd', costUsd: -3, spendKind: 'manual' },
    ]);
    expect(appended[0]).toMatchObject({ costUsd: 0.4, spendKind: 'autoReview', costModelId: 'fal-ai/kling-video/v3/pro/image-to-video' });
    expect(appended[1]).toMatchObject({ costUsd: 0.1, spendKind: 'manual' });
    expect(appended[1]).not.toHaveProperty('costModelId');
    expect(appended[2]).not.toHaveProperty('costUsd');
    expect(appended[2]).not.toHaveProperty('costModelId');
    expect(appended[3]).not.toHaveProperty('costUsd');
  });
});

describe('supplied-audio take fills an empty slot', () => {
  // A supplied-audio clip records the song master as a dependency; the
  // slot-fill staleness check must read it against the real project, not a
  // scene-only stub (which made every such take look stale and stay candidate).
  const songProject = () => ({
    id: 'mv-1', trackId: 'track-1', lyricCues: [{ id: 'c1', text: 'Example line', startSec: 1, endSec: 2 }],
    scenes: [{ sceneId: 's1', startSec: 1, endSec: 4, referenceImageId: 'plate.png' }],
  });
  const takeFor = (project) => {
    const dependencies = captureTakeDependencies(project.scenes[0], 'plate.png');
    dependencies.references.push(...captureMusicVideoEvidence(project, { sceneIds: [], composition: false }).references);
    return { kind: 'video', assetId: 'clip-1', source: 'generated', sourceImageId: 'plate.png', dependencies };
  };

  it('selects the first current take', () => {
    const project = songProject();
    const { scene } = appendSceneTakes(project, 's1', [takeFor(project)]);
    expect(scene.videoHistoryId).toBe('clip-1');
  });

  it('leaves the slot empty when the song changed after the clip was submitted', () => {
    const project = songProject();
    const input = takeFor(project);
    const { scene } = appendSceneTakes({ ...project, lyricCues: [] }, 's1', [input]);
    expect(scene.videoHistoryId).toBeUndefined();
    expect(scene.takes.at(-1).status).toBe('candidate');
  });
});

describe('a clip made toward an end frame (#11173)', () => {
  const endProject = () => ({ id: 'mv-1', scenes: [{ sceneId: 's1', referenceImageId: 'plate.png', endImageId: 'end.png' }] });
  const clipTake = (project) => ({
    kind: 'video', assetId: 'clip-1', source: 'generated', sourceImageId: 'plate.png',
    dependencies: captureTakeDependencies(project.scenes[0], 'plate.png', 'end.png'),
  });

  it('fills the slot while the same end frame is selected', () => {
    const project = endProject();
    expect(appendSceneTakes(project, 's1', [clipTake(project)]).scene.videoHistoryId).toBe('clip-1');
  });

  it('stays a candidate once a different end frame is selected', () => {
    const project = endProject();
    const input = clipTake(project);
    project.scenes[0].endImageId = 'other-end.png';
    const { scene } = appendSceneTakes(project, 's1', [input]);
    expect(scene.videoHistoryId).toBeUndefined();
    expect(scene.takes.at(-1).status).toBe('candidate');
  });
});

describe('reject unused takes', () => {
  // Uniquely catches finalizing a shot touching its selection or a take that is in use.
  it('rejects every take not in use, keeping the selection, notes and the takes already rejected', () => {
    const take = (takeId, kind, assetId, extra = {}) => ({ takeId, kind, assetId, status: 'candidate', note: null, ...extra });
    const scene = { sceneId: 's1', referenceImageId: 'a.png', endImageId: null, videoHistoryId: 'v2',
      takes: [take('t1', 'image', 'a.png'), take('t2', 'image', 'b.png', { note: 'too dark' }), take('t3', 'endImage', 'e.png'),
        take('t4', 'video', 'v1', { status: 'rejected' }), take('t5', 'video', 'v2'), take('t6', 'video', 'v3')] };
    const { project, scene: next, rejected } = rejectUnusedTakes({ scenes: [scene] }, 's1');
    expect(rejected).toBe(3);
    expect(next.takes.map((t) => [t.takeId, t.status])).toEqual([['t1', 'candidate'], ['t2', 'rejected'], ['t3', 'rejected'],
      ['t4', 'rejected'], ['t5', 'candidate'], ['t6', 'rejected']]);
    expect(next.takes[1].note).toBe('too dark');
    expect([next.referenceImageId, next.endImageId, next.videoHistoryId]).toEqual(['a.png', null, 'v2']);
    expect(project.scenes[0].takes).toEqual(next.takes);
    expect(rejectUnusedTakes(project, 's1').rejected).toBe(0);
  });
});

describe('cast inputs on a new still (#14154)', () => {
  const castInputs = { ingredientId: 'cat-lead', guides: ['child.png'], sheets: [{ id: 'mvr-cs-character', imageId: 'sheet.png' }] };
  const sceneWithFrame = () => ({ id: 'mv-1', scenes: [{ sceneId: 's1', referenceImageId: 'start.png', takes: [
    { takeId: 'mvt-old', kind: 'image', assetId: 'start.png', status: 'candidate' },
  ] }] });

  // Uniquely catches a new still dropping the guides it was sent, or a clip losing the character references it was sent (#16473).
  it('records the snapshot on image, end-frame and clip takes, including an empty one', () => {
    const empty = { ingredientId: null, guides: [], sheets: [] };
    const { appended } = appendSceneTakes(project(), 's1', [
      { kind: 'image', assetId: 'frame.png', source: 'generated', castInputs },
      { kind: 'endImage', assetId: 'end.png', source: 'generated', castInputs: empty },
      { kind: 'video', assetId: 'clip-1', source: 'generated', castInputs },
    ]);
    expect(appended[0].castInputs).toEqual(castInputs);
    expect(appended[0]).not.toHaveProperty('dependencies');
    expect(appended[1].castInputs).toEqual(empty);
    expect(appended[2].castInputs).toEqual(castInputs);
  });

  it('records what a generated still was rendered for, and skips an import, a clip, and a late job', () => {
    const project = { id: 'mv-1', scenes: [{ sceneId: 's1', framePrompt: 'Harbor at dusk', shotSheet: { location: 'Dock' } }] };
    const { appended, scene } = appendSceneTakes(project, 's1', [
      { kind: 'image', assetId: 'frame.png', source: 'generated' },
      { kind: 'image', assetId: 'import.png', source: 'imported' },
      { kind: 'video', assetId: 'clip-1', source: 'generated', sourceImageId: 'frame.png' },
      { kind: 'endImage', assetId: 'end.png', source: 'generated' },
      { kind: 'image', assetId: 'late.png', source: 'generated', prompt: 'Harbor at dusk, grain.', skipFrameCapture: true },
    ]);
    expect(appended[0].frameDependencies.version).toBe(1);
    expect(appended[0].frameDependencies.references.map((ref) => ref.role)).toEqual(['framePrompt', 'frameCamera', 'frameLocation', 'frameCast', 'frameReferences']);
    expect(appended[1]).not.toHaveProperty('frameDependencies');
    expect(appended[2]).not.toHaveProperty('frameDependencies');
    expect(appended[3].frameDependencies.references[0].assetId).toBe('end');
    expect(appended[4]).not.toHaveProperty('frameDependencies');
    expect(appended[4]).not.toHaveProperty('skipFrameCapture');
    expect(scene.referenceImageId).toBe('frame.png');
    const stale = captureImageFrameDependencies({ scenes: [{ sceneId: 's1', framePrompt: 'Old harbor' }] }, { sceneId: 's1', framePrompt: 'Old harbor' }, { slot: 'start' });
    const empty = appendSceneTakes({ id: 'mv-1', scenes: [{ sceneId: 's1', framePrompt: 'New harbor' }] }, 's1', [
      { kind: 'image', assetId: 'old.png', source: 'generated', frameDependencies: stale },
    ]);
    expect(empty.scene.referenceImageId ?? null).toBeNull();
    const blocked = appendSceneTakes({ id: 'mv-1', scenes: [{ sceneId: 's1', framePrompt: 'New harbor', referenceImageId: 'old.png' }] }, 's1', [
      { kind: 'image', assetId: 'old.png', source: 'generated', frameDependencies: stale },
      { kind: 'video', assetId: 'old-clip', source: 'generated', sourceImageId: 'old.png' },
    ]);
    const saved = blocked.project.scenes[0];
    expect(saved.referenceImageId).toBe('old.png');
    expect(saved.videoHistoryId ?? null).toBeNull();
    expect(saved.takes.find((take) => take.assetId === 'old-clip').dependencyState.reasons).toContain('Frame prompt changed');
  });

  // Uniquely catches a one-tap re-render leaving the previous still selected, or a normal completion replacing it.
  it('selects the new still only when the submit asked to replace the selection', () => {
    const project = sceneWithFrame();
    const kept = appendSceneTakes(project, 's1', [{ kind: 'image', assetId: 'other.png', source: 'generated', castInputs }]);
    expect(kept.scene.referenceImageId).toBe('start.png');
    const replaced = appendSceneTakes(project, 's1', [{ kind: 'image', assetId: 'other.png', source: 'generated', castInputs, replaceSelection: true, expectedSelection: 'start.png' }]);
    expect(replaced.scene.referenceImageId).toBe('other.png');
    expect(replaced.scene.takes.find((take) => take.assetId === 'other.png')).not.toHaveProperty('replaceSelection');
    const end = appendSceneTakes({ id: 'mv-1', scenes: [{ sceneId: 's1', endImageId: 'end-old.png' }] }, 's1', [
      { kind: 'endImage', assetId: 'end-new.png', source: 'generated', castInputs, replaceSelection: true, expectedSelection: 'end-old.png' },
    ]);
    expect(end.scene.endImageId).toBe('end-new.png');
    const changed = appendSceneTakes(project, 's1', [{ kind: 'image', assetId: 'late.png', source: 'generated', replaceSelection: true, expectedSelection: 'previous.png' }]);
    expect(changed.scene.referenceImageId).toBe('start.png');
    expect(changed.scene.takes.some((take) => take.assetId === 'late.png')).toBe(true);
  });

  it('keeps a newer repair pending when an older repair finishes', () => {
    const project = sceneWithFrame();
    project.scenes[0].stillFixes = { text: 'newer instructions', at: 'repair-2', pending: true, replaces: 'start.png' };
    const { scene } = appendSceneTakes(project, 's1', [{ kind: 'image', assetId: 'late.png', source: 'generated',
      replaceSelection: true, expectedSelection: 'start.png', stillRepairAt: 'repair-1' }]);
    expect(scene.referenceImageId).toBe('start.png');
    expect(scene.stillFixes).toMatchObject({ at: 'repair-2', pending: true });
    expect(scene.takes.map(take => take.assetId)).toEqual(['start.png', 'late.png']);
  });
});

describe('swap start and end frames', () => {
  // Uniquely catches the swap losing a prompt, duplicating a take it could reuse, or leaving a frame's take rejected while selected.
  it('trades the selected frames and their prompts, reusing and restoring takes', () => {
    const take = (takeId, kind, assetId, extra = {}) => ({ takeId, kind, assetId, status: 'candidate', note: null, ...extra });
    const scene = { sceneId: 's1', referenceImageId: 'a.png', endImageId: 'e.png', framePrompt: 'Door opens', endFramePrompt: 'Door shut',
      takes: [take('t1', 'image', 'a.png', { prompt: 'Door opens' }), take('t2', 'image', 'e.png', { status: 'rejected' }),
        take('t3', 'endImage', 'e.png', { prompt: 'Door shut' })] };
    const { scene: next } = swapSceneFrames({ scenes: [scene] }, 's1');
    expect([next.referenceImageId, next.endImageId, next.framePrompt, next.endFramePrompt]).toEqual(['e.png', 'a.png', 'Door shut', 'Door opens']);
    expect(next.takes.find((t) => t.takeId === 't2').status).toBe('candidate');
    const added = next.takes.filter((t) => !['t1', 't2', 't3'].includes(t.takeId));
    expect(added.map((t) => [t.kind, t.assetId, t.prompt])).toEqual([['endImage', 'a.png', 'Door opens']]);
    expect(() => swapSceneFrames({ scenes: [{ ...scene, endImageId: null }] }, 's1')).toThrow(/both a start and an end frame/);
  });
});

// #16128: one sequence take filed on two shots, each picked on its own.
describe('sequence takes', () => {
  const sequence = (index, offsetFrames) => ({ sceneIds: ['a', 'b'], index, offsetFrames, from: index ? 'cut' : 'start' });
  const filed = () => appendTakesAcrossScenes({ id: 'mv-1', scenes: [
    { sceneId: 'a', videoHistoryId: 'own-a', offsetFrames: 6 },
    { sceneId: 'b' },
  ] }, [
    { sceneId: 'a', kind: 'video', assetId: 'seq', source: 'generated', autoSelect: false, sequence: sequence(0, 0) },
    { sceneId: 'b', kind: 'video', assetId: 'seq', source: 'generated', autoSelect: false, sequence: sequence(1, 60) },
  ]);

  it('files the take on every shot without changing a selection, even an empty one', () => {
    const { project: next, appended } = filed();
    expect(next.scenes.map((s) => s.videoHistoryId ?? null)).toEqual(['own-a', null]);
    expect(next.scenes[0].offsetFrames).toBe(6);
    expect(appended.map(({ take }) => take.sequence)).toEqual([sequence(0, 0), sequence(1, 60)]);
  });

  it('picking it on one shot sets that shot\'s in-point only, and leaving it clears the in-point', () => {
    const { project: next, appended } = filed();
    const picked = selectSceneTake(next, 'b', appended[1].take.takeId);
    expect(picked.scene).toMatchObject({ videoHistoryId: 'seq', offsetFrames: 60 });
    expect(picked.project.scenes.find((s) => s.sceneId === 'a')).toMatchObject({ videoHistoryId: 'own-a', offsetFrames: 6 });
    const nudged = { ...picked.project, scenes: picked.project.scenes.map((s) => (s.sceneId === 'b' ? { ...s, offsetFrames: 64 } : s)) };
    // Re-picking the same take keeps the nudge.
    expect(selectSceneTake(nudged, 'b', appended[1].take.takeId).scene.offsetFrames).toBe(64);
    const onA = selectSceneTake(nudged, 'a', appended[0].take.takeId);
    expect(onA.scene.videoHistoryId).toBe('seq');
    expect(onA.scene).not.toHaveProperty('offsetFrames');
    const ownTake = onA.scene.takes.find((t) => t.assetId === 'own-a');
    const back = selectSceneTake({ ...onA.project, scenes: onA.project.scenes.map((s) => (s.sceneId === 'a' ? { ...s, offsetFrames: 12 } : s)) }, 'a', ownTake.takeId);
    expect(back.scene).toMatchObject({ videoHistoryId: 'own-a' });
    expect(back.scene).not.toHaveProperty('offsetFrames');
  });
});

// #16274: a confirmation re-stamps a pre-#16274 cast fingerprint to the canonical one and answers with the take current.
it('re-stamps a legacy frame cast fingerprint on confirm and answers with the take current', () => {
  const scene = { sceneId: 's1', framePrompt: 'A rider at dusk', referenceImageId: 'a.png', frameReferenceIds: ['mvr-linked-0000000000000001'],
    shotSheet: { characters: ['Ada'] } };
  const item = { id: 'mv-1', castAndSets: { source: 'catalog' }, scenes: [scene],
    concept: { subjects: [{ id: 'subj-a', kind: 'character', name: 'Ada', ingredientId: 'cat-chr-a' },
      { id: 'subj-b', kind: 'character', name: 'Ben', ingredientId: 'cat-chr-b' }] } };
  const canonical = captureImageFrameDependencies(item, scene);
  // The stored record's pre-#16274 form: every linked cast id, since it carries no check-in to narrow by.
  const unnarrowed = canonicalSnapshotChecksum({ names: ['Ada'], ids: musicVideoSceneCastIds(item, scene).slice().sort() });
  const legacy = { ...canonical, references: canonical.references.map((ref) => (ref.role === 'frameCast' ? { ...ref, revision: unnarrowed } : ref)) };
  expect(legacy).not.toEqual(canonical);
  // The persisted state from an earlier write, which the reply must not echo.
  item.scenes = [{ ...scene, takes: [{ takeId: 't1', kind: 'image', assetId: 'a.png', status: 'candidate', frameDependencies: legacy,
    dependencyState: { status: 'stale', reasons: ['Cast changed'] } }] }];
  const { project: saved, scene: answered } = reviewSceneTake(item, 's1', 't1', { confirmFrame: true, reviewer: { kind: 'local' } });
  expect(answered.takes[0].frameDependencies).toEqual(canonical);
  expect(answered.takes[0].dependencyState).toEqual({ status: 'current', reasons: [] });
  expect(saved.scenes[0].takes[0].dependencyState).toEqual({ status: 'current', reasons: [] });
});
