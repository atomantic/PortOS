import { describe, it, expect } from 'vitest';
import {
  findWordEchoes,
  findRepeatedOpeners,
  measureSentenceRhythm,
} from './repetition.js';

describe('findWordEchoes', () => {
  it('flags a distinctive word repeated within the window', () => {
    const hits = findWordEchoes('The obsidian blade gleamed. She raised the obsidian high.');
    expect(hits.map((h) => h.word.toLowerCase())).toContain('obsidian');
  });

  it('ignores common stopwords and short words', () => {
    const hits = findWordEchoes('The cat sat on the mat and the dog ran.');
    expect(hits).toEqual([]); // "the" is a stopword, "cat"/"mat" too short / distinct
  });

  it('does not flag a repeat beyond the window', () => {
    const filler = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ');
    const text = `obsidian ${filler} obsidian`;
    expect(findWordEchoes(text, { windowWords: 50 })).toEqual([]);
  });

  it('dedups: a word echoed many times reports once', () => {
    const hits = findWordEchoes('crimson crimson crimson crimson');
    expect(hits.filter((h) => h.word.toLowerCase() === 'crimson').length).toBe(1);
  });
});

describe('findRepeatedOpeners', () => {
  it('flags a run of sentences opening with the same word', () => {
    const hits = findRepeatedOpeners('He ran. He jumped. He fell.');
    expect(hits.length).toBe(1);
    expect(hits[0].word.toLowerCase()).toBe('he');
    expect(hits[0].count).toBe(3);
  });

  it('does not flag a run shorter than minRun', () => {
    expect(findRepeatedOpeners('He ran. She jumped. He fell.', { minRun: 3 })).toEqual([]);
  });

  it('honors a lower minRun', () => {
    const hits = findRepeatedOpeners('She ran. She fell.', { minRun: 2 });
    expect(hits.length).toBe(1);
    expect(hits[0].count).toBe(2);
  });
});

describe('measureSentenceRhythm', () => {
  it('reports low variation for uniform sentence lengths', () => {
    // Every sentence is five words → variation should be ~0.
    const sentence = 'one two three four five.';
    const r = measureSentenceRhythm(Array(10).fill(sentence).join(' '), { minSentences: 5 });
    expect(r).not.toBeNull();
    expect(r.count).toBe(10);
    expect(r.cv).toBeLessThan(0.05);
  });

  it('reports higher variation for mixed lengths', () => {
    const text = 'Go. The quick brown fox jumped over the lazy sleeping dog near the river. Stop. '
      + 'A much longer sentence with many more words than the others around it here now. Yes.';
    const r = measureSentenceRhythm(text, { minSentences: 3 });
    expect(r).not.toBeNull();
    expect(r.cv).toBeGreaterThan(0.3);
  });

  it('returns null below the sentence floor', () => {
    expect(measureSentenceRhythm('One. Two.', { minSentences: 5 })).toBeNull();
  });
});
