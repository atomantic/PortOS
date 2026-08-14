import { describe, it, expect } from 'vitest';
import { moodBoardItemSrc, moodBoardItemVideoSrc } from './moodBoardItemSrc';

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
