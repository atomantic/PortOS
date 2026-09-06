/**
 * The canonical YouTube single-video URL rule (#6014).
 *
 * Quick Capture swaps its ENTIRE submit path on `isYoutubeVideoUrl` — it
 * re-exports this module, so a URL the box offers ingest options for is exactly
 * one the routes accept. The matrix below is what "single video" means:
 * every shape YouTube emits, and the playlist/channel/feed shapes that must be
 * refused so a paste cannot silently start a 300-video batch download.
 */
import { describe, it, expect } from 'vitest';
import { isYoutubeVideoUrl, youtubeVideoId, youtubeVideoIdFromUrl } from './youtubeUrl.js';

const ACCEPTED = [
  'https://youtu.be/oCnxnaVg0bY',
  'http://youtu.be/oCnxnaVg0bY',
  'https://www.youtube.com/watch?v=oCnxnaVg0bY',
  'https://www.youtube.com/watch?v=oCnxnaVg0bY&list=PLabc&index=2',
  'https://m.youtube.com/watch?v=oCnxnaVg0bY&t=42s',
  'https://music.youtube.com/watch?v=oCnxnaVg0bY',
  'https://youtube.com/shorts/oCnxnaVg0bY',
  'https://www.youtube.com/live/oCnxnaVg0bY',
  'https://www.youtube.com/embed/oCnxnaVg0bY',
];

const REFUSED = [
  'https://www.youtube.com/playlist?list=PLabcdefghij',
  'https://www.youtube.com/@somechannel',
  'https://www.youtube.com/c/somechannel',
  'https://www.youtube.com/feed/history',
  'https://vimeo.com/123456789',
  'https://example.com/watch?v=oCnxnaVg0bY',
  'not a url',
  '',
];

describe('isYoutubeVideoUrl', () => {
  it.each(ACCEPTED)('accepts %j', (url) => {
    expect(isYoutubeVideoUrl(url)).toBe(true);
  });

  it.each(REFUSED)('refuses %j', (url) => {
    expect(isYoutubeVideoUrl(url)).toBe(false);
  });

  it('refuses a non-string without throwing', () => {
    for (const value of [null, undefined, 42, {}]) {
      expect(isYoutubeVideoUrl(value)).toBe(false);
    }
  });
});

describe('youtubeVideoIdFromUrl', () => {
  it.each(ACCEPTED)('extracts the one video id from %j', (url) => {
    expect(youtubeVideoIdFromUrl(url)).toBe('oCnxnaVg0bY');
  });

  it('is what the `youtubeVideoId` alias resolves to', () => {
    expect(youtubeVideoId).toBe(youtubeVideoIdFromUrl);
  });

  it('returns null when there is no id to read', () => {
    expect(youtubeVideoIdFromUrl('https://www.youtube.com/@somechannel')).toBeNull();
    expect(youtubeVideoIdFromUrl('')).toBeNull();
    expect(youtubeVideoIdFromUrl(null)).toBeNull();
  });

  it('bounds the charset so a garbage query string cannot smuggle a giant id', () => {
    expect(youtubeVideoIdFromUrl(`https://www.youtube.com/watch?v=${'a'.repeat(64)}`)).toHaveLength(20);
  });
});
