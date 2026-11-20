import { describe, it, expect } from 'vitest';
import { collectServerSources, readServerSource } from '../../guardSources.js';

// `tokenizeWords` is the one spelling of the editorial "prose word" — a run of
// letters with inner apostrophes, so numerals, dashes and markdown tokens never
// pad a per-1000-word denominator. It had been re-spelled as a bare regex in
// repetition.js (twice), slopScore.js and checkInfra/proseDensity.js — the last
// exported as `countWords`, the name lib/textUtils.js gives the WHITESPACE
// count, so a check could import the wrong denominator by name alone. Match
// the character class so the guard catches copies under any name.
const PROSE_WORD_CLASS = /\[A-Za-z\]\[A-Za-z'\]\*/;

describe('no private prose-word tokenizer', () => {
  it('leaves lib/editorial/proseTics.js as the only letter-word tokenizer under server/', () => {
    const offenders = collectServerSources()
      .filter((rel) => rel !== 'lib/editorial/proseTics.js')
      .filter((rel) => PROSE_WORD_CLASS.test(readServerSource(rel)));
    expect(
      offenders,
      `these re-spell the prose-word tokenizer — use tokenizeWords from lib/editorial/proseTics.js instead: ${offenders.join(', ')}`
    ).toEqual([]);
  });

  it('detects the tokenizer where it lives, so an empty offender list means nobody spells it', () => {
    expect(PROSE_WORD_CLASS.test(readServerSource('lib/editorial/proseTics.js'))).toBe(true);
    expect(collectServerSources().length).toBeGreaterThan(100);
  });
});
