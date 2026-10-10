/**
 * Which links a posted record already carries: its recorded `links`, else
 * what its draft always linked, counted only when that link existed first.
 */
import { describe, expect, it } from 'vitest';
import { carriedLinks, crossLinkBackfill, dropCarriedLink } from './musicVideoCrossLinks.js';

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

  it('stops counting a removed or replaced post as linked, so backfill offers the new URL', () => {
    const kit = { posts: {
      youtube: { url: 'https://youtu.be/abc', postedAt: '2026-01-01T00:00:00Z', links: [] },
      x: { url: 'https://x.com/a/status/1', postedAt: '2026-01-02T00:00:00Z', links: ['youtube'] },
    } };
    const posts = dropCarriedLink(kit, kit.posts, 'youtube');
    expect(posts.x.links).toEqual([]);
    expect(posts.youtube).toBe(kit.posts.youtube);
    // Legacy post without a links list is given an explicit one.
    const legacy = { posts: { youtube: kit.posts.youtube, suno: { url: song, postedAt: '2026-01-03T00:00:00Z' } } };
    expect(dropCarriedLink(legacy, legacy.posts, 'youtube').suno.links).toEqual([]);
    // Reposted on a new URL: the other post is missing it again.
    const reposted = { posts: { ...posts, youtube: { url: 'https://youtu.be/new', postedAt: '2026-01-04T00:00:00Z', links: [] } } };
    expect(crossLinkBackfill(reposted).find((r) => r.target === 'x').missing.map((l) => l.url)).toContain('https://youtu.be/new');
  });

  it('offers a replaced YouTube video to a Stacker News post that linked the old one', () => {
    const kit = { posts: {
      youtube: { url: 'https://youtu.be/new', postedAt: '2026-01-04T00:00:00Z', links: [] },
      stackerNews: { url: 'https://stacker.news/items/7', postedAt: '2026-01-02T00:00:00Z', links: ['youtube'] },
    } };
    expect(crossLinkBackfill(kit).find((r) => r.target === 'stackerNews').missing).toEqual([]);
    const dropped = { posts: dropCarriedLink(kit, kit.posts, 'youtube') };
    expect(crossLinkBackfill(dropped).find((r) => r.target === 'stackerNews').missing.map((l) => l.url)).toEqual(['https://youtu.be/new']);
  });
});
