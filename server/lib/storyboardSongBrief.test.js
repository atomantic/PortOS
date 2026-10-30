import { describe, expect, it } from 'vitest';
import { storyboardSongBriefText, storyboardSongSections, storyboardTimeline } from './storyboardSongBrief.js';

const panel = (over = {}) => ({ action: '', dialogue: '', seconds: null, ...over });
const board = {
  name: 'Example Story',
  logline: 'A dancer comes home.',
  beats: [
    { id: 'beat-1', title: 'Arrival', what: 'She steps into the empty gym', emotion: 'wistful', musicalRole: 'intro', sectionHint: '', panels: [panel({ seconds: 4.5 }), panel()] },
    { id: 'beat-2', title: 'First dance', what: '', emotion: '', musicalRole: 'chorus', sectionHint: 'half-time', panels: [panel({ seconds: 8, dialogue: 'Here I am' })] },
    { id: 'beat-3', title: 'Aside', what: '', emotion: '', musicalRole: null, sectionHint: '', panels: [] },
  ],
};

describe('storyboard song brief', () => {
  it('maps beats to sections, holding unset panels for the animatic default', () => {
    const sections = storyboardSongSections(board);
    expect(sections.map((s) => [s.label, s.seconds, s.estimated, s.energy])).toEqual([
      ['Intro', 7.5, true, 'low'],
      ['Chorus', 8, false, 'high'],
      ['Section 3', 0, false, null],
    ]);
  });

  it('writes a paste-ready brief with the structure tags and sung lines', () => {
    const text = storyboardSongBriefText(board);
    expect(text).toContain('Length: about 0:15.50 across 3 sections');
    expect(text).toContain('Structure: [Intro] [Chorus]');
    expect(text).toContain('1. Intro, 0:07.50, low energy\n   Beat: Arrival\n   Mood: wistful\n   Lyric theme: She steps into the empty gym');
    expect(text).toContain('   Note: half-time\n   Lines: Here I am');
  });

  it('starts a pinned beat at its marker and fits the beats before it to reach it', () => {
    const pinned = {
      ...board,
      tempTrack: {
        filename: '0a1b2c3d-demo.mp3', name: 'demo.mp3',
        sections: [{ id: 'sec-chorus', label: 'Chorus 1', at: 30 }],
        lines: [{ id: 'line-1', text: 'Here I am', at: 12 }, { id: 'line-2', text: 'Not yet', at: null }],
      },
      beats: [
        board.beats[0],
        { ...board.beats[1], pin: 'sec-chorus' },
        // Pinned to an unstamped line: plays on at its holds after the chorus.
        { ...board.beats[2], pin: 'line-2', panels: [panel({ seconds: 2 })] },
      ],
    };
    const { panels, beats, end } = storyboardTimeline(pinned);
    // Intro's 4.5 + 3 s of holds stretch to fill 0..30 at the same ratio.
    expect(panels.map((p) => [p.start, p.end])).toEqual([[0, 18], [18, 30], [30, 38], [38, 40]]);
    expect(beats.map((b) => [b.pinned, b.fitted])).toEqual([[false, true], [true, false], [false, false]]);
    expect(end).toBe(40);
    const sections = storyboardSongSections(pinned);
    expect(sections[0]).toMatchObject({ seconds: 30, estimated: false });
    expect(storyboardSongBriefText(pinned)).toContain('2. Chorus, 0:08.00, starts at 0:30.00, high energy');
  });

  it('ignores a pin that would run time backwards', () => {
    const track = { filename: '0a1b2c3d-demo.mp3', name: 'demo.mp3', sections: [{ id: 'sec-a', label: 'A', at: 20 }, { id: 'sec-b', label: 'B', at: 10 }], lines: [] };
    const beats = [
      { ...board.beats[0], pin: 'sec-a', panels: [panel({ seconds: 5 })] },
      { ...board.beats[1], pin: 'sec-b', panels: [panel({ seconds: 5 })] },
    ];
    expect(storyboardTimeline({ ...board, tempTrack: track, beats }).panels.map((p) => p.start)).toEqual([20, 25]);
  });

  it('plays the beats before the song first and starts the song, and its pins, after them', () => {
    const track = { filename: '0a1b2c3d-demo.mp3', name: 'demo.mp3', sections: [{ id: 'sec-chorus', label: 'Chorus 1', at: 30 }], lines: [] };
    const opened = {
      ...board,
      tempTrack: track,
      beats: [
        { id: 'beat-0', title: 'Booth', what: 'He presses play', emotion: '', musicalRole: null, sectionHint: '', beforeSong: true, panels: [panel({ seconds: 2 }), panel({ seconds: 1.5 })] },
        board.beats[0],
        { ...board.beats[1], pin: 'sec-chorus' },
      ],
    };
    const { panels, songStartSec } = storyboardTimeline(opened);
    expect(songStartSec).toBe(3.5);
    expect(panels.map((p) => [p.start, p.end, !!p.beforeSong])).toEqual([
      [0, 2, true], [2, 3.5, true], [3.5, 21.5, false], [21.5, 33.5, false], [33.5, 41.5, false],
    ]);
    // The song map is the song's alone, on its own clock.
    const sections = storyboardSongSections(opened);
    expect(sections.map((s) => [s.label, s.start])).toEqual([['Intro', 0], ['Chorus', 30]]);
  });
});
