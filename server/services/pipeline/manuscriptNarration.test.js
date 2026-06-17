import { describe, it, expect, vi, beforeEach } from 'vitest';

const synthesizeToFileMock = vi.fn();
vi.mock('./audio.js', () => ({
  synthesizeToFile: (...a) => synthesizeToFileMock(...a),
}));

const {
  splitProseIntoSentences,
  analyzeSentenceReadability,
  narrateProse,
  MAX_NARRATION_SEGMENTS,
  MAX_SEGMENT_CHARS,
} = await import('./manuscriptNarration.js');

describe('splitProseIntoSentences', () => {
  it('returns [] for empty / non-string input', () => {
    expect(splitProseIntoSentences('')).toEqual([]);
    expect(splitProseIntoSentences('   ')).toEqual([]);
    expect(splitProseIntoSentences(null)).toEqual([]);
    expect(splitProseIntoSentences(42)).toEqual([]);
  });

  it('splits on terminal punctuation and preserves char offsets', () => {
    const text = 'The fog rolled in. She waited. Did he come?';
    const segs = splitProseIntoSentences(text);
    expect(segs.map((s) => s.text)).toEqual([
      'The fog rolled in.',
      'She waited.',
      'Did he come?',
    ]);
    // Offsets reconstruct the original slice verbatim.
    segs.forEach((s) => expect(text.slice(s.start, s.end)).toBe(s.text));
  });

  it('does not split on common abbreviations', () => {
    const segs = splitProseIntoSentences('Dr. Vane met Mr. Poe today. They talked.');
    expect(segs).toHaveLength(2);
    expect(segs[0].text).toBe('Dr. Vane met Mr. Poe today.');
    expect(segs[1].text).toBe('They talked.');
  });

  it('does not split a decimal number mid-token', () => {
    expect(splitProseIntoSentences('Pi is 3.14 today.').map((s) => s.text))
      .toEqual(['Pi is 3.14 today.']);
  });

  it('does not split a dotted acronym followed by another word', () => {
    expect(splitProseIntoSentences('He joined the U.S. Navy last year. It changed him.').map((s) => s.text))
      .toEqual(['He joined the U.S. Navy last year.', 'It changed him.']);
    expect(splitProseIntoSentences('She wrote to J. R. R. Tolkien once.').map((s) => s.text))
      .toEqual(['She wrote to J. R. R. Tolkien once.']);
  });

  it('keeps trailing quotes/brackets with the sentence', () => {
    const segs = splitProseIntoSentences('"Run!" she cried. He froze.');
    expect(segs[0].text).toBe('"Run!" she cried.');
    expect(segs[1].text).toBe('He froze.');
  });

  it('treats a blank line as a sentence boundary even without punctuation', () => {
    const segs = splitProseIntoSentences('A fragment\n\nAnother fragment');
    expect(segs.map((s) => s.text)).toEqual(['A fragment', 'Another fragment']);
  });

  it('treats an indented blank line (whitespace between newlines) as a boundary', () => {
    const segs = splitProseIntoSentences('A fragment\n   \nAnother fragment');
    expect(segs.map((s) => s.text)).toEqual(['A fragment', 'Another fragment']);
  });

  it('treats a lowercase continuation after a terminator as the same sentence', () => {
    // Ellipsis/interrobang followed by a lowercase word reads as one breath
    // aloud; the capitalized "No." starts a new sentence.
    const segs = splitProseIntoSentences('Wait... what?! No.');
    expect(segs.map((s) => s.text)).toEqual(['Wait... what?!', 'No.']);
  });

  it('captures a trailing sentence with no terminal punctuation', () => {
    const segs = splitProseIntoSentences('Done. And then');
    expect(segs.map((s) => s.text)).toEqual(['Done.', 'And then']);
  });
});

describe('analyzeSentenceReadability', () => {
  it('flags nothing for a clean short sentence', () => {
    const r = analyzeSentenceReadability('The cat sat on the mat.');
    expect(r.hard).toBe(false);
    expect(r.reasons).toEqual([]);
  });

  it('flags an over-long sentence', () => {
    const long = `${Array.from({ length: 45 }, (_, i) => `word${i}`).join(' ')}.`;
    const r = analyzeSentenceReadability(long);
    expect(r.hard).toBe(true);
    expect(r.reasons.some((x) => x.startsWith('long sentence'))).toBe(true);
  });

  it('flags hard consonant clusters', () => {
    const r = analyzeSentenceReadability('He grasped the twelfths quickly.');
    expect(r.reasons).toContain('hard consonant cluster');
  });

  it('flags alliteration runs', () => {
    const r = analyzeSentenceReadability('Sally sells seashells today.');
    expect(r.reasons).toContain('alliteration run');
  });

  it('flags a content word repeated in close proximity', () => {
    const r = analyzeSentenceReadability('The shadow crossed the shadow again.');
    expect(r.reasons.some((x) => x.includes('repeated word'))).toBe(true);
  });

  it('ignores repeated stop-words', () => {
    const r = analyzeSentenceReadability('The dog and the fox ran.');
    expect(r.reasons.some((x) => x.includes('repeated word'))).toBe(false);
  });

  it('returns hard:false for empty input', () => {
    expect(analyzeSentenceReadability('')).toEqual({ hard: false, reasons: [] });
  });
});

describe('narrateProse', () => {
  beforeEach(() => {
    synthesizeToFileMock.mockReset();
    let n = 0;
    synthesizeToFileMock.mockImplementation(async ({ voiceId }) => {
      n += 1;
      return { filename: `seg-${n}.wav`, durationMs: 1000 + n, engine: 'kokoro', voiceId: voiceId || 'kokoro:af_heart' };
    });
  });

  it('rejects empty text', async () => {
    await expect(narrateProse({ text: '   ' })).rejects.toMatchObject({ status: 400 });
  });

  it('synthesizes each sentence and returns per-segment audio + duration + readability', async () => {
    const result = await narrateProse({ text: 'First line. Second line.', voiceId: 'kokoro:af_heart' });
    expect(synthesizeToFileMock).toHaveBeenCalledTimes(2);
    expect(result.segments).toHaveLength(2);
    expect(result.segments[0]).toMatchObject({
      index: 0, text: 'First line.', filename: 'seg-1.wav', durationMs: 1001,
    });
    expect(result.segments[0].readability).toEqual({ hard: false, reasons: [] });
    expect(result.engine).toBe('kokoro');
    expect(result.voiceId).toBe('kokoro:af_heart');
  });

  it('passes the requested voiceId through to synthesis', async () => {
    await narrateProse({ text: 'Hello there.', voiceId: 'piper:lessac' });
    expect(synthesizeToFileMock).toHaveBeenCalledWith(expect.objectContaining({ voiceId: 'piper:lessac' }));
  });

  it('sub-splits an over-long single sentence so no segment exceeds the TTS cap', async () => {
    // One "sentence" of ~9000 chars with no terminal punctuation.
    const word = 'word ';
    const huge = word.repeat(Math.ceil(9000 / word.length)).trim();
    const result = await narrateProse({ text: huge });
    expect(result.segments.length).toBeGreaterThan(1);
    result.segments.forEach((seg) => {
      expect(seg.text.length).toBeLessThanOrEqual(MAX_SEGMENT_CHARS);
      // Offsets still index the original text verbatim.
      expect(huge.slice(seg.start, seg.end)).toBe(seg.text);
    });
    // Every synthesized chunk was within the engine cap.
    synthesizeToFileMock.mock.calls.forEach(([{ text }]) => {
      expect(text.length).toBeLessThanOrEqual(MAX_SEGMENT_CHARS);
    });
  });

  it('rejects prose with more than MAX_NARRATION_SEGMENTS sentences', async () => {
    const huge = Array.from({ length: MAX_NARRATION_SEGMENTS + 5 }, (_, i) => `Sentence ${i}.`).join(' ');
    await expect(narrateProse({ text: huge })).rejects.toMatchObject({ status: 413 });
    expect(synthesizeToFileMock).not.toHaveBeenCalled();
  });
});
