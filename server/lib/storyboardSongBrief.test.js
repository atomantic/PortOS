import { describe, expect, it } from 'vitest';
import { storyboardSongBriefText, storyboardSongSections } from './storyboardSongBrief.js';

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
});
