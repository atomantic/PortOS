import { describe, it, expect } from 'vitest';
import { codeFirstProductionAssets, musicVideoBriefAllowsVideo, musicVideoToolPolicyConflict, planMusicVideoMedia } from './musicVideoMediumPlan.js';

describe('brief tools vs production policy', () => {
  const codeFirst = (percent) => ({ strategy: 'code-first', maxGeneratedVideoPercent: percent });

  it('only a brief that names tools and no video tool forbids video', () => {
    expect(musicVideoBriefAllowsVideo({})).toBe(true);
    expect(musicVideoBriefAllowsVideo({ automation: { tools: [] } })).toBe(true);
    expect(musicVideoBriefAllowsVideo({ automation: { tools: ['image:codex', 'video:fal'] } })).toBe(true);
    expect(musicVideoBriefAllowsVideo({ automation: { tools: ['image:codex', 'code:render'] } })).toBe(false);
  });

  it('flags a saved pair that plans generated footage with no video tool, and nothing else', () => {
    const noVideo = ['image:codex', 'code:render'];
    // Legacy defaults to 100% generated video; a non-zero code-first allowance also contradicts the tools.
    expect(musicVideoToolPolicyConflict({ automation: { tools: noVideo } })).toMatchObject({ code: 'NO_VIDEO_TOOL' });
    expect(musicVideoToolPolicyConflict({ automation: { tools: noVideo }, productionPolicy: codeFirst(20) })).toMatchObject({ code: 'NO_VIDEO_TOOL' });
    expect(musicVideoToolPolicyConflict({ automation: { tools: noVideo }, productionPolicy: codeFirst(0) })).toBeNull();
    expect(musicVideoToolPolicyConflict({ automation: { tools: ['video:fal'] }, productionPolicy: codeFirst(20) })).toBeNull();
    expect(musicVideoToolPolicyConflict({ productionPolicy: codeFirst(20) })).toBeNull();
  });
});

describe('footage tools on a code-first project (#10450)', () => {
  const project = (tools, backend) => ({
    automation: { tools },
    productionPolicy: { strategy: 'code-first', maxGeneratedVideoPercent: 100 },
    videoSettings: { backend },
    audioAnalysis: { durationSec: 20 },
    scenes: [
      { sceneId: 's1', startSec: 0, endSec: 10, shotMode: 'cutaway' },
      { sceneId: 's2', startSec: 10, endSec: 20, shotMode: 'cutaway' },
    ],
  });
  const directions = [{ sceneId: 's1', mode: 'performance', route: 'generated' }, { sceneId: 's2', mode: 'cutaway', route: 'generated' }];

  it('plans generated footage for a brief that selected a video tool, and stays procedural without one', () => {
    expect(planMusicVideoMedia(project(['image:local', 'video:local']), directions).map((d) => d.medium)).toEqual(['generated-footage', 'generated-footage']);
    expect(planMusicVideoMedia(project(['image:local']), directions).map((d) => d.medium)).toEqual(['procedural', 'procedural']);
  });

  it('does not demand a Performance shot mode when the backend has no lip-sync lane', () => {
    const p = project(['video:grok'], 'grok');
    p.treatment = { revision: 1, appliedRevision: 1, shotDirections: planMusicVideoMedia(p, directions).map((d) => ({ ...d, mediumRationale: 'x' })) };
    expect(codeFirstProductionAssets(p).conflicts).toEqual([]);
  });
});

describe('shot sheet camera output', () => {
  const directions = [{ sceneId: 's1', medium: 'procedural', route: 'generated' }];
  const project = {
    productionPolicy: { strategy: 'legacy' },
    cameras: [
      { id: 'vid', name: 'Video', kind: 'observer', output: 'video' },
      { id: 'pic', name: 'Photo', kind: 'observer', output: 'image' },
    ],
    scenes: [{ sceneId: 's1', visualLayer: 'still', shotSheet: { cameraId: 'vid' } }],
  };

  it('lets a video camera beat a still visual layer without pinning the medium', () => {
    const planned = planMusicVideoMedia(project, directions);
    expect(planned[0]).toMatchObject({ medium: 'generated-footage', mediumPinned: false, mediumRationale: 'The shot sheet camera shoots video.' });
    expect(planned[0].fromSheet).toBeUndefined();
  });

  it('keeps a real director pin and replaces only the automatic visual-layer pin', () => {
    const pinned = { ...project, treatment: { shotDirections: [{ sceneId: 's1', medium: 'procedural', mediumPinned: true, mediumRationale: 'The director chose code.' }] } };
    expect(planMusicVideoMedia(pinned, directions)[0]).toMatchObject({ medium: 'procedural', mediumPinned: true, mediumRationale: 'The director chose code.' });
    const automatic = { ...project, treatment: { shotDirections: [{ sceneId: 's1', medium: 'still', mediumPinned: true, mediumRationale: 'Retain the director-selected visual layer.' }] } };
    expect(planMusicVideoMedia(automatic, directions)[0]).toMatchObject({ medium: 'generated-footage', mediumPinned: false });
  });

  it('reuses a selected clip for a video camera and still shoots a photo when a clip is selected', () => {
    const withTake = { ...project, scenes: [{ ...project.scenes[0], videoHistoryId: 'vid-1' }] };
    expect(planMusicVideoMedia(withTake, directions)[0].medium).toBe('existing-footage');
    const photo = { ...project, scenes: [{ sceneId: 's1', visualLayer: 'footage', videoHistoryId: 'vid-1', shotSheet: { cameraId: 'pic' } }] };
    expect(planMusicVideoMedia(photo, directions)[0]).toMatchObject({ medium: 'still', mediumRationale: 'The shot sheet camera shoots photos.' });
  });

  it('does not demote sheet-sourced generated footage to stay inside a code-first allowance', () => {
    const codeFirst = {
      ...project,
      productionPolicy: { strategy: 'code-first', maxGeneratedVideoPercent: 0 },
      audioAnalysis: { durationSec: 10 },
      scenes: [{ sceneId: 's1', startSec: 0, endSec: 10, visualLayer: 'still', shotSheet: { cameraId: 'vid' } }],
    };
    expect(planMusicVideoMedia(codeFirst, directions)[0].medium).toBe('generated-footage');
  });
});

describe('codeFirstProductionAssets conflicts', () => {
  it('retains each shot id when several shots raise the same medium conflict', () => {
    const scenes = [0, 1, 2].map((i) => ({ sceneId: `s${i}`, startSec: i * 5, endSec: i * 5 + 5, shotMode: 'cutaway' }));
    const shotDirections = scenes.map((s) => ({ sceneId: s.sceneId, mode: 'performance', medium: 'procedural', mediumRationale: 'x' }));
    const p = { productionPolicy: { strategy: 'code-first', maxGeneratedVideoPercent: 0 }, audioAnalysis: { durationSec: 15 }, scenes,
      treatment: { revision: 1, appliedRevision: 1, shotDirections } };
    expect(codeFirstProductionAssets(p).conflicts).toEqual(scenes.map((scene) => expect.stringMatching(new RegExp(`^${scene.sceneId}: Visible performance is unresolved`))));
  });
});
