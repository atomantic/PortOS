import { describe, expect, it } from 'vitest';
import { musicVideoSongDocument } from './compositionRender.js';

describe('musicVideoSongDocument', () => {
  it('carries timings and a null feature block when none were measured', () => {
    expect(musicVideoSongDocument({
      audioAnalysis: {
        durationSec: 180, beats: [0, 0.5], downbeats: [0],
        sections: [{ label: 'verse', startSec: 0, endSec: 8 }],
        features: [],
      },
      lyricCues: [{ text: 'go on', words: [{ w: 'go', startSec: 1, endSec: 1.2, conf: 'matched' }] }],
    })).toEqual({
      beats: [0, 0.5],
      downbeats: [0],
      sections: [{ label: 'verse', startSec: 0, endSec: 8 }],
      features: null,
      words: [{ w: 'go', startSec: 1, endSec: 1.2, conf: 'matched' }],
    });
  });

  it('leaves word timings null when no cue has been aligned', () => {
    expect(musicVideoSongDocument({
      audioAnalysis: { durationSec: 30, beats: [], downbeats: [], sections: [] }, lyricCues: [{ text: 'go' }],
    }).words).toBeNull();
  });
});
