/**
 * Hook typography (#9291): repeated lines are hooks, and a hook cue carries
 * its sung word onsets for the word-by-word build.
 */
import { describe, expect, it } from 'vitest';
import { cueWordOnsets, hookKey, hookLines } from './hookTypography.js';
import { buildTypographyDocument, cueStateAt, normalizeComposition } from './composition.js';

describe('hook typography (#9291)', () => {
  it('finds lines sung two or more times, ignoring case and punctuation', () => {
    const hooks = hookLines([{ text: 'Tie me to the mast!' }, { text: 'tie me to the MAST' }, { text: 'Once only' }]);
    expect([...hooks]).toEqual([hookKey('Tie me to the mast')]);
  });

  it('keeps the cue\'s aligned word onsets inside its span', () => {
    const cue = { startSec: 10, words: [{ w: 'Tie', startSec: 10.02 }, { w: 'me', startSec: 10.4 }, { w: ' ', startSec: 10.5 }, { w: 'late', startSec: 13 }, { w: 'x', startSec: null }] };
    expect(cueWordOnsets(cue, 12)).toEqual([{ w: 'Tie', atSec: 10.02 }, { w: 'me', atSec: 10.4 }]);
  });

  it('builds word by word on the onsets and fades the held line out', () => {
    const cue = { id: 'h', text: 'Tie me to the mast', startSec: 10, endSec: 14, template: 'build', placement: 'center', emphasis: 'hero',
      words: [{ w: 'Tie', atSec: 10 }, { w: 'me', atSec: 10.5 }, { w: 'to', atSec: 11 }, { w: 'the', atSec: 11.2 }, { w: 'mast', atSec: 11.6 }] };
    expect(cueStateAt(cue, 10.1)).toMatchObject({ visibleWords: 1, opacity: 1 });
    expect(cueStateAt(cue, 11.1)).toMatchObject({ visibleWords: 3 });
    expect(cueStateAt(cue, 12)).toMatchObject({ visibleWords: 5, opacity: 1 });
    expect(cueStateAt(cue, 13.9).opacity).toBeLessThan(1);
    // Without onsets the words spread over the first 60% of the cue.
    expect(cueStateAt({ ...cue, words: undefined }, 10).visibleWords).toBe(1);
    expect(cueStateAt({ ...cue, words: undefined }, 12.5).visibleWords).toBe(5);
  });

  it('keeps words and the accent color through normalization and into the overlay page', () => {
    const comp = normalizeComposition({ mode: 'composed', style: { accentColor: '#FF0000' }, textCues: [{ text: 'Tie me', startSec: 1, endSec: 3, template: 'build', words: [{ w: 'me', atSec: 1.5 }, { w: 'Tie', atSec: 1 }] }] });
    expect(comp.style.accentColor).toBe('#ff0000');
    expect(comp.textCues[0].words).toEqual([{ w: 'Tie', atSec: 1 }, { w: 'me', atSec: 1.5 }]);
    expect(normalizeComposition({ textCues: [] }).style).toEqual({ color: '#ffffff', font: 'sans' });
    const html = buildTypographyDocument({ cues: comp.textCues, style: comp.style, width: 1920, height: 1080, durationSec: 5, fps: 24 });
    expect(html).toContain('const ACCENT = "#ff0000"');
    expect(html).toContain('"words":[{"w":"Tie","atSec":1}');
  });
});
