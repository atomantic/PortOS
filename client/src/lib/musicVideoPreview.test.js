import { describe, it, expect } from 'vitest';
import { selectMusicVideoPreview, musicVideoImageSrc, musicVideoImageFallback } from './musicVideoPreview.js';

describe('selectMusicVideoPreview', () => {
  it('returns none for null or empty project', () => {
    expect(selectMusicVideoPreview(null)).toEqual({ kind: 'none', label: 'No render yet' });
    expect(selectMusicVideoPreview({})).toEqual({ kind: 'none', label: 'No render yet' });
  });

  it('selects final video render when renderHistoryId is set', () => {
    const project = {
      id: 'p1',
      name: 'Test Project',
      renderHistoryId: 'final-job-123',
    };
    const preview = selectMusicVideoPreview(project);
    expect(preview).toEqual({
      kind: 'video',
      jobId: 'final-job-123',
      src: '/data/videos/final-job-123.mp4',
      poster: '/data/video-thumbnails/final-job-123.jpg',
      label: 'Final video',
    });
  });

  it('selects latest completed excerpt when no final render is present', () => {
    const project = {
      id: 'p1',
      excerpts: [
        { id: 'e1', status: 'failed', filename: 'fail.mp4' },
        { id: 'e2', status: 'complete', filename: 'excerpt-2.mp4', jobId: 'job-e2', label: 'Bridge preview' },
      ],
    };
    const preview = selectMusicVideoPreview(project);
    expect(preview).toEqual({
      kind: 'video',
      jobId: 'job-e2',
      src: '/data/videos/excerpt-2.mp4',
      poster: '/data/video-thumbnails/job-e2.jpg',
      label: 'Bridge preview',
    });
  });

  it('selects latest rendered scene clip when no final render or excerpt exists', () => {
    const project = {
      id: 'p1',
      scenes: [
        { sceneId: 's1', videoHistoryId: 'vid-1' },
        { sceneId: 's2', videoHistoryId: 'vid-2' },
        { sceneId: 's3', videoHistoryId: null },
      ],
    };
    const preview = selectMusicVideoPreview(project);
    expect(preview).toEqual({
      kind: 'video',
      jobId: 'vid-2',
      src: '/data/videos/vid-2.mp4',
      poster: '/data/video-thumbnails/vid-2.jpg',
      label: 'Scene 2 clip',
    });
  });

  it('selects latest scene reference frame when no video render exists', () => {
    const project = {
      id: 'p1',
      scenes: [
        { sceneId: 's1', referenceImageId: 'frame-1.png' },
        { sceneId: 's2', referenceImageId: 'frame-2.png' },
      ],
    };
    const preview = selectMusicVideoPreview(project);
    expect(preview).toEqual({
      kind: 'image',
      src: '/data/images/frame-2.png',
      fallbackSrc: null,
      label: 'Scene 2 frame',
    });
  });

  it('selects visual spec reference when no scene frame or video exists', () => {
    const project = {
      id: 'p1',
      visualSpec: {
        references: [{ imageId: 'mood-board-ref', label: 'Cyberpunk street' }],
      },
    };
    const preview = selectMusicVideoPreview(project);
    expect(preview).toEqual({
      kind: 'image',
      src: '/data/images/mood-board-ref',
      fallbackSrc: '/data/images/mood-board-ref.png',
      label: 'Cyberpunk street',
    });
  });
});

describe('musicVideoImageSrc and fallback', () => {
  it('handles absolute or schema urls', () => {
    expect(musicVideoImageSrc('/custom/path.png')).toBe('/custom/path.png');
    expect(musicVideoImageSrc('https://example.com/img.png')).toBe('https://example.com/img.png');
    expect(musicVideoImageSrc('image.png')).toBe('/data/images/image.png');
  });

  it('supplies fallback when extension is absent', () => {
    expect(musicVideoImageFallback('img')).toBe('/data/images/img.png');
    expect(musicVideoImageFallback('img.png')).toBe(null);
  });
});
