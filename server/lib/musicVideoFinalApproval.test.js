import { describe, expect, it } from 'vitest';
import { finalApprovalPatch, finalTierCounts, sceneFinalApproved } from './musicVideoFinalApproval.js';

const shot = (over = {}) => ({
  sceneId: 's1', prompt: 'a lantern at dusk', referenceImageId: 'img-1', videoHistoryId: 'vid-1',
  takes: [{ takeId: 't1', kind: 'video', assetId: 'vid-1', tier: 'draft' }], ...over,
});
const approve = (scene) => ({ ...scene, ...finalApprovalPatch(scene, true).patch });

describe('final approval', () => {
  it('needs a selected clip to approve', () => {
    expect(finalApprovalPatch(shot({ videoHistoryId: null }), true).problem).toMatch(/Select a clip/);
  });

  it('is valid until the prompt, a reference or the selection changes', () => {
    const approved = approve(shot());
    expect(sceneFinalApproved(approved)).toBe(true);
    expect(sceneFinalApproved({ ...approved, prompt: 'a lantern at dawn' })).toBe(false);
    expect(sceneFinalApproved({ ...approved, referenceImageId: 'img-2' })).toBe(false);
    expect(sceneFinalApproved({ ...approved, endImageId: 'end-1' })).toBe(false);
    const other = { ...approved, videoHistoryId: 'vid-2', takes: [...approved.takes, { takeId: 't2', kind: 'video', assetId: 'vid-2' }] };
    expect(sceneFinalApproved(other)).toBe(false);
  });

  it('clears with a null patch', () => {
    expect(finalApprovalPatch(approve(shot()), false).patch).toEqual({ finalApproval: null });
  });

  it('counts draft, approved, final and missing shots', () => {
    const final = shot({ sceneId: 's3', takes: [{ takeId: 't3', kind: 'video', assetId: 'vid-1', tier: 'final' }] });
    expect(finalTierCounts([approve(shot()), shot({ sceneId: 's2' }), final, shot({ sceneId: 's4', videoHistoryId: null })]))
      .toEqual({ draft: 2, approved: 1, final: 1, missing: 1 });
  });
});
