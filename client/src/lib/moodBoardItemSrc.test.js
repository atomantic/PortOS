import { describe, it, expect } from 'vitest';
import { moodBoardItemSrc } from './moodBoardItemSrc';

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
});
