import { describe, expect, it } from 'vitest';
import { alignDirectorWords, detectVocalPhrases } from './lyricAlignCore.js';

function signal(duration, spans) {
  const pcm = new Float32Array(duration * 16000);
  for (const [start, end, amplitude = 0.2] of spans) pcm.fill(amplitude, start * 16000, end * 16000);
  return pcm;
}
const words = (text, start = 1) => text.split(' ').map((text, i) => ({ text, startSec: start + i * 0.3, endSec: start + (i + 1) * 0.3 }));

describe('vocal phrase anchors', () => {
  it('drops short noise, bridges short breaths, and locates the quieter onset before a loud phrase', () => {
    const pcm = signal(5, [[0.2, 0.25], [1, 1.2, 0.007], [1.2, 2], [2.05, 2.4], [3, 4]]);
    const phrases = detectVocalPhrases(pcm);
    expect(phrases).toHaveLength(2);
    expect(phrases[0].startSec).toBeCloseTo(1, 1);
    expect(phrases[0].endSec).toBeCloseTo(2.4, 1);
    expect(phrases[1].startSec).toBeCloseTo(3, 1);
    expect(detectVocalPhrases(new Float32Array(16000))).toEqual([]);
    const quietBed = detectVocalPhrases(signal(6, [[1, 5, 0.007], [1, 2], [4, 5]]));
    expect(quietBed).toHaveLength(2);
    expect(quietBed[1].startSec).toBeGreaterThanOrEqual(quietBed[0].endSec);
  });

  it('splits a long sustained phrase at its deepest dip and bounds flat phrases', () => {
    const pcm = signal(17, [[0, 17]]);
    pcm.fill(0.012, 6 * 16000, 6.04 * 16000);
    const phrases = detectVocalPhrases(pcm);
    expect(phrases[0].endSec).toBeCloseTo(6.02, 1);
    expect(phrases.every((p) => p.endSec - p.startSec <= 7)).toBe(true);
    expect(phrases.at(-1).endSec).toBe(17);
  });

});

describe('phrase lyric matching', () => {
  it('merges contractions and fragments, accepts aliases and fuzzy words, and skips unrelated recognition', () => {
    const [line] = alignDirectorWords([{ text: "I'm prompt of swarm shining" }], words("I 'm Prom pt a sword unrelated shinning"), { phraseAnchored: true });
    expect(line.matched).toBe(1);
    expect(line.words.map((word) => word.w)).toEqual(["I'm", 'prompt', 'of', 'swarm', 'shining']);
    expect(line.words[1]).toMatchObject({ startSec: 1.6, endSec: 2.2 });
    expect(line.words.at(-1).startSec).toBe(3.1);
  });

  it('keeps repeated verses in order without letting a missing word consume the next verse', () => {
    const [line] = alignDirectorWords([{ text: 'hello the morning hello the morning' }], words('hello morning hello the morning'), { phraseAnchored: true });
    expect(line.words.map((word) => word.conf)).toEqual(['matched', 'interpolated', 'matched', 'matched', 'matched', 'matched']);
    expect(line.words[3].startSec).toBeCloseTo(1.6);
  });

});

describe('findSilentWords (#10610)', () => {
  it('flags only words whose window is silent in the stem', async () => {
    const { findSilentWords } = await import('./lyricAlignCore.js');
    const rate = 16000;
    const pcm = new Float32Array(rate * 4);
    for (let i = rate; i < rate * 2; i++) pcm[i] = 0.3 * Math.sin(i / 10);
    const cues = [{ id: 'a', words: [
      { text: 'sung', startSec: 1.1, endSec: 1.8 },
      { text: 'early', startSec: 2.5, endSec: 3 },
    ] }];
    expect(findSilentWords(cues, pcm, rate)).toEqual([{ cueId: 'a', wordIndex: 1 }]);
  });
});
