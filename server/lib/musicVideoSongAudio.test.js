import { describe, it, expect } from 'vitest';
import { assertSongAudioCurrent, songAudioChange } from './musicVideoSongAudio.js';

const cue = { id: 'c1', text: 'la', startSec: 1, endSec: 2 };

describe('songAudioChange', () => {
  it('flags a derived state recorded against another file, and only when it exists', () => {
    const project = { audioAnalysis: { masterFilename: 'old.wav' }, lyricTimingMasterFilename: 'old.wav', lyricCues: [cue] };
    expect(songAudioChange(project, 'new.wav')).toMatchObject({ analysisStale: true, lyricsStale: true });
    expect(songAudioChange(project, 'old.wav')).toBeNull();
    // Cues whose timings were cleared have nothing left to be stale.
    expect(songAudioChange({ ...project, lyricCues: [{ id: 'c1', text: 'la', startSec: null, endSec: null }] }, 'new.wav'))
      .toMatchObject({ analysisStale: true, lyricsStale: false });
  });

  it('treats a record that never recorded its file as unknown, not stale', () => {
    expect(songAudioChange({ audioAnalysis: {}, lyricCues: [cue] }, 'new.wav')).toBeNull();
    expect(songAudioChange({ audioAnalysis: { masterFilename: 'old.wav' } }, null)).toBeNull();
  });
});

describe('assertSongAudioCurrent', () => {
  it('refuses a render of a replaced song with a code the client can act on', () => {
    expect(() => assertSongAudioCurrent({ audioAnalysis: { masterFilename: 'old.wav' } }, 'new.wav'))
      .toThrow(expect.objectContaining({ status: 409, code: 'SONG_AUDIO_CHANGED' }));
    expect(() => assertSongAudioCurrent({ audioAnalysis: { masterFilename: 'new.wav' } }, 'new.wav')).not.toThrow();
  });
});
