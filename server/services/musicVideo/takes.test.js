import { describe, expect, it } from 'vitest';
import { appendSceneTakes } from './takes.js';
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
