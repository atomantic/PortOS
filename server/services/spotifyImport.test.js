import { describe, it, expect } from 'vitest';
import {
  resolveSpotifyInstant,
  spotifyUriToUrl,
  spotifyRecordToCandidate,
  spotifyActivityCandidates,
  summarizeSpotifyCandidates,
  parseSpotifyJsonText,
} from './spotifyImport.js';

// A representative extended-history record (Spotify's 2023+ export shape).
const extendedRecord = {
  ts: '2023-05-01T18:30:00Z',
  ms_played: 210000,
  master_metadata_track_name: 'Idioteque',
  master_metadata_album_artist_name: 'Radiohead',
  master_metadata_album_album_name: 'Kid A',
  spotify_track_uri: 'spotify:track:2gjHtqrEnMBmD3lBWJUp2P',
  platform: 'osx',
  reason_start: 'trackdone',
  reason_end: 'trackdone',
  shuffle: false,
  skipped: false,
};

// The older "Account data" StreamingHistory shape.
const legacyRecord = {
  endTime: '2022-01-15 09:05',
  artistName: 'Boards of Canada',
  trackName: 'Roygbiv',
  msPlayed: 132000,
};

describe('resolveSpotifyInstant', () => {
  it('passes ISO-8601 UTC timestamps straight through', () => {
    expect(resolveSpotifyInstant('2023-05-01T18:30:00Z')).toBe('2023-05-01T18:30:00.000Z');
  });

  it('interprets legacy space-separated timestamps as UTC (not OS-local)', () => {
    // Appending :00Z is what prevents a server west of UTC from shifting the day.
    expect(resolveSpotifyInstant('2022-01-15 09:05')).toBe('2022-01-15T09:05:00.000Z');
  });

  it('returns null for empty/unparseable values', () => {
    expect(resolveSpotifyInstant('')).toBeNull();
    expect(resolveSpotifyInstant(null)).toBeNull();
    expect(resolveSpotifyInstant('not a date')).toBeNull();
  });
});

describe('spotifyUriToUrl', () => {
  it('converts a track URI to an open.spotify.com link', () => {
    expect(spotifyUriToUrl('spotify:track:abc123')).toBe('https://open.spotify.com/track/abc123');
  });
  it('converts episode URIs too', () => {
    expect(spotifyUriToUrl('spotify:episode:xyz')).toBe('https://open.spotify.com/episode/xyz');
  });
  it('passes through http(s) URLs and rejects junk', () => {
    expect(spotifyUriToUrl('https://open.spotify.com/track/x')).toBe('https://open.spotify.com/track/x');
    expect(spotifyUriToUrl('garbage')).toBeNull();
    expect(spotifyUriToUrl(null)).toBeNull();
  });
});

describe('spotifyRecordToCandidate', () => {
  it('maps an extended-history record to a media.listen candidate', () => {
    const c = spotifyRecordToCandidate(extendedRecord);
    expect(c).toMatchObject({
      source: 'spotify',
      kind: 'media.listen',
      happenedAt: '2023-05-01T18:30:00.000Z',
      durationS: 210,
      title: 'Idioteque',
      url: 'https://open.spotify.com/track/2gjHtqrEnMBmD3lBWJUp2P',
    });
    expect(c.summary).toBe('Radiohead — Kid A');
    expect(c.metadata).toMatchObject({ artist: 'Radiohead', album: 'Kid A', type: 'track' });
  });

  it('maps a legacy StreamingHistory record', () => {
    const c = spotifyRecordToCandidate(legacyRecord);
    expect(c).toMatchObject({
      source: 'spotify',
      kind: 'media.listen',
      happenedAt: '2022-01-15T09:05:00.000Z',
      durationS: 132,
      title: 'Roygbiv',
    });
    expect(c.summary).toBe('Boards of Canada');
  });

  it('builds a stable dedupe key from track uri + instant', () => {
    const c1 = spotifyRecordToCandidate(extendedRecord);
    const c2 = spotifyRecordToCandidate({ ...extendedRecord });
    expect(c1.dedupeKey).toBe(c2.dedupeKey);
    expect(c1.dedupeKey).toBe('spotify:spotify:track:2gjHtqrEnMBmD3lBWJUp2P:2023-05-01T18:30:00.000Z');
  });

  it('gives URI-less records an artist+album+title fallback identity (no title-only collapse)', () => {
    const base = { endTime: '2022-01-15 09:05', trackName: 'Intro', msPlayed: 1000 };
    const a = spotifyRecordToCandidate({ ...base, artistName: 'Band A', albumName: 'X' });
    const b = spotifyRecordToCandidate({ ...base, artistName: 'Band B', albumName: 'Y' });
    // Same title + same instant, different artists — must NOT share a dedupe key.
    expect(a.dedupeKey).not.toBe(b.dedupeKey);
    expect(a.dedupeKey).toContain('Band A');
  });

  it('classifies podcast episodes and uses the show name as summary', () => {
    const c = spotifyRecordToCandidate({
      ts: '2023-06-01T12:00:00Z',
      ms_played: 1800000,
      episode_name: 'The One About Testing',
      episode_show_name: 'Dev Talk',
      spotify_episode_uri: 'spotify:episode:ep1',
    });
    expect(c.title).toBe('The One About Testing');
    expect(c.summary).toBe('Dev Talk');
    expect(c.metadata.type).toBe('episode');
    expect(c.metadata.showName).toBe('Dev Talk');
  });

  it('drops records with no timestamp or no title', () => {
    expect(spotifyRecordToCandidate({ ms_played: 1000 })).toBeNull();
    expect(spotifyRecordToCandidate({ ts: '2023-01-01T00:00:00Z', ms_played: 1000 })).toBeNull();
    expect(spotifyRecordToCandidate(null)).toBeNull();
  });

  it('leaves durationS null for missing/zero playtime', () => {
    const c = spotifyRecordToCandidate({ ts: '2023-01-01T00:00:00Z', master_metadata_track_name: 'X' });
    expect(c.durationS).toBeNull();
  });
});

describe('spotifyActivityCandidates', () => {
  it('maps a batch and filters unmappable rows', () => {
    const out = spotifyActivityCandidates([extendedRecord, { ms_played: 5 }, legacyRecord]);
    expect(out).toHaveLength(2);
    expect(out.every((c) => c.source === 'spotify')).toBe(true);
  });
  it('returns [] for non-arrays', () => {
    expect(spotifyActivityCandidates(null)).toEqual([]);
    expect(spotifyActivityCandidates({})).toEqual([]);
  });
});

describe('summarizeSpotifyCandidates', () => {
  it('computes range, listen time, unique tracks, and top artists', () => {
    const candidates = spotifyActivityCandidates([
      extendedRecord,
      legacyRecord,
      { ...extendedRecord, ts: '2023-05-02T10:00:00Z' }, // second Radiohead play
    ]);
    const s = summarizeSpotifyCandidates(candidates);
    expect(s.plays).toBe(3);
    expect(s.uniqueTracks).toBe(2); // Idioteque (x2, same uri) + Roygbiv
    expect(s.from).toBe('2022-01-15T09:05:00.000Z');
    expect(s.to).toBe('2023-05-02T10:00:00.000Z');
    expect(s.totalMs).toBe(210000 + 132000 + 210000);
    expect(s.topArtists[0]).toEqual({ name: 'Radiohead', count: 2 });
  });

  it('handles an empty batch', () => {
    const s = summarizeSpotifyCandidates([]);
    expect(s).toMatchObject({ plays: 0, uniqueTracks: 0, totalMs: 0, from: null, to: null });
    expect(s.topArtists).toEqual([]);
  });
});

describe('parseSpotifyJsonText', () => {
  it('parses a top-level array', () => {
    expect(parseSpotifyJsonText(JSON.stringify([extendedRecord]))).toHaveLength(1);
  });
  it('unwraps an { items: [...] } shape', () => {
    expect(parseSpotifyJsonText(JSON.stringify({ items: [extendedRecord] }))).toHaveLength(1);
  });
  it('returns [] for a non-array/object shape', () => {
    expect(parseSpotifyJsonText('42')).toEqual([]);
    expect(parseSpotifyJsonText('{"foo":1}')).toEqual([]);
  });
  it('throws on malformed JSON', () => {
    expect(() => parseSpotifyJsonText('{not json')).toThrow();
  });
});
