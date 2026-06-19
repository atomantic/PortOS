import { describe, it, expect } from 'vitest';
import { findItalicThoughts } from './italicThoughts.js';

describe('findItalicThoughts', () => {
  it('flags a multi-word asterisk-italic thought run', () => {
    const hits = findItalicThoughts('She froze. *He knows I lied to him.* Then she ran.');
    expect(hits).toHaveLength(1);
    expect(hits[0].inner).toBe('He knows I lied to him.');
    expect(hits[0].anchor).toBe('*He knows I lied to him.*');
    expect(hits[0].words).toBe(6);
  });

  it('flags a multi-word underscore-italic thought run', () => {
    const hits = findItalicThoughts('_This cannot be happening again._');
    expect(hits).toHaveLength(1);
    expect(hits[0].inner).toBe('This cannot be happening again.');
  });

  it('ignores short italic spans (emphasis, not a thought)', () => {
    // "*never*" and "_run_" are single-word emphasis — below the default minWords.
    expect(findItalicThoughts('She would *never* do that. He told her to _run_.')).toEqual([]);
  });

  it('does not mistake bold (** / ***) for italic thoughts', () => {
    expect(findItalicThoughts('**This is bold and not a thought.**')).toEqual([]);
    expect(findItalicThoughts('***This is bold italic emphasis here.***')).toEqual([]);
  });

  it('does not treat snake_case or __bold__ underscores as emphasis', () => {
    expect(findItalicThoughts('The file my_long_variable_name was edited.')).toEqual([]);
    expect(findItalicThoughts('__This is underscore bold not a thought.__')).toEqual([]);
  });

  it('does not span across newlines (a paragraph is not an inline thought)', () => {
    expect(findItalicThoughts('*one line\nsecond line and more words here*')).toEqual([]);
  });

  it('dedups the same thought italicized more than once (first-wins, by position)', () => {
    const hits = findItalicThoughts('*I have to get out.* ... later ... *I have to get out.*');
    expect(hits).toHaveLength(1);
    expect(hits[0].index).toBe(0);
  });

  it('honors a custom minWords threshold', () => {
    const text = 'He paused. *What now?* he wondered.';
    expect(findItalicThoughts(text)).toEqual([]); // "What now?" = 2 words < default 4
    const hits = findItalicThoughts(text, { minWords: 2 });
    expect(hits).toHaveLength(1);
    expect(hits[0].inner).toBe('What now?');
  });

  it('keeps the earliest occurrence when the same thought appears under both delimiters', () => {
    // The underscore span comes first in the text; dedup must keep it over the
    // later asterisk span with identical text (FIRST-in-text wins, not first-scanned).
    const hits = findItalicThoughts('first _the same words here_ then *the same words here* end');
    expect(hits).toHaveLength(1);
    expect(hits[0].index).toBe(6);
    expect(hits[0].anchor).toBe('_the same words here_');
  });

  it('returns runs sorted by position across both delimiters', () => {
    const hits = findItalicThoughts('_The first thought arrives._ Then *the second thought lands hard.*');
    expect(hits.map((h) => h.inner)).toEqual([
      'The first thought arrives.',
      'the second thought lands hard.',
    ]);
  });

  it('returns [] for non-string or empty input', () => {
    expect(findItalicThoughts(null)).toEqual([]);
    expect(findItalicThoughts('')).toEqual([]);
    expect(findItalicThoughts('Plain prose with no italics at all.')).toEqual([]);
  });
});
