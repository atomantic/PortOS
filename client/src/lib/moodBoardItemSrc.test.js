import { describe, it, expect } from 'vitest';
import { moodBoardItemSrc, moodBoardItemVideoSrc, moodBoardItemAnalysisSource } from './moodBoardItemSrc';

describe('moodBoardItemSrc', () => {
  it('prefers an explicit imageUrl', () => {
    expect(moodBoardItemSrc({ imageUrl: 'https://x/y.png', mediaKey: 'image:z.png' }))
      .toBe('https://x/y.png');
  });

  it('resolves an image: media-key to the served bytes (URL-encoded)', () => {
    expect(moodBoardItemSrc({ mediaKey: 'image:my render.png' }))
      .toBe('/data/images/my%20render.png');
  });

  it('returns null for a video: media-key with no imageUrl (no derivable thumbnail)', () => {
    expect(moodBoardItemSrc({ mediaKey: 'video:job-123' })).toBeNull();
  });

  it('renders a video pin when an imageUrl thumbnail was stored alongside the key', () => {
    expect(moodBoardItemSrc({ mediaKey: 'video:job-123', imageUrl: '/data/video-thumbnails/t.jpg' }))
      .toBe('/data/video-thumbnails/t.jpg');
  });

  it('returns null for a text item / empty item', () => {
    expect(moodBoardItemSrc({ type: 'text', text: 'hi' })).toBeNull();
    expect(moodBoardItemSrc(null)).toBeNull();
    expect(moodBoardItemSrc({})).toBeNull();
  });

  it('derives a video item poster from the filename stem when no imageUrl is stored (#4188)', () => {
    expect(moodBoardItemSrc({ type: 'video', mediaKey: 'video:upload-ab12cd34.mp4' }))
      .toBe('/data/video-thumbnails/upload-ab12cd34.jpg');
  });

  it('still prefers a stored poster imageUrl on a video item', () => {
    expect(moodBoardItemSrc({ type: 'video', mediaKey: 'video:a.mp4', imageUrl: '/data/video-thumbnails/x.jpg' }))
      .toBe('/data/video-thumbnails/x.jpg');
  });
});

describe('moodBoardItemVideoSrc', () => {
  it('resolves a video item mediaKey to the served playback URL (URL-encoded)', () => {
    expect(moodBoardItemVideoSrc({ type: 'video', mediaKey: 'video:my clip.mp4' }))
      .toBe('/data/videos/my%20clip.mp4');
  });

  it('returns null for image/text items and legacy video pins on image items', () => {
    expect(moodBoardItemVideoSrc({ type: 'image', mediaKey: 'video:job-123' })).toBeNull();
    expect(moodBoardItemVideoSrc({ type: 'text', text: 'hi' })).toBeNull();
    expect(moodBoardItemVideoSrc({ type: 'video' })).toBeNull();
    expect(moodBoardItemVideoSrc(null)).toBeNull();
  });
});

describe('moodBoardItemAnalysisSource (#4188 Phase 3)', () => {
  it('resolves a video item to a filename video source with its poster', () => {
    expect(moodBoardItemAnalysisSource({
      type: 'video', mediaKey: 'video:clip.mp4', imageUrl: '/data/video-thumbnails/clip.jpg',
    })).toEqual({ kind: 'video', filename: 'clip.mp4', previewUrl: '/data/video-thumbnails/clip.jpg' });
  });
  it('resolves an image item by media-key or a /data/images app path (decoded)', () => {
    expect(moodBoardItemAnalysisSource({ type: 'image', mediaKey: 'image:ref.png' }))
      .toEqual({ filename: 'ref.png', previewUrl: '/data/images/ref.png' });
    expect(moodBoardItemAnalysisSource({ type: 'image', imageUrl: '/data/images/my%20render.png' }))
      .toEqual({ filename: 'my render.png', previewUrl: '/data/images/my%20render.png' });
  });
  it('returns null for text items, external pins, and legacy video: pins on image items', () => {
    expect(moodBoardItemAnalysisSource({ type: 'text', text: 'n' })).toBeNull();
    expect(moodBoardItemAnalysisSource({ type: 'image', imageUrl: 'https://x/y.png' })).toBeNull();
    expect(moodBoardItemAnalysisSource({ type: 'image', mediaKey: 'video:abc', imageUrl: 'https://x/t.jpg' })).toBeNull();
    expect(moodBoardItemAnalysisSource({ type: 'video', mediaKey: null })).toBeNull();
    expect(moodBoardItemAnalysisSource(null)).toBeNull();
  });
});
