/**
 * Hook windows for vertical social cuts (#9280): the scoring prefers a sung,
 * lip-synced chorus that says the title, windows never overlap, and a song
 * with no lyric timing (or shorter than a cut) still gets a usable window.
 */
import { describe, expect, it } from 'vitest';
import { suggestSocialCuts } from './socialCuts.js';

const line = (text, startSec, endSec) => ({ id: `lc-${startSec}`, text, startSec, endSec });
const scene = (startSec, endSec, shotMode, sectionLabel) => ({ sceneId: `mvs-${startSec}`, startSec, endSec, shotMode, sectionLabel });

// 90 s song: a quiet cutaway verse (0–30), a lip-synced chorus that sings the
// title (30–60), then a loud instrumental-ish outro with sparse lyrics (60–90).
const project = {
  name: 'Example Song',
  audioAnalysis: { durationSec: 90, waveform: Array.from({ length: 90 }, (_, i) => (i < 30 ? 0.2 : i < 60 ? 0.6 : 0.8)) },
  scenes: [scene(0, 30, 'cutaway', 'Verse 1'), scene(30, 60, 'performance', 'Chorus 1'), scene(60, 90, 'cutaway', 'Outro')],
  lyricCues: [
    ...Array.from({ length: 6 }, (_, i) => line(`verse line ${i}`, i * 5, i * 5 + 4)),
    ...Array.from({ length: 6 }, (_, i) => line(i === 1 ? 'this is my example song' : `chorus line ${i}`, 30 + i * 5, 30 + i * 5 + 4)),
    line('outro line', 70, 74),
  ],
};

describe('suggestSocialCuts (#9280)', () => {
  it('ranks the lip-synced chorus that sings the title first, with its reasons', () => {
    const [best] = suggestSocialCuts(project);
    expect(best.startSec).toBeGreaterThanOrEqual(29);
    expect(best.endSec).toBeLessThanOrEqual(60.5);
    expect(best.endSec - best.startSec).toBeGreaterThanOrEqual(15);
    expect(best.reasons).toEqual(expect.arrayContaining(['chorus', 'sings the title']));
    expect(best.label).toMatch(/chorus line|example song/);
  });

  it('returns non-overlapping windows inside the song and within the length bounds', () => {
    const cuts = suggestSocialCuts(project, { count: 5, minSec: 8, maxSec: 12 });
    expect(cuts.length).toBeGreaterThan(1);
    for (const c of cuts) {
      expect(c.startSec).toBeGreaterThanOrEqual(0);
      expect(c.endSec).toBeLessThanOrEqual(90);
      expect(c.endSec - c.startSec).toBeGreaterThanOrEqual(8 - 1e-9);
      expect(c.endSec - c.startSec).toBeLessThanOrEqual(12 + 1e-9);
    }
    const sorted = [...cuts].sort((a, b) => a.startSec - b.startSec);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i].startSec).toBeGreaterThanOrEqual(sorted[i - 1].endSec);
  });

  it('falls back to evenly spaced windows when the song has no lyric timing', () => {
    const cuts = suggestSocialCuts({ ...project, lyricCues: [] }, { count: 2, minSec: 15, maxSec: 20 });
    expect(cuts).toHaveLength(2);
    expect(cuts.every((c) => Math.abs(c.endSec - c.startSec - 20) < 1e-6)).toBe(true);
  });

  it('offers the whole song when it is shorter than a cut, and nothing without a duration', () => {
    expect(suggestSocialCuts({ audioAnalysis: { durationSec: 9 } })).toEqual([{ startSec: 0, endSec: 9, score: 1, label: null, reasons: ['whole song'] }]);
    expect(suggestSocialCuts({})).toEqual([]);
  });
});
