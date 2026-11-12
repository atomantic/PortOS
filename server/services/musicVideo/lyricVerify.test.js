import { describe, expect, it, vi } from 'vitest';
import { compareLyricPlacement, encodePcm16Wav } from './lyricAlignCore.js';
import { verifyLyricSheet, verifyPrerequisites } from './lyricVerify.js';

function vocal() {
  const wav = encodePcm16Wav(16000 * 9);
  for (const [start, end] of [[1, 2], [3, 4], [5, 6], [7, 7.3]]) {
    for (let i = start * 16000; i < end * 16000; i++) wav.writeInt16LE(8000, 44 + i * 2);
  }
  return wav;
}
const project = { vocalStemMasterFilename: 'song.wav', lyricCues: [
  { id: 'a', text: 'first', words: [{ w: 'first', startSec: 1, endSec: 2 }] },
  { id: 'b', text: 'second', words: [{ w: 'second', startSec: 3, endSec: 4 }] },
  { id: 'c', text: 'unsung', words: [{ w: 'unsung', startSec: 8, endSec: 8.5 }] },
] };

describe('lyric sheet verification', () => {
  it('requires a current stem and timed words before starting', async () => {
    const deps = { resolveStem: () => '/music/stem.wav', resolveMaster: async () => '/music/song.wav' };
    await expect(verifyPrerequisites({ ...project, vocalStemMasterFilename: 'old.wav', vocalStemFilename: 'stem.wav' }, deps)).rejects.toMatchObject({ code: 'LYRIC_VERIFY_NEEDS_STEM' });
    await expect(verifyPrerequisites({ ...project, vocalStemFilename: 'stem.wav', lyricCues: [] }, deps)).rejects.toMatchObject({ code: 'LYRIC_VERIFY_NEEDS_TIMING' });
    await expect(verifyPrerequisites({ ...project, vocalStemFilename: 'stem.wav' }, deps)).resolves.toBe('/music/stem.wav');
  });
  it('transcribes uncovered vocal phrases without sheet bias and finds silent lines', async () => {
    const transcribe = vi.fn(async () => [{ text: 'extra', startSec: 5, endSec: 6 }]);
    const release = vi.fn();
    const result = await verifyLyricSheet(project, 'stem', { deps: { decode: async () => vocal(), resolveTranscriber: async () => ({ transcribe, release }) } });
    expect(result.extraPhrases).toHaveLength(1);
    expect(result.extraPhrases[0]).toMatchObject({ text: 'extra' });
    expect(result.extraPhrases[0].startSec).toBeCloseTo(5, 1);
    expect(result.unsungCues).toEqual([{ cueId: 'c', text: 'unsung' }]);
    expect(transcribe).toHaveBeenCalledTimes(3);
    expect(transcribe.mock.calls[2][1]).toMatchObject({ prompt: '', startSec: expect.closeTo(4.8, 1), endSec: expect.closeTo(6.2, 1) });
    expect(release).toHaveBeenCalledOnce();
  });
  it('releases the transcriber after cancellation during transcription', async () => {
    let canceled = false;
    const release = vi.fn();
    await expect(verifyLyricSheet(project, 'stem', { isCancelled: () => canceled, deps: { decode: async () => vocal(), resolveTranscriber: async () => ({ transcribe: async () => { canceled = true; return []; }, release }) } })).rejects.toMatchObject({ canceled: true });
    expect(release).toHaveBeenCalledOnce();
  });
  it('checks uncovered singing on both sides of a timed line within one vocal phrase', async () => {
    const wav = encodePcm16Wav(16000 * 5);
    for (let i = 16000; i < 16000 * 4; i++) wav.writeInt16LE(8000, 44 + i * 2);
    const transcribe = vi.fn(async () => [{ text: 'extra' }]);
    const result = await verifyLyricSheet({ ...project, lyricCues: [
      { id: 'timed', text: 'known', words: [{ w: 'known', startSec: 2, endSec: 3 }] },
    ] }, 'stem', { deps: { decode: async () => wav, resolveTranscriber: async () => ({ transcribe }) } });
    expect(result.extraPhrases).toHaveLength(2);
    expect(result.extraPhrases[0]).toMatchObject({ startSec: expect.closeTo(1, 1), endSec: 2 });
    expect(result.extraPhrases[1]).toMatchObject({ startSec: 3, endSec: expect.closeTo(4, 1) });
    expect(transcribe).toHaveBeenCalledTimes(3);
  });
});


it('finds a shifted repeated chorus even on voiced audio, and passes accepted checked times', async () => {
  const wav = encodePcm16Wav(16000 * 8);
  for (let i = 16000; i < 16000 * 6; i++) wav.writeInt16LE(8000, 44 + i * 2);
  const line = (id, start) => ({ id, text: 'bright morning river', words: ['bright', 'morning', 'river'].map((w, i) => ({ w, startSec: start + i * 0.5, endSec: start + i * 0.5 + 0.2, conf: 'matched' })) });
  const correct = line('first', 1), shifted = line('repeat', 4);
  correct.words.at(-1).endSec = 4.6;
  shifted.words.at(-1).endSec = 6;
  const actual = line('repeat', 4.6);
  actual.words.at(-1).endSec = 6;
  const heard = [...correct.words, ...actual.words].map(word => ({ ...word, text: word.w }));
  const transcribe = vi.fn(async (_wav, { prompt }) => prompt ? heard : []);
  const deps = { decode: async () => wav, resolveTranscriber: async () => ({ transcribe }) };
  const checked = await verifyLyricSheet({ ...project, lyricCues: [correct, shifted] }, 'stem', { deps });
  expect(checked.passed).toBe(false);
  expect(checked.uncheckedCues).toEqual([]);
  expect(checked.misplacedCues).toHaveLength(1);
  expect(checked.misplacedCues[0]).toMatchObject({ cueId: 'repeat', offsetSec: 0.6 });
  const words = checked.misplacedCues[0].words;
  expect(words[0].endSec).toBe(words[1].startSec);
  expect(words[1].endSec).toBe(words[2].startSec);
  const next = await verifyLyricSheet({ ...project, lyricCues: [correct, { ...shifted, words }] }, 'stem', { deps });
  expect(next.misplacedCues).toEqual([]);
  expect(next.uncheckedCues).toEqual([]);
  expect(next.passed).toBe(true);
});

it('never passes a line that recognition could not place', async () => {
  const result = await verifyLyricSheet(project, 'stem', { deps: { decode: async () => vocal(), resolveTranscriber: async () => ({ transcribe: async () => [] }) } });
  expect(result.passed).toBe(false);
  expect(result.misplacedCues).toEqual([]);
  expect(result.uncheckedCues.map(cue => cue.cueId)).toEqual(['a', 'b', 'c']);
});

it('checks collapsed window lines when heard on retry or by a neighbour', async () => {
  const wav = encodePcm16Wav(16000 * 10);
  for (const [start, end] of [[1, 4.1], [7, 8.5]]) {
    for (let i = start * 16000; i < end * 16000; i++) wav.writeInt16LE(8000, 44 + i * 2);
  }
  const cues = [
    { id: 'line1', text: 'first morning light', words: [
      { w: 'first', startSec: 1.0, endSec: 1.4 },
      { w: 'morning', startSec: 1.5, endSec: 1.9 },
      { w: 'light', startSec: 2.0, endSec: 2.4 },
    ] },
    { id: 'line2', text: 'second river bank', words: [
      { w: 'second', startSec: 2.6, endSec: 3.0 },
      { w: 'river', startSec: 3.1, endSec: 3.5 },
      { w: 'bank', startSec: 3.6, endSec: 4.0 },
    ] },
    { id: 'line3', text: 'ocean deep blue', words: [
      { w: 'ocean', startSec: 7.0, endSec: 7.4 },
      { w: 'deep', startSec: 7.5, endSec: 7.9 },
      { w: 'blue', startSec: 8.0, endSec: 8.4 },
    ] },
  ];
  // Window 0 has line1 and line2 (gap < 3s, span < 20s).
  // Window 1 has line3 (gap 4.0 - 7.0 = 3s).
  const transcribe = vi.fn(async (_wav, { prompt, startSec }) => {
    // Window 0 transcript collapses to 1 repeated word:
    if (prompt === 'first morning light\nsecond river bank') {
      return [{ text: 'la', startSec: 1.0, endSec: 1.5 }];
    }
    // Retry for line1 succeeds:
    if (prompt === 'first morning light') {
      return [
        { text: 'first', startSec: 1.02, endSec: 1.4 },
        { text: 'morning', startSec: 1.52, endSec: 1.9 },
        { text: 'light', startSec: 2.02, endSec: 2.4 },
      ];
    }
    // Retry for line2 collapses/misses:
    if (prompt === 'second river bank') return [];
    // Window 1 prompt hears line3 and also hears line2 in its start padding:
    if (prompt === 'ocean deep blue') {
      return [
        { text: 'second', startSec: 2.62, endSec: 3.0 },
        { text: 'river', startSec: 3.12, endSec: 3.5 },
        { text: 'bank', startSec: 3.62, endSec: 4.0 },
        { text: 'ocean', startSec: 7.01, endSec: 7.4 },
        { text: 'deep', startSec: 7.51, endSec: 7.9 },
        { text: 'blue', startSec: 8.01, endSec: 8.4 },
      ];
    }
    return [];
  });
  const deps = { decode: async () => wav, resolveTranscriber: async () => ({ transcribe }) };
  const result = await verifyLyricSheet({ ...project, lyricCues: cues }, 'stem', { deps });
  expect(result.uncheckedCues).toEqual([]);
  expect(result.misplacedCues).toEqual([]);
  expect(result.passed).toBe(true);
});

describe('lyric placement matching tolerances', () => {
  const line = { id: 'cue1', text: 'red apple tree', words: [
    { w: 'red', startSec: 1.0, endSec: 1.4 },
    { w: 'apple', startSec: 1.5, endSec: 1.9 },
    { w: 'tree', startSec: 2.0, endSec: 2.4 },
  ] };

  it('checks a line with one dropped word when matched word offsets agree within 0.15s', () => {
    // 'apple' is dropped; 'red' offset is 0.05, 'tree' offset is 0.08 (spread = 0.03 <= 0.15)
    const heard = [
      { text: 'red', startSec: 1.05, endSec: 1.4 },
      { text: 'tree', startSec: 2.08, endSec: 2.5 },
    ];
    const result = compareLyricPlacement([line], heard);
    expect(result.uncheckedCues).toEqual([]);
    expect(result.misplacedCues).toEqual([]);
    expect(result.checkedCues).toHaveLength(1);
    expect(result.checkedCues[0]).toMatchObject({ complete: false, offsetSec: 0.065 });
  });

  it('leaves a line unchecked when matched word offsets disagree by more than 0.15s', () => {
    // 'apple' is dropped; 'red' offset is 0.05, 'tree' offset is 0.30 (spread = 0.25 > 0.15)
    const heard = [
      { text: 'red', startSec: 1.05, endSec: 1.4 },
      { text: 'tree', startSec: 2.30, endSec: 2.7 },
    ];
    const result = compareLyricPlacement([line], heard);
    expect(result.uncheckedCues).toEqual([{ cueId: 'cue1', text: 'red apple tree' }]);
    expect(result.misplacedCues).toEqual([]);
    expect(result.checkedCues).toEqual([]);
  });

  it('requires all words for lines of one or two words', () => {
    const twoWordLine = { id: 'two', text: 'good morning', words: [
      { w: 'good', startSec: 1.0, endSec: 1.4 },
      { w: 'morning', startSec: 1.5, endSec: 1.9 },
    ] };
    const oneHeard = [{ text: 'good', startSec: 1.05, endSec: 1.4 }];
    const result = compareLyricPlacement([twoWordLine], oneHeard);
    expect(result.uncheckedCues).toEqual([{ cueId: 'two', text: 'good morning' }]);
  });

  it('ignores repeated words outside the time bound', () => {
    const heard = [
      { text: 'red', startSec: 10.0, endSec: 10.4 },
      { text: 'apple', startSec: 10.5, endSec: 10.9 },
      { text: 'tree', startSec: 11.0, endSec: 11.4 },
    ];
    const bound = { startSec: 0.5, endSec: 3.5 };
    const result = compareLyricPlacement([line], heard, { timeBound: bound });
    expect(result.uncheckedCues).toEqual([{ cueId: 'cue1', text: 'red apple tree' }]);
    expect(result.checkedCues).toEqual([]);
  });

  it('does not assign the same recognized word occurrence to multiple cues', () => {
    const repeat1 = { id: 'r1', text: 'red apple tree', words: line.words };
    const repeat2 = { id: 'r2', text: 'red apple tree', words: line.words };
    const heard = [
      { _id: 'w1', text: 'red', startSec: 1.0, endSec: 1.4 },
      { _id: 'w2', text: 'apple', startSec: 1.5, endSec: 1.9 },
      { _id: 'w3', text: 'tree', startSec: 2.0, endSec: 2.4 },
    ];
    const usedOccurrences = new Set();
    const result1 = compareLyricPlacement([repeat1], heard, { usedOccurrences });
    expect(result1.checkedCues).toHaveLength(1);
    for (const id of result1.checkedCues[0].matchedWordIds) usedOccurrences.add(id);
    const result2 = compareLyricPlacement([repeat2], heard, { usedOccurrences });
    expect(result2.uncheckedCues).toEqual([{ cueId: 'r2', text: 'red apple tree' }]);
  });

  it('does not let overlapping transcripts check multiple repeated lines for one sung occurrence', async () => {
    const wav = encodePcm16Wav(16000 * 8);
    for (const [start, end] of [[1, 2.5]]) {
      for (let i = start * 16000; i < end * 16000; i++) wav.writeInt16LE(8000, 44 + i * 2);
    }
    const cues = [
      { id: 'c1', text: 'red apple tree', words: line.words },
      { id: 'c2', text: 'red apple tree', words: line.words.map(w => ({ ...w, startSec: w.startSec + 0.1, endSec: w.endSec + 0.1 })) },
    ];
    // Both cues are in Window 0. Window 0 collapses.
    // Retry for c1 returns the words at 1.0-2.4s.
    // Retry for c2 also returns the same words at 1.0-2.4s.
    const transcribe = vi.fn(async (_wav, { prompt }) => {
      if (prompt.includes('\n')) return [{ text: 'la', startSec: 1.0, endSec: 1.2 }];
      return [
        { text: 'red', startSec: 1.0, endSec: 1.4 },
        { text: 'apple', startSec: 1.5, endSec: 1.9 },
        { text: 'tree', startSec: 2.0, endSec: 2.4 },
      ];
    });
    const deps = { decode: async () => wav, resolveTranscriber: async () => ({ transcribe }) };
    const result = await verifyLyricSheet({ ...project, lyricCues: cues }, 'stem', { deps });
    // c1 claims 1.0-2.4s, so c2 is prevented from claiming the same sung occurrence.
    expect(result.uncheckedCues).toEqual([{ cueId: 'c2', text: 'red apple tree' }]);
  });
});
