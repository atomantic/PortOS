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
    const p = project(['video:local'], 'local');
    p.treatment = { revision: 1, appliedRevision: 1, shotDirections: planMusicVideoMedia(p, directions).map((d) => ({ ...d, mediumRationale: 'x' })) };
    expect(codeFirstProductionAssets(p).conflicts).toEqual([]);
  });
});
