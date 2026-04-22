import { describe, it, expect } from 'vitest';
import { splitSentences, isNonSpeechMarker, detectNarrationWithoutCall } from './pipeline.js';

describe('splitSentences', () => {
  it('returns empty when no terminator is present', () => {
    const { sentences, remainder } = splitSentences('hello world no terminator');
    expect(sentences).toEqual([]);
    expect(remainder).toBe('hello world no terminator');
  });

  it('splits on period + whitespace, preserving terminator', () => {
    // Terminator followed by end-of-string also matches, so the trailing
    // "Second sentence." gets flushed too.
    const { sentences, remainder } = splitSentences('First sentence. Second sentence.');
    expect(sentences).toEqual(['First sentence.', 'Second sentence.']);
    expect(remainder).toBe('');
  });

  it('drains multiple complete sentences in a single call', () => {
    const { sentences, remainder } = splitSentences('One. Two. Three. ');
    expect(sentences).toEqual(['One.', 'Two.', 'Three.']);
    expect(remainder).toBe('');
  });

  it('handles ! and ? as sentence terminators', () => {
    const { sentences, remainder } = splitSentences('Wait! Really? Yes.');
    expect(sentences).toEqual(['Wait!', 'Really?', 'Yes.']);
    expect(remainder).toBe('');
  });

  it('splits on newline followed by whitespace', () => {
    // Regex needs more whitespace after the terminator (or EOS); bare `\n`
    // followed by a non-space char does NOT split — keeps paragraphs intact
    // until the LLM writes a real paragraph break.
    const kept = splitSentences('line one\nline two');
    expect(kept.sentences).toEqual([]);
    expect(kept.remainder).toBe('line one\nline two');

    const split = splitSentences('line one\n line two');
    expect(split.sentences).toEqual(['line one']);
    expect(split.remainder).toBe('line two');
  });

  it('keeps incomplete trailing text as remainder', () => {
    const { sentences, remainder } = splitSentences('Done. Still typin');
    expect(sentences).toEqual(['Done.']);
    expect(remainder).toBe('Still typin');
  });

  it('is idempotent when called with the remainder repeatedly', () => {
    // Simulate streaming deltas: first chunk has no terminator, second adds it.
    const first = splitSentences('partial');
    expect(first.sentences).toEqual([]);
    const second = splitSentences(first.remainder + ' sentence.');
    expect(second.sentences).toEqual(['partial sentence.']);
    expect(second.remainder).toBe('');
  });
});

describe('isNonSpeechMarker', () => {
  it('detects whisper non-speech markers', () => {
    expect(isNonSpeechMarker('[BLANK_AUDIO]')).toBe(true);
    expect(isNonSpeechMarker('[MUSIC]')).toBe(true);
    expect(isNonSpeechMarker('[LAUGHTER]')).toBe(true);
    expect(isNonSpeechMarker('[INAUDIBLE]')).toBe(true);
    expect(isNonSpeechMarker('  [BLANK_AUDIO]  ')).toBe(true);
  });

  it('does not match real speech', () => {
    expect(isNonSpeechMarker('hello world')).toBe(false);
    expect(isNonSpeechMarker('[BLANK] plus words')).toBe(false);
    expect(isNonSpeechMarker('')).toBe(false);
    expect(isNonSpeechMarker('note: [TODO]')).toBe(false);
  });
});

describe('detectNarrationWithoutCall', () => {
  it('flags first-person past-tense action claims with no tool calls', () => {
    expect(detectNarrationWithoutCall({
      finalText: "I've opened your daily log.",
      toolRuns: [],
    })).toBe(true);
    expect(detectNarrationWithoutCall({
      finalText: 'I added that to your inbox.',
      toolRuns: [],
    })).toBe(true);
    expect(detectNarrationWithoutCall({
      finalText: 'I just saved it for you.',
      toolRuns: [],
    })).toBe(true);
  });

  it('flags progressive-tense action claims with no tool calls', () => {
    expect(detectNarrationWithoutCall({
      finalText: 'Navigating to your tasks page now.',
      toolRuns: [],
    })).toBe(true);
    expect(detectNarrationWithoutCall({
      finalText: 'Opening the daily log.',
      toolRuns: [],
    })).toBe(true);
  });

  it('does not flag when a tool ran — claim is backed by action', () => {
    expect(detectNarrationWithoutCall({
      finalText: "I've opened your daily log.",
      toolRuns: [{ name: 'daily_log_open', ok: true, ms: 10 }],
    })).toBe(false);
  });

  it('does not flag empty / whitespace-only replies (covered by the empty-output check)', () => {
    expect(detectNarrationWithoutCall({ finalText: '', toolRuns: [] })).toBe(false);
    expect(detectNarrationWithoutCall({ finalText: '   ', toolRuns: [] })).toBe(false);
  });

  it('does not flag conversational replies that mention the same verbs', () => {
    expect(detectNarrationWithoutCall({
      finalText: 'Your daily log is a good habit to keep.',
      toolRuns: [],
    })).toBe(false);
    expect(detectNarrationWithoutCall({
      finalText: 'You saved that note yesterday, I think.',
      toolRuns: [],
    })).toBe(false);
    expect(detectNarrationWithoutCall({
      finalText: "It's 3:14 PM on Monday.",
      toolRuns: [],
    })).toBe(false);
  });

  it('tolerates missing inputs without throwing', () => {
    expect(detectNarrationWithoutCall({ finalText: undefined, toolRuns: undefined })).toBe(false);
    expect(detectNarrationWithoutCall({})).toBe(false);
  });
});
