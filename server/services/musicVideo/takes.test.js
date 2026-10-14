import { describe, expect, it } from 'vitest';
import { appendSceneTakes, rejectUnusedTakes } from './takes.js';
import { captureMusicVideoEvidence, captureTakeDependencies } from '../../lib/musicVideoDependencies.js';

const project = () => ({ id: 'mv-1', scenes: [{ sceneId: 's1' }] });

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
