import { describe, it, expect } from 'vitest';
import {
  youtubeVideoIdFromUrl,
  resolveYoutubeInstant,
  stripWatchedPrefix,
  takeoutWatchRecordToCandidate,
  youtubeWatchActivityCandidates,
  summarizeYoutubeCandidates,
  parseYoutubeJsonText,
} from './youtubeImport.js';

const TZ = 'America/New_York';

// A representative Takeout watch-history.json record.
const watchRecord = {
  header: 'YouTube',
  title: 'Watched Rick Astley - Never Gonna Give You Up',
  titleUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  subtitles: [{ name: 'Rick Astley', url: 'https://www.youtube.com/channel/UCuAXFkgsw1L7xaCfnd5JJOw' }],
  time: '2024-01-05T18:30:00.000Z',
  products: ['YouTube'],
  activityControls: ['YouTube watch history'],
};

describe('youtubeVideoIdFromUrl', () => {
  it('extracts the id from a watch?v= URL', () => {
    expect(youtubeVideoIdFromUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
  });
  it('extracts from youtu.be, shorts, and embed shapes', () => {
    expect(youtubeVideoIdFromUrl('https://youtu.be/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(youtubeVideoIdFromUrl('https://www.youtube.com/shorts/abc123XYZ_-')).toBe('abc123XYZ_-');
    expect(youtubeVideoIdFromUrl('https://www.youtube.com/embed/dQw4w9WgXcQ?rel=0')).toBe('dQw4w9WgXcQ');
  });
  it('handles extra query params after v=', () => {
    expect(youtubeVideoIdFromUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s')).toBe('dQw4w9WgXcQ');
  });
  it('returns null for non-video URLs / junk', () => {
    expect(youtubeVideoIdFromUrl('https://www.youtube.com/feed/history')).toBeNull();
    expect(youtubeVideoIdFromUrl('')).toBeNull();
    expect(youtubeVideoIdFromUrl(null)).toBeNull();
  });
});

describe('resolveYoutubeInstant', () => {
  it('passes ISO-8601 timestamps through', () => {
    expect(resolveYoutubeInstant('2024-01-05T18:30:00Z')).toBe('2024-01-05T18:30:00.000Z');
  });
  it('returns null for empty/unparseable values', () => {
    expect(resolveYoutubeInstant('')).toBeNull();
    expect(resolveYoutubeInstant(null)).toBeNull();
    expect(resolveYoutubeInstant('not a date')).toBeNull();
  });
});

describe('stripWatchedPrefix', () => {
  it('strips the "Watched " prefix', () => {
    expect(stripWatchedPrefix('Watched Some Video Title')).toBe('Some Video Title');
  });
  it('strips the "Viewed " prefix', () => {
    expect(stripWatchedPrefix('Viewed an ad')).toBe('an ad');
  });
  it('keeps a title with no known prefix verbatim', () => {
    expect(stripWatchedPrefix('Никогда не сдавайся')).toBe('Никогда не сдавайся');
  });
  it('handles empty input', () => {
    expect(stripWatchedPrefix('')).toBe('');
    expect(stripWatchedPrefix(null)).toBe('');
  });
});

describe('takeoutWatchRecordToCandidate', () => {
  it('maps a watch record to a media.watch candidate with the exact timestamp', () => {
    const c = takeoutWatchRecordToCandidate(watchRecord, TZ);
    expect(c).toMatchObject({
      source: 'youtube',
      kind: 'media.watch',
      happenedAt: '2024-01-05T18:30:00.000Z',
      title: 'Rick Astley - Never Gonna Give You Up',
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      summary: 'Rick Astley',
    });
    expect(c.metadata).toMatchObject({
      videoId: 'dQw4w9WgXcQ',
      channel: 'Rick Astley',
      channelUrl: 'https://www.youtube.com/channel/UCuAXFkgsw1L7xaCfnd5JJOw',
      product: 'YouTube',
    });
  });

  it('day-buckets the dedupe key in the user timezone', () => {
    // 18:30Z on Jan 5 is 13:30 in America/New_York → still Jan 5 local.
    const c = takeoutWatchRecordToCandidate(watchRecord, TZ);
    expect(c.dedupeKey).toBe('yt:dQw4w9WgXcQ:2024-01-05');
    // The dedupe day follows local time: 02:00Z Jan 6 is 21:00 Jan 5 in NY.
    const late = takeoutWatchRecordToCandidate({ ...watchRecord, time: '2024-01-06T02:00:00Z' }, TZ);
    expect(late.dedupeKey).toBe('yt:dQw4w9WgXcQ:2024-01-05');
  });

  it('drops removed videos (no titleUrl) and missing timestamps', () => {
    expect(takeoutWatchRecordToCandidate({ title: 'Watched a video that has been removed', time: '2024-01-05T18:30:00Z' }, TZ)).toBeNull();
    expect(takeoutWatchRecordToCandidate({ ...watchRecord, time: undefined }, TZ)).toBeNull();
    expect(takeoutWatchRecordToCandidate(null, TZ)).toBeNull();
  });

  it('tolerates a record with no channel subtitle', () => {
    const c = takeoutWatchRecordToCandidate({ ...watchRecord, subtitles: undefined }, TZ);
    expect(c.summary).toBeNull();
    expect(c.metadata.channel).toBeNull();
  });
});

describe('youtubeWatchActivityCandidates', () => {
  it('maps a batch and filters unmappable rows', () => {
    const out = youtubeWatchActivityCandidates([
      watchRecord,
      { title: 'Watched a video that has been removed', time: '2024-01-05T18:30:00Z' },
      { ...watchRecord, titleUrl: 'https://www.youtube.com/watch?v=abcDEF12345', time: '2024-02-01T10:00:00Z' },
    ], TZ);
    expect(out).toHaveLength(2);
    expect(out.every((c) => c.source === 'youtube')).toBe(true);
  });
  it('returns [] for non-arrays', () => {
    expect(youtubeWatchActivityCandidates(null, TZ)).toEqual([]);
    expect(youtubeWatchActivityCandidates({}, TZ)).toEqual([]);
  });
});

describe('summarizeYoutubeCandidates', () => {
  it('computes range, unique videos, and top channels', () => {
    const candidates = youtubeWatchActivityCandidates([
      watchRecord,
      { ...watchRecord, time: '2024-02-10T12:00:00Z' }, // same video, later day
      {
        ...watchRecord,
        titleUrl: 'https://www.youtube.com/watch?v=abcDEF12345',
        subtitles: [{ name: 'Other Channel' }],
        time: '2023-12-01T08:00:00Z',
      },
    ], TZ);
    const s = summarizeYoutubeCandidates(candidates);
    expect(s.watches).toBe(3);
    expect(s.uniqueVideos).toBe(2);
    expect(s.from).toBe('2023-12-01T08:00:00.000Z');
    expect(s.to).toBe('2024-02-10T12:00:00.000Z');
    expect(s.topChannels[0]).toEqual({ name: 'Rick Astley', count: 2 });
  });

  it('handles an empty batch', () => {
    const s = summarizeYoutubeCandidates([]);
    expect(s).toMatchObject({ watches: 0, uniqueVideos: 0, from: null, to: null });
    expect(s.topChannels).toEqual([]);
  });
});

describe('parseYoutubeJsonText', () => {
  it('parses a top-level array', () => {
    expect(parseYoutubeJsonText(JSON.stringify([watchRecord]))).toHaveLength(1);
  });
  it('unwraps an { items: [...] } shape', () => {
    expect(parseYoutubeJsonText(JSON.stringify({ items: [watchRecord] }))).toHaveLength(1);
  });
  it('returns [] for a non-array/object shape', () => {
    expect(parseYoutubeJsonText('42')).toEqual([]);
    expect(parseYoutubeJsonText('{"foo":1}')).toEqual([]);
  });
  it('throws on malformed JSON', () => {
    expect(() => parseYoutubeJsonText('{not json')).toThrow();
  });
});
