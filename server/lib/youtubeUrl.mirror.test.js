/**
 * Mirror parity test for the YouTube single-video URL rule.
 *
 * Authoritative: `isYoutubeVideoUrl` + `youtubeVideoIdFromUrl` (`server/lib/youtubeUrl.js`).
 * Mirror:        `isYoutubeVideoUrl` + `youtubeVideoId` (client).
 *
 * Quick Capture swaps its ENTIRE submit path on the client predicate — a looser
 * client offers ingest options for a URL the server will reject with a 400, and
 * a tighter one silently files a real video as a plain link. Unlike the
 * bareUrl mirror (which compares declaration source text), this compares
 * BEHAVIOR: the two live in differently-shaped modules — the client copy also
 * carries the ingest-options table — so a text diff would fail on structure
 * rather than on drift.
 */

import { describe, it, expect } from 'vitest';
import { isYoutubeVideoUrl as serverAccepts, youtubeVideoIdFromUrl } from './youtubeUrl.js';
import { isYoutubeVideoUrl, youtubeVideoId } from '../../client/src/lib/youtubeUrl.js';

const CASES = [
  'https://youtu.be/oCnxnaVg0bY',
  'http://youtu.be/oCnxnaVg0bY',
  'https://www.youtube.com/watch?v=oCnxnaVg0bY',
  'https://www.youtube.com/watch?v=oCnxnaVg0bY&list=PLabc&index=2',
  'https://m.youtube.com/watch?v=oCnxnaVg0bY&t=42s',
  'https://music.youtube.com/watch?v=oCnxnaVg0bY',
  'https://youtube.com/shorts/oCnxnaVg0bY',
  'https://www.youtube.com/live/oCnxnaVg0bY',
  'https://www.youtube.com/embed/oCnxnaVg0bY',
  // Not single videos — must be rejected by both.
  'https://www.youtube.com/playlist?list=PLabcdefghij',
  'https://www.youtube.com/@somechannel',
  'https://www.youtube.com/c/somechannel',
  'https://www.youtube.com/feed/history',
  'https://vimeo.com/123456789',
  'https://example.com/watch?v=oCnxnaVg0bY',
  'not a url',
  '',
];

describe('youtubeUrl server↔client mirror parity', () => {
  it.each(CASES)('agrees on whether %j is a single-video YouTube URL', (url) => {
    expect(isYoutubeVideoUrl(url)).toBe(serverAccepts(url));
  });

  it.each(CASES.filter(serverAccepts))('extracts the same video id from %j', (url) => {
    expect(youtubeVideoId(url)).toBe(youtubeVideoIdFromUrl(url));
  });

  it('covers both outcomes, so a rule that always returns one value cannot pass', () => {
    expect(CASES.some(serverAccepts)).toBe(true);
    expect(CASES.some((u) => !serverAccepts(u))).toBe(true);
  });
});
