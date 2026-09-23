import { describe, it, expect } from 'vitest';
import { parseXPostUrl, buildSyndicationUrl, syndicationToken, extractXPostMedia } from './xPostMedia.js';

describe('parseXPostUrl', () => {
  it('extracts the status id and canonicalizes to /i/status/<id>', () => {
    expect(parseXPostUrl('https://x.com/someuser/status/1234567890123456789')).toEqual({
      statusId: '1234567890123456789',
      canonicalUrl: 'https://x.com/i/status/1234567890123456789',
    });
  });

  it('accepts twitter.com and www subdomains', () => {
    expect(parseXPostUrl('https://www.twitter.com/someuser/status/42').statusId).toBe('42');
    expect(parseXPostUrl('https://twitter.com/someuser/status/42').statusId).toBe('42');
  });

  it('ignores trailing path segments and query strings', () => {
    expect(parseXPostUrl('https://x.com/someuser/status/42/photo/1?s=20').statusId).toBe('42');
  });

  it('rejects a non-string/empty input', () => {
    expect(() => parseXPostUrl('')).toThrow(/required/i);
    expect(() => parseXPostUrl(null)).toThrow(/required/i);
  });

  it('rejects an unparseable URL', () => {
    expect(() => parseXPostUrl('not a url')).toThrow(/valid url/i);
  });

  it('rejects a non-http(s) scheme', () => {
    expect(() => parseXPostUrl('ftp://x.com/user/status/1')).toThrow(/http/i);
  });

  it('rejects a lookalike host', () => {
    expect(() => parseXPostUrl('https://x.com.evil.com/user/status/1')).toThrow(/doesn.t look like/i);
    expect(() => parseXPostUrl('https://evil-x.com/user/status/1')).toThrow(/doesn.t look like/i);
    expect(() => parseXPostUrl('https://example.com/user/status/1')).toThrow(/doesn.t look like/i);
  });

  it('rejects an X URL that is not a status post', () => {
    expect(() => parseXPostUrl('https://x.com/someuser')).toThrow(/full post url/i);
    expect(() => parseXPostUrl('https://x.com/i/lists/1')).toThrow(/full post url/i);
  });

  it('every ServerError carries the same error code', () => {
    for (const bad of ['', 'ftp://x.com/user/status/1', 'https://example.com/user/status/1', 'https://x.com/user']) {
      try {
        parseXPostUrl(bad);
        throw new Error('expected parseXPostUrl to throw');
      } catch (err) {
        expect(err.status).toBe(400);
        expect(err.code).toBe('INVALID_X_POST_URL');
      }
    }
  });
});

describe('syndicationToken / buildSyndicationUrl', () => {
  it('produces a deterministic non-empty token for a given status id', () => {
    const token = syndicationToken('1234567890123456789');
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(0);
    expect(syndicationToken('1234567890123456789')).toBe(token);
  });

  it('builds a syndication URL carrying the id and a token', () => {
    const url = buildSyndicationUrl('42');
    expect(url).toContain('cdn.syndication.twimg.com/tweet-result');
    expect(url).toContain('id=42');
    expect(url).toMatch(/token=[a-z0-9]+/);
  });
});

describe('extractXPostMedia', () => {
  it('returns empty media for malformed input', () => {
    expect(extractXPostMedia(null)).toEqual({ images: [], video: null });
    expect(extractXPostMedia('not json')).toEqual({ images: [], video: null });
    expect(extractXPostMedia({})).toEqual({ images: [], video: null });
  });

  it('extracts photo URLs', () => {
    const { images, video } = extractXPostMedia({
      photos: [{ url: 'https://pbs.twimg.com/media/a.jpg' }, { url: 'https://pbs.twimg.com/media/b.jpg' }],
    });
    expect(images).toEqual(['https://pbs.twimg.com/media/a.jpg', 'https://pbs.twimg.com/media/b.jpg']);
    expect(video).toBeNull();
  });

  it('drops malformed photo entries', () => {
    const { images } = extractXPostMedia({ photos: [{ url: 'ok.jpg' }, {}, { url: 42 }, null] });
    expect(images).toEqual(['ok.jpg']);
  });

  it('picks the highest-bitrate mp4 variant and the poster', () => {
    const { images, video } = extractXPostMedia({
      video: {
        poster: 'https://pbs.twimg.com/poster.jpg',
        variants: [
          { type: 'application/x-mpegURL', src: 'https://video.twimg.com/x.m3u8' },
          { type: 'video/mp4', src: 'https://video.twimg.com/low.mp4', bitrate: 256000 },
          { type: 'video/mp4', src: 'https://video.twimg.com/high.mp4', bitrate: 2176000 },
        ],
      },
    });
    expect(images).toEqual([]);
    expect(video).toEqual({ url: 'https://video.twimg.com/high.mp4', poster: 'https://pbs.twimg.com/poster.jpg' });
  });

  it('returns a null video when only a non-mp4 variant is present', () => {
    const { video } = extractXPostMedia({
      video: { variants: [{ type: 'application/x-mpegURL', src: 'https://video.twimg.com/x.m3u8' }] },
    });
    expect(video).toBeNull();
  });
});
