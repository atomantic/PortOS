import { describe, it, expect } from 'vitest';
import {
  fuzzyMatch,
  generateHint,
  findChunkForLine,
  checkFillBlank,
  checkSequenceAnswer,
  checkSpacedAnswer,
} from './MemoryPractice';

// Pure-function tests for MemoryPractice's correctness scorers (issue #2102
// gap #2). These decide whether a memorization drill answer counts as
// correct — a silent regression here would mis-grade every spaced-repetition
// / sequence-recall / fill-blank session without failing anywhere visible.

describe('fuzzyMatch', () => {
  const makeWords = (n) => Array.from({ length: n }, (_, i) => `word${i}`);

  it('returns true for an exact match after normalization', () => {
    expect(fuzzyMatch('Hello, World!', 'hello world')).toBe(true);
  });

  it('is case-insensitive and ignores punctuation/extra whitespace', () => {
    // Note: a hyphen is stripped (not replaced with a space), so hyphenated
    // words fuse into one token — this case avoids hyphens to isolate the
    // case/punctuation/whitespace normalization being tested.
    expect(fuzzyMatch("Don't,   Stop!  Believing.", 'dont stop believing')).toBe(true);
  });

  // The issue calls out the 80%-word-match threshold as a specific regression
  // risk — pin the boundary exactly, both just below and exactly at 0.8.
  it('matches exactly AT the 0.8 threshold (boundary is inclusive, >=)', () => {
    const expectedWords = makeWords(100);
    const expected = expectedWords.join(' ');
    // 80 of the 100 expected words present -> 80/100 = 0.8 exactly -> true.
    const input = expectedWords.slice(0, 80).join(' ');
    expect(fuzzyMatch(input, expected)).toBe(true);
  });

  it('fails just BELOW the 0.8 threshold', () => {
    const expectedWords = makeWords(100);
    const expected = expectedWords.join(' ');
    // 79 of the 100 expected words present -> 79/100 = 0.79 -> false.
    const input = expectedWords.slice(0, 79).join(' ');
    expect(fuzzyMatch(input, expected)).toBe(false);
  });

  it('matches just ABOVE the 0.8 threshold', () => {
    const expectedWords = makeWords(100);
    const expected = expectedWords.join(' ');
    // 81 of the 100 expected words present -> 81/100 = 0.81 -> true.
    const input = expectedWords.slice(0, 81).join(' ');
    expect(fuzzyMatch(input, expected)).toBe(true);
  });

  it('fails when word overlap is well below the threshold', () => {
    expect(fuzzyMatch('completely different text', 'the quick brown fox jumps')).toBe(false);
  });
});

describe('checkFillBlank', () => {
  it('marks correct when every comma-separated word matches its blank in order (case-insensitive)', () => {
    const result = checkFillBlank('Fire, water, earth', ['fire', 'water', 'earth']);
    expect(result).toEqual({ correct: true, expected: 'fire, water, earth', answered: 'Fire, water, earth' });
  });

  it('trims whitespace around each comma-separated answer', () => {
    const result = checkFillBlank('  fire ,  water  , earth ', ['fire', 'water', 'earth']);
    expect(result.correct).toBe(true);
  });

  it('marks incorrect when a word is wrong', () => {
    const result = checkFillBlank('fire, wind, earth', ['fire', 'water', 'earth']);
    expect(result.correct).toBe(false);
  });

  it('marks incorrect when fewer answers are given than blanks', () => {
    const result = checkFillBlank('fire, water', ['fire', 'water', 'earth']);
    expect(result.correct).toBe(false);
  });

  it('treats a skipped answer as incorrect with an empty `answered`', () => {
    const result = checkFillBlank('fire, water, earth', ['fire', 'water', 'earth'], true);
    expect(result).toEqual({ correct: false, expected: 'fire, water, earth', answered: '' });
  });
});

describe('checkSequenceAnswer', () => {
  it('marks correct when the typed line fuzzy-matches the expected next line', () => {
    const result = checkSequenceAnswer('the quick brown fox', 'the quick brown fox');
    expect(result).toEqual({ correct: true, expected: 'the quick brown fox', answered: 'the quick brown fox', element: null });
  });

  it('marks incorrect when the typed line does not match', () => {
    const result = checkSequenceAnswer('a totally different line', 'the quick brown fox');
    expect(result.correct).toBe(false);
  });

  it('treats a skipped answer as incorrect with an empty `answered`', () => {
    const result = checkSequenceAnswer('the quick brown fox', 'the quick brown fox', true);
    expect(result).toEqual({ correct: false, expected: 'the quick brown fox', answered: '', element: null });
  });
});

describe('checkSpacedAnswer', () => {
  it('marks correct when the typed line fuzzy-matches and tags the result with the chunk id', () => {
    const result = checkSpacedAnswer('the quick brown fox', 'the quick brown fox', 'chunk-1');
    expect(result).toEqual({ correct: true, expected: 'the quick brown fox', answered: 'the quick brown fox', chunkId: 'chunk-1' });
  });

  it('marks incorrect when the typed line does not match', () => {
    const result = checkSpacedAnswer('nothing like it', 'the quick brown fox', 'chunk-1');
    expect(result.correct).toBe(false);
    expect(result.chunkId).toBe('chunk-1');
  });

  it('treats a skipped answer as incorrect with an empty `answered`, still tagged with the chunk id', () => {
    const result = checkSpacedAnswer('the quick brown fox', 'the quick brown fox', 'chunk-2', true);
    expect(result).toEqual({ correct: false, expected: 'the quick brown fox', answered: '', chunkId: 'chunk-2' });
  });
});

describe('generateHint', () => {
  const text = 'the quick brown fox';

  it('hintLevel 0 shows first letter + underscores for each word, preserving trailing punctuation', () => {
    expect(generateHint('the quick, brown fox.', 0)).toBe('t__ q____, b____ f__.');
  });

  it('hintLevel 0 leaves single-character words untouched', () => {
    expect(generateHint('a b cat', 0)).toBe('a b c__');
  });

  it('hintLevel 1 shows first letter of every other word (0-indexed), blanks the rest', () => {
    expect(generateHint(text, 1)).toBe('t___ ____ b___ ____');
  });

  it('hintLevel 2 shows only the word count', () => {
    expect(generateHint(text, 2)).toBe('(4 words)');
  });

  it('hintLevel 3 (or above) shows no hint at all', () => {
    expect(generateHint(text, 3)).toBeNull();
    expect(generateHint(text, 4)).toBeNull();
  });
});

describe('findChunkForLine', () => {
  const item = {
    content: {
      chunks: [
        { id: 'chunk-a', lineRange: [0, 2] },
        { id: 'chunk-b', lineRange: [3, 5] },
      ],
    },
  };

  it('finds the chunk containing the start of a line range', () => {
    expect(findChunkForLine(item, 0)).toBe('chunk-a');
  });

  it('finds the chunk containing the end of a line range (inclusive boundary)', () => {
    expect(findChunkForLine(item, 2)).toBe('chunk-a');
  });

  it('finds the next chunk right after the previous one ends', () => {
    expect(findChunkForLine(item, 3)).toBe('chunk-b');
  });

  it('returns null when the line index is outside every chunk range', () => {
    expect(findChunkForLine(item, 99)).toBeNull();
  });

  it('returns null when there are no chunks', () => {
    expect(findChunkForLine({ content: {} }, 0)).toBeNull();
  });
});
