/**
 * Which links a posted record already carries: its recorded `links`, else
 * what its draft always linked, counted only when that link existed first.
 */
import { describe, expect, it } from 'vitest';
import { carriedLinks, crossLinkBackfill } from './musicVideoCrossLinks.js';

const song = 'https://suno.com/song/12345678-abcd-4abc-8abc-123456789abc';

describe('cross-links between release posts', () => {
  it('reads a post recorded before links were kept by what its draft linked at the time', () => {
    const kit = { links: { song }, posts: {
      x: { url: 'https://x.com/example/status/1', postedAt: '2026-01-01T01:00:00Z' },
      youtube: { url: 'https://youtu.be/abc', postedAt: '2026-01-01T02:00:00Z' },
      suno: { url: song, postedAt: '2026-01-01T00:00:00Z' },
    } };
    // The song was up before the X thread; the video came after it.
    expect(carriedLinks(kit, 'x')).toEqual(['suno']);
    expect(carriedLinks({ ...kit, posts: { ...kit.posts, x: { ...kit.posts.x, links: ['youtube'] } } }, 'x')).toEqual(['youtube']);
    // A song link given the kit by hand counts as there from the start.
    expect(carriedLinks({ links: { song }, posts: { x: kit.posts.x } }, 'x')).toEqual(['suno']);
    const rows = Object.fromEntries(crossLinkBackfill(kit).map((r) => [r.target, r]));
    expect(rows.x.text).toBe('Music video: https://youtu.be/abc');
    expect(rows.suno.missing.map((l) => l.target)).toEqual(['youtube', 'x']);
    expect(rows.youtube.missing.map((l) => l.target)).toEqual(['suno', 'x']);
    expect(rows.stackerNews).toBeUndefined();
  });
});
