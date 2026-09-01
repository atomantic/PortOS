import { describe, it, expect } from 'vitest';
import {
  VIDEO_STAGE_KIND,
  resolveVideoStagePreview,
  videoStageAspectRatio,
  videoStageSignature,
} from './videoStagePreview';

describe('videoStageAspectRatio', () => {
  it('returns the ratio for two positive edges', () => {
    expect(videoStageAspectRatio(704, 480)).toBeCloseTo(704 / 480);
    expect(videoStageAspectRatio(480, 704)).toBeCloseTo(480 / 704);
  });

  it('returns null — not a 16:9 guess — for unknown or bogus geometry', () => {
    expect(videoStageAspectRatio(null, 480)).toBeNull();
    expect(videoStageAspectRatio(704, undefined)).toBeNull();
    expect(videoStageAspectRatio(0, 480)).toBeNull();
    expect(videoStageAspectRatio(704, -1)).toBeNull();
    expect(videoStageAspectRatio('wide', 480)).toBeNull();
  });
});

describe('resolveVideoStagePreview', () => {
  const extendSource = { filename: 'clip-a.mp4', thumbnail: 'clip-a.jpg' };

  it('is empty with nothing to show', () => {
    const stage = resolveVideoStagePreview();
    expect(stage.kind).toBe(VIDEO_STAGE_KIND.EMPTY);
    expect(stage.src).toBeNull();
    expect(stage.aspectRatio).toBeNull();
  });

  it('carries the resolved aspect ratio so a portrait render gets a portrait box', () => {
    const stage = resolveVideoStagePreview({ width: 480, height: 832, sourceImageFile: 'a.png' });
    expect(stage.aspectRatio).toBeCloseTo(480 / 832);
    expect(stage.aspectRatio).toBeLessThan(1);
  });

  it('falls back to the animated source clip an extend is continuing', () => {
    const stage = resolveVideoStagePreview({ generating: true, extendSource, sourceImageFile: 'start.png' });
    expect(stage.kind).toBe(VIDEO_STAGE_KIND.LOOP);
    expect(stage.src).toBe('/data/videos/clip-a.mp4');
    expect(stage.poster).toBe('/data/video-thumbnails/clip-a.jpg');
  });

  it('falls back to a still when no clip is available', () => {
    const stage = resolveVideoStagePreview({ generating: true, sourceImageFile: 'start.png' });
    expect(stage.kind).toBe(VIDEO_STAGE_KIND.STILL);
    expect(stage.src).toBe('/data/images/start.png');
    expect(stage.label).toBe('Start frame');
  });

  it('prefers a freshly uploaded still over a gallery pick, and orders start → keyframe → end', () => {
    expect(resolveVideoStagePreview({ sourceImageFile: 'gallery.png', sourceUploadUrl: 'blob:local' }).src)
      .toBe('blob:local');
    expect(resolveVideoStagePreview({ keyframes: [{ file: 'k2.png', index: 40 }, { file: 'k1.png', index: 0 }] }))
      .toMatchObject({ kind: VIDEO_STAGE_KIND.STILL, src: '/data/images/k1.png', label: 'First keyframe' });
    expect(resolveVideoStagePreview({ lastImageFile: 'end.png' }))
      .toMatchObject({ src: '/data/images/end.png', label: 'End frame' });
  });

  it('ignores keyframe rows that have no file yet', () => {
    const stage = resolveVideoStagePreview({ keyframes: [{ file: '', index: 0 }, { index: 40 }] });
    expect(stage.kind).toBe(VIDEO_STAGE_KIND.EMPTY);
  });

  it('keeps a previous render on stage mid-run only when nothing else applies', () => {
    const result = { filename: 'done.mp4' };
    expect(resolveVideoStagePreview({ generating: true, result, sourceImageFile: 'start.png' }).kind)
      .toBe(VIDEO_STAGE_KIND.STILL);
    expect(resolveVideoStagePreview({ generating: true, result }))
      .toMatchObject({ kind: VIDEO_STAGE_KIND.RESULT, src: '/data/videos/done.mp4' });
  });

  it('promotes the finished render above the conditioning once the run settles', () => {
    const stage = resolveVideoStagePreview({
      generating: false,
      result: { path: '/data/videos/done.mp4', thumbnail: 'done.jpg' },
      sourceImageFile: 'start.png',
      extendSource,
    });
    expect(stage.kind).toBe(VIDEO_STAGE_KIND.RESULT);
    expect(stage.src).toBe('/data/videos/done.mp4');
    expect(stage.poster).toBe('/data/video-thumbnails/done.jpg');
  });

  it('accepts either the completion payload shape or a history record shape', () => {
    expect(resolveVideoStagePreview({ result: { path: '/data/videos/a.mp4' } }).src).toBe('/data/videos/a.mp4');
    expect(resolveVideoStagePreview({ result: { filename: 'b.mp4' } }).src).toBe('/data/videos/b.mp4');
    expect(resolveVideoStagePreview({ result: { filename: '' } }).kind).toBe(VIDEO_STAGE_KIND.EMPTY);
  });
});

describe('videoStageSignature', () => {
  it('is stable across equivalent descriptors and changes with the source', () => {
    const a = resolveVideoStagePreview({ sourceImageFile: 'start.png', width: 704, height: 480 });
    const b = resolveVideoStagePreview({ sourceImageFile: 'start.png', width: 704, height: 480 });
    const c = resolveVideoStagePreview({ sourceImageFile: 'other.png', width: 704, height: 480 });
    expect(videoStageSignature(a)).toBe(videoStageSignature(b));
    expect(videoStageSignature(a)).not.toBe(videoStageSignature(c));
  });

  it('changes when only the geometry changed, so a resized stage still swaps', () => {
    const wide = resolveVideoStagePreview({ sourceImageFile: 'a.png', width: 704, height: 480 });
    const tall = resolveVideoStagePreview({ sourceImageFile: 'a.png', width: 480, height: 704 });
    expect(videoStageSignature(wide)).not.toBe(videoStageSignature(tall));
  });
});
