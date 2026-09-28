import { describe, expect, it } from 'vitest';
import { IMAGE_GEN_MODE } from './imageGenModes';
import {
  BOARD_POSTER_SIZE,
  boardAnalyzePlan,
  boardPosterRenderCfg,
  moodBoardAnalysisFromResult,
  posterStyleKey,
} from './moodBoardAnalysis';

describe('moodBoardAnalysisFromResult', () => {
  it('stores the image prompt for an image pin and falls back to the video prompt', () => {
    expect(moodBoardAnalysisFromResult(
      { type: 'image' },
      { imagePrompt: 'ink wash', imageNegativePrompt: 'gloss', rationale: 'tactile', providerId: 'ollama', model: 'vlm' },
    )).toEqual({
      prompt: 'ink wash',
      negativePrompt: 'gloss',
      rationale: 'tactile',
      providerId: 'ollama',
      model: 'vlm',
    });
    expect(moodBoardAnalysisFromResult(
      { type: 'image' },
      { videoPrompt: 'a pan across ink' },
    ).prompt).toBe('a pan across ink');
  });

  it('prefers the video prompt for a video pin', () => {
    expect(moodBoardAnalysisFromResult(
      { type: 'video' },
      { imagePrompt: 'still', videoPrompt: 'a slow push', videoNegativePrompt: 'cuts' },
    ).prompt).toBe('a slow push');
  });

  it('returns null when the run produced no prompt', () => {
    expect(moodBoardAnalysisFromResult({ type: 'image' }, {})).toBeNull();
    expect(moodBoardAnalysisFromResult({ type: 'image' }, null)).toBeNull();
  });
});

describe('boardAnalyzePlan', () => {
  it('splits analyzed pins, readable pins, and external links', () => {
    const plan = boardAnalyzePlan([
      { id: 'a', type: 'image', mediaKey: 'image:a.png', analysis: { prompt: 'already' } },
      { id: 'b', type: 'image', mediaKey: 'image:b.png' },
      { id: 'c', type: 'image', imageUrl: 'https://example.com/c.png' },
      { id: 'd', type: 'text', text: 'a note' },
      { id: 'e', type: 'image', mediaKey: 'image:e.png', caption: 'caption prompt' },
    ]);
    expect(plan.analyzed).toBe(2);
    expect(plan.pending.map((it) => it.id)).toEqual(['b']);
    expect(plan.skipped).toBe(1);
  });
});

describe('boardPosterRenderCfg', () => {
  const imageCfg = { mode: IMAGE_GEN_MODE.GROK, modelId: 'flux', cloudModel: 'grok-imagine', inheritedBackend: true, width: 1024, height: 1536 };

  it('pins an explicit landscape frame on the chosen image service', () => {
    expect(boardPosterRenderCfg(imageCfg, IMAGE_GEN_MODE.LOCAL)).toMatchObject({
      mode: IMAGE_GEN_MODE.LOCAL,
      inheritedBackend: false,
      modelId: 'flux',
      cloudModel: null,
      width: BOARD_POSTER_SIZE.width,
      height: BOARD_POSTER_SIZE.height,
    });
  });

  it('drops a local model id when the chosen service is not local', () => {
    expect(boardPosterRenderCfg(imageCfg, IMAGE_GEN_MODE.GROK).modelId).toBeNull();
  });

  it('keys the poster on the saved prompt so a later compose is not pinned', () => {
    expect(posterStyleKey({ prompt: 'ink', negativePrompt: 'gloss' }))
      .not.toBe(posterStyleKey({ prompt: 'oil', negativePrompt: 'gloss' }));
  });
});
