import { describe, it, expect } from 'vitest';
import {
  planSequenceCoverage, composeSequencePrompt, sequenceClipSpans, SEQUENCE_PROMPT_EXPANSION,
} from './musicVideoSequenceCoverage.js';
import { buildFalVideoRequest } from './falVideoModels.js';

const H3 = 'minimax/h3-max/reference-to-video';
const SEEDANCE = 'bytedance/seedance-2.5/reference-to-video';
const shot = (sceneId, startSec, endSec, extra = {}) => ({
  sceneId, sectionIndex: 1, coverage: 'sequence', startSec, endSec,
  shotMode: 'cutaway', visualLayer: 'footage', set: { id: 'attic' }, protagonist: 'mara', ...extra,
});

describe('planSequenceCoverage', () => {
  it('turns a three-shot cutaway section inside the model max into one request with three clip spans', () => {
    const scenes = [shot('a', 10, 14), shot('b', 14, 18), shot('c', 18, 22)];
    const { groups, perShot } = planSequenceCoverage(scenes, { modelId: H3 });
    expect(perShot).toEqual([]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ sceneIds: ['a', 'b', 'c'], startSec: 10, endSec: 22, durationSec: 12 });
    const split = sequenceClipSpans(groups[0], scenes, { clipDurationSec: 12 });
    expect(split.spans).toEqual([
      { sceneId: 'a', clipStartSec: 0, clipEndSec: 4 },
      { sceneId: 'b', clipStartSec: 4, clipEndSec: 8 },
      { sceneId: 'c', clipStartSec: 8, clipEndSec: 12 },
    ]);
  });

  it('keeps a performance shot on its own request and does not bridge the run across it', () => {
    const scenes = [shot('a', 10, 13), shot('b', 13, 16), shot('p', 16, 22, { shotMode: 'performance' }), shot('c', 22, 25)];
    const { groups, perShot } = planSequenceCoverage(scenes, { modelId: H3 });
    expect(groups.map((g) => g.sceneIds)).toEqual([['a', 'b']]);
    expect(perShot.map((p) => p.sceneId).sort()).toEqual(['c', 'p']);
    expect(perShot.find((p) => p.sceneId === 'p').reason).toMatch(/performance/);
  });

  it('refuses a section longer than the model max and leaves every shot per-shot', () => {
    const scenes = [shot('a', 0, 8), shot('b', 8, 16)];
    const { groups, perShot } = planSequenceCoverage(scenes, { modelId: H3 });
    expect(groups).toEqual([]);
    expect(perShot.map((p) => p.sceneId)).toEqual(['a', 'b']);
    expect(perShot[0].reason).toMatch(/longest clip is 15s/);
    // The same run fits Seedance's longer clip.
    expect(planSequenceCoverage(scenes, { modelId: SEEDANCE }).groups).toHaveLength(1);
  });

  it('does not group across a different set or a gap, and ignores per-shot sections', () => {
    const scenes = [shot('a', 0, 3), shot('b', 3, 6, { set: { id: 'roof' } }), shot('c', 7, 9, { set: { id: 'roof' } }), shot('d', 9, 12, { coverage: 'per-shot', set: { id: 'roof' } })];
    const { groups, perShot } = planSequenceCoverage(scenes, { modelId: H3 });
    expect(groups).toEqual([]);
    expect(perShot.map((p) => p.sceneId)).toEqual(['a', 'b', 'c']);
  });

  it('keeps Kling per-shot with the reason recorded', () => {
    const kling = 'fal-ai/kling-video/v3/pro/image-to-video';
    const { groups, perShot } = planSequenceCoverage([shot('a', 0, 3), shot('b', 3, 6)], { modelId: kling });
    expect(groups).toEqual([]);
    expect(perShot).toHaveLength(2);
    expect(perShot[0].reason).toMatch(/whole seconds/);
  });
});

describe('sequence request', () => {
  it('composes contiguous ranges with the model reference naming and sends H3 expansion disabled', () => {
    const shots = [
      { prompt: 'Mara climbs the stairs', startSec: 10, endSec: 14, imageIndex: 1 },
      { prompt: 'Close on her hand', startSec: 14, endSec: 18, imageIndex: 2 },
    ];
    const prompt = composeSequencePrompt({ modelId: H3, shots });
    expect(prompt).toBe('0-4s: Image 1. Mara climbs the stairs\n4-8s: Image 2. Close on her hand');
    expect(composeSequencePrompt({ modelId: SEEDANCE, shots })).toContain('4-8s: @Image2. Close on her hand');
    const req = buildFalVideoRequest({
      modelId: H3, prompt, seconds: 8, referenceImageUrls: ['https://example.com/1.png', 'https://example.com/2.png'],
      promptExpansion: SEQUENCE_PROMPT_EXPANSION,
    });
    expect(req.body.prompt).toBe(prompt);
    expect(req.body.prompt_expansion_mode).toBe('disabled');
    expect(buildFalVideoRequest({ modelId: H3, prompt: 'x', seconds: 5 }).body.prompt_expansion_mode).toBe('balanced');
  });

  it('refuses a split when the returned clip is shorter than the sequence', () => {
    const scenes = [shot('a', 0, 5), shot('b', 5, 10)];
    const [group] = planSequenceCoverage(scenes, { modelId: H3 }).groups;
    expect(sequenceClipSpans(group, scenes, { clipDurationSec: 7 }).ok).toBe(false);
  });
});
