import { describe, it, expect } from 'vitest';
import {
  resolveHistoryDay,
  youtubeWatchCandidate,
  youtubeWatchCandidates,
  YOUTUBE_SELECTORS,
} from './youtubeSync.js';

const TZ = 'America/New_York';
const TODAY = '2024-01-15';

describe('resolveHistoryDay', () => {
  it('resolves "Today" / "Yesterday" against the user today', () => {
    expect(resolveHistoryDay('Today', TODAY)).toBe('2024-01-15');
    expect(resolveHistoryDay('Yesterday', TODAY)).toBe('2024-01-14');
  });
  it('is case-insensitive for relative labels', () => {
    expect(resolveHistoryDay('today', TODAY)).toBe('2024-01-15');
    expect(resolveHistoryDay('YESTERDAY', TODAY)).toBe('2024-01-14');
  });
  it('parses an absolute date with a year', () => {
    expect(resolveHistoryDay('Jan 5, 2023', TODAY)).toBe('2023-01-05');
    expect(resolveHistoryDay('November 12, 2022', TODAY)).toBe('2022-11-12');
  });
  it('assigns the current year to a yearless date in the past', () => {
    expect(resolveHistoryDay('Jan 3', TODAY)).toBe('2024-01-03');
  });
  it('rolls a yearless future date back a year', () => {
    // "Dec 25" with today = Jan 15 2024 → the watch was last December.
    expect(resolveHistoryDay('Dec 25', TODAY)).toBe('2023-12-25');
  });
  it('handles month boundaries in yesterday math', () => {
    expect(resolveHistoryDay('Yesterday', '2024-03-01')).toBe('2024-02-29'); // leap year
    expect(resolveHistoryDay('Yesterday', '2024-01-01')).toBe('2023-12-31');
  });
  it('returns null for junk labels or a bad today', () => {
    expect(resolveHistoryDay('', TODAY)).toBeNull();
    expect(resolveHistoryDay('Sometime', TODAY)).toBeNull();
    expect(resolveHistoryDay('Today', 'not-a-date')).toBeNull();
  });
});

describe('youtubeWatchCandidate', () => {
  const entry = {
    title: 'Never Gonna Give You Up',
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    channel: 'Rick Astley',
    channelUrl: 'https://www.youtube.com/channel/UCuAXFkgsw1L7xaCfnd5JJOw',
    dayLabel: 'Today',
  };

  it('maps a scraped entry to a media.watch candidate at local midnight', () => {
    const c = youtubeWatchCandidate(entry, { today: TODAY, timezone: TZ });
    expect(c).toMatchObject({
      source: 'youtube',
      kind: 'media.watch',
      title: 'Never Gonna Give You Up',
      summary: 'Rick Astley',
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      dedupeKey: 'yt:dQw4w9WgXcQ:2024-01-15',
    });
    // Jan 15 2024 local midnight in America/New_York (EST, UTC-5) = 05:00Z.
    expect(c.happenedAt).toBe('2024-01-15T05:00:00.000Z');
    expect(c.metadata).toMatchObject({ videoId: 'dQw4w9WgXcQ', channel: 'Rick Astley', scraped: true, dayBucket: '2024-01-15' });
  });

  it('shares the dedupe-key scheme with the Takeout importer (yt:<id>:<day>)', () => {
    const c = youtubeWatchCandidate({ ...entry, dayLabel: 'Jan 5, 2023' }, { today: TODAY, timezone: TZ });
    expect(c.dedupeKey).toBe('yt:dQw4w9WgXcQ:2023-01-05');
  });

  it('drops entries with no video id or an unresolvable day', () => {
    expect(youtubeWatchCandidate({ ...entry, url: 'https://www.youtube.com/feed/history' }, { today: TODAY, timezone: TZ })).toBeNull();
    expect(youtubeWatchCandidate({ ...entry, dayLabel: 'whenever' }, { today: TODAY, timezone: TZ })).toBeNull();
  });

  it('tolerates a missing channel', () => {
    const c = youtubeWatchCandidate({ ...entry, channel: null, channelUrl: null }, { today: TODAY, timezone: TZ });
    expect(c.summary).toBeNull();
    expect(c.metadata.channel).toBeNull();
  });
});

describe('youtubeWatchCandidates', () => {
  it('maps a batch and filters unmappable entries', () => {
    const out = youtubeWatchCandidates([
      { title: 'A', url: 'https://youtu.be/aaaaaaaaaaa', dayLabel: 'Today' },
      { title: 'gone', url: 'https://www.youtube.com/feed/history', dayLabel: 'Today' },
      { title: 'B', url: 'https://www.youtube.com/watch?v=bbbbbbbbbbb', dayLabel: 'Yesterday' },
    ], { today: TODAY, timezone: TZ });
    expect(out).toHaveLength(2);
    expect(out.every((c) => c.kind === 'media.watch')).toBe(true);
  });
  it('returns [] for a non-array', () => {
    expect(youtubeWatchCandidates(null, { today: TODAY, timezone: TZ })).toEqual([]);
  });
});

describe('YOUTUBE_SELECTORS', () => {
  it('exports the selector map in one place for easy repair', () => {
    expect(YOUTUBE_SELECTORS).toHaveProperty('videoRenderer');
    expect(YOUTUBE_SELECTORS).toHaveProperty('videoTitle');
    expect(YOUTUBE_SELECTORS).toHaveProperty('signedOut');
    expect(YOUTUBE_SELECTORS).toHaveProperty('signedIn');
  });
});
