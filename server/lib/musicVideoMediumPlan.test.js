import { describe, it, expect } from 'vitest';
import { musicVideoBriefAllowsVideo, musicVideoToolPolicyConflict } from './musicVideoMediumPlan.js';

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
