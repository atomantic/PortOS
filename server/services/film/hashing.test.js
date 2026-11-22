import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { blenderSongHash, blenderSongHashes } from './hashing.js';

const song = {
  projectId: 'p1', title: 'A title', durationSec: 10, fps: 24,
  audio: { master: '/install/a/data/music/master.m4a', vocalStem: null },
  analysis: { bpm: 120, beats: [0.5], downbeats: [], sections: [], features: null },
  lyrics: { cues: [{ index: 0, id: 'l1', text: 'Words', startSec: 0, endSec: 1, words: [] }], markers: [] },
};

describe('blenderSongHash', () => {
  it('ignores the display name and where the audio files live', () => {
    expect(blenderSongHash({ ...song, title: 'Another title' })).toBe(blenderSongHash(song));
    expect(blenderSongHash({ ...song, audio: { ...song.audio, master: '/install/b/data/music/master.m4a' } })).toBe(blenderSongHash(song));
  });

  it('changes with anything a shot can be cut to', () => {
    expect(blenderSongHash({ ...song, audio: { ...song.audio, master: '/install/a/data/music/replaced.m4a' } })).not.toBe(blenderSongHash(song));
    expect(blenderSongHash({ ...song, audio: { ...song.audio, vocalStem: '/install/a/data/music/stem.wav' } })).not.toBe(blenderSongHash(song));
    expect(blenderSongHash({ ...song, lyrics: { ...song.lyrics, cues: [] } })).not.toBe(blenderSongHash(song));
    expect(blenderSongHash({ ...song, analysis: { ...song.analysis, bpm: 121 } })).not.toBe(blenderSongHash(song));
  });

  it('still accepts the whole-context hash older renders recorded', () => {
    const legacy = createHash('sha256').update(JSON.stringify(song)).digest('hex');
    expect(blenderSongHashes(song)).toEqual([blenderSongHash(song), legacy]);
  });
});
