import { describe, expect, it } from 'vitest';
import { IMAGE_GEN_MODE } from './imageGenModes';
import {
  moodBoardItemSendLinks,
  BOARD_POSTER_SIZE,
  boardAnalyzePlan,
  boardPosterRenderCfg,
  isMoodBoardItemAnalyzed,
  moodBoardAnalysisFromResult,
  moodBoardItemHasPrompt,
  moodBoardItemPrompt,
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

  it('keeps local Pinterest pins with default captions in pending rather than marking as analyzed', () => {
    const plan = boardAnalyzePlan([
      { id: 'pin1', type: 'image', imageUrl: '/data/images/pin1.jpg', caption: 'vintage living room' },
      { id: 'pin2', type: 'image', imageUrl: '/data/images/pin2.jpg', caption: 'modern kitchen', analysis: { prompt: 'a clean modern kitchen' } },
    ]);
    expect(plan.analyzed).toBe(1);
    expect(plan.pending.map((it) => it.id)).toEqual(['pin1']);
  });
});

describe('moodBoardItemPrompt and helpers', () => {
  it('identifies analyzed items and resolves their prompt', () => {
    const item = {
      id: '1',
      type: 'image',
      caption: 'default caption from pin',
      analysis: { prompt: 'analyzed prompt detail' },
    };
    expect(isMoodBoardItemAnalyzed(item)).toBe(true);
    expect(moodBoardItemHasPrompt(item)).toBe(true);
    expect(moodBoardItemPrompt(item)).toBe('analyzed prompt detail');
  });

  it('prefers explicit item.prompt over default caption', () => {
    const item = {
      id: '2',
      type: 'image',
      caption: 'default caption',
      prompt: 'explicit prompt',
    };
    expect(isMoodBoardItemAnalyzed(item)).toBe(false);
    expect(moodBoardItemHasPrompt(item)).toBe(true);
    expect(moodBoardItemPrompt(item)).toBe('explicit prompt');
  });

  it('falls back to caption for gallery mediaKey items when no explicit prompt or analysis exists', () => {
    const galleryImage = {
      id: '3',
      type: 'image',
      mediaKey: 'image:test.png',
      caption: 'gallery prompt stored in caption',
    };
    expect(isMoodBoardItemAnalyzed(galleryImage)).toBe(false);
    expect(moodBoardItemHasPrompt(galleryImage)).toBe(true);
    expect(moodBoardItemPrompt(galleryImage)).toBe('gallery prompt stored in caption');
  });

  it('does not treat external or Pinterest default captions as prompts', () => {
    const pin = {
      id: '4',
      type: 'image',
      imageUrl: '/data/images/pin.jpg',
      caption: 'cute cat photo',
    };
    expect(isMoodBoardItemAnalyzed(pin)).toBe(false);
    expect(moodBoardItemHasPrompt(pin)).toBe(false);
    expect(moodBoardItemPrompt(pin)).toBe('');
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

describe('moodBoardItemSendLinks', () => {
  it('offers all three handoffs for an analyzed gallery image', () => {
    const links = moodBoardItemSendLinks({
      type: 'image', mediaKey: 'image:a b.png',
      analysis: { prompt: 'a red fox', negativePrompt: 'blurry' },
    });
    expect(links.textToImage).toBe('/media/image?prompt=a+red+fox&negativePrompt=blurry');
    expect(links.imageToImage).toContain('initImageFile=a+b.png');
    expect(links.video).toContain('/media/video?');
    expect(links.video).toContain('sourceImageFile=a+b.png');
  });

  it('hides image-sourced handoffs for external pins and falls back to text-to-video for video items', () => {
    const external = moodBoardItemSendLinks({ type: 'image', imageUrl: 'https://example.com/x.png', analysis: { prompt: 'p' } });
    expect(external.imageToImage).toBeNull();
    expect(external.video).toBe('/media/video?prompt=p');
    const video = moodBoardItemSendLinks({ type: 'video', mediaKey: 'video:c.mp4', analysis: { prompt: 'p' } });
    expect(video.imageToImage).toBeNull();
    expect(video.video).toBe('/media/video?prompt=p');
    expect(moodBoardItemSendLinks({ type: 'image', mediaKey: 'image:z.png' }).textToImage).toBeNull();
  });
});
