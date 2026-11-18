import { describe, it, expect } from 'vitest';
import { clampToCharLimit, countWords, escapeRegExp, isNonBlankStr, isStr, trimTo, trimToClause } from './textUtils.js';

describe('countWords', () => {
  it('counts whitespace-separated tokens', () => {
    expect(countWords('one two three')).toBe(3);
    expect(countWords('one')).toBe(1);
  });

  it('collapses runs of mixed whitespace', () => {
    expect(countWords('  hello   world  ')).toBe(2);
    expect(countWords('one two\nthree\tfour')).toBe(4);
  });

  it('treats hyphenates and contractions as single words', () => {
    expect(countWords("don't stop now")).toBe(3);
    expect(countWords('hyphen-ated counts once')).toBe(3);
  });

  it('returns 0 for empty, whitespace-only, and non-string input', () => {
    expect(countWords('')).toBe(0);
    expect(countWords('   ')).toBe(0);
    expect(countWords(null)).toBe(0);
    expect(countWords(undefined)).toBe(0);
    expect(countWords(42)).toBe(0);
    expect(countWords({})).toBe(0);
  });
});

describe('trimTo', () => {
  it('trims and caps strings without coercing other values', () => {
    expect(trimTo('  bounded text  ', 7)).toBe('bounded');
    expect(trimTo(' short ', 20)).toBe('short');
    expect(trimTo(null, 20)).toBe('');
    expect(trimTo(42, 20)).toBe('');
  });
});

describe('isStr / isNonBlankStr', () => {
  it('isStr is the bare type check — an empty string is a string', () => {
    expect(isStr('')).toBe(true);
    expect(isStr('   ')).toBe(true);
    expect(isStr(new String('boxed'))).toBe(false);
    expect(isStr(null)).toBe(false);
    expect(isStr(42)).toBe(false);
  });

  it('isNonBlankStr rejects blank and non-string values without trimming what it accepts', () => {
    expect(isNonBlankStr('x')).toBe(true);
    expect(isNonBlankStr('  padded  ')).toBe(true);
    expect(isNonBlankStr('')).toBe(false);
    expect(isNonBlankStr('   ')).toBe(false);
    expect(isNonBlankStr('\n\t')).toBe(false);
    expect(isNonBlankStr(null)).toBe(false);
    expect(isNonBlankStr(0)).toBe(false);
  });
});

describe('clampToCharLimit', () => {
  it('passes text through when there is no cap or it already fits', () => {
    expect(clampToCharLimit('a neon alley', 800)).toEqual({ text: 'a neon alley', truncated: false });
    expect(clampToCharLimit('a neon alley', 0)).toEqual({ text: 'a neon alley', truncated: false });
    expect(clampToCharLimit(null, 10)).toEqual({ text: '', truncated: false });
  });

  it('cuts on the last sentence end when one sits deep in the allowance', () => {
    const { text, truncated } = clampToCharLimit('Wide shot of a rain-slick alley. Then the camera pushes in hard.', 45);
    expect(truncated).toBe(true);
    expect(text).toBe('Wide shot of a rain-slick alley.');
  });

  it('falls back to a word boundary rather than cutting mid-word', () => {
    // No sentence end deep enough in the allowance — a mid-word cut would
    // change what the tail asks the renderer for.
    expect(clampToCharLimit('alpha bravo charlie delta', 14)).toEqual({ text: 'alpha bravo', truncated: true });
  });

  it('does not cut mid-abbreviation — the bare lastIndexOf(".") cap ended on "Dr."', () => {
    // Regression for #6455: the old cap took the last "." in the window whenever it
    // sat past 60% of the budget, so an abbreviation deep in the string became the
    // cut point and the value ended on a hanging "Dr." — which a renderer reads as
    // a truncated name. trimToClause's COMMON_ABBREVIATION_RE guard rejects that
    // terminator and falls through to the whole-word boundary instead.
    expect(clampToCharLimit('We met the visiting consultant Dr. Vey at the clinic yesterday', 40))
      .toEqual({ text: 'We met the visiting consultant Dr. Vey', truncated: true });
  });

  it('does not cut mid-decimal', () => {
    // Same defect, decimal flavour: the old cap cut at the "." inside "3.5", handing
    // the renderer "…holds at 3." — a different number, not a shorter sentence.
    expect(clampToCharLimit('The reactor holds at 3.5 megawatts under load and the crew waits', 30))
      .toEqual({ text: 'The reactor holds at 3.5', truncated: true });
  });
});

describe('escapeRegExp', () => {
  it('escapes every RegExp metacharacter and nothing else', () => {
    expect(escapeRegExp('a.c')).toBe('a\\.c');
    expect(escapeRegExp('C++ (faction) [v1.0]')).toBe('C\\+\\+ \\(faction\\) \\[v1\\.0\\]');
    expect(escapeRegExp('a|b {x} ^$ *? \\')).toBe('a\\|b \\{x\\} \\^\\$ \\*\\? \\\\');
    expect(escapeRegExp('plain words 42')).toBe('plain words 42');
  });

  it('makes a metacharacter-laden token match only itself', () => {
    const token = 'C++ (faction) [v1.0]';
    expect(new RegExp(`^${escapeRegExp(token)}$`).test(token)).toBe(true);
    expect(new RegExp(`^${escapeRegExp('a.c')}$`).test('abc')).toBe(false);
  });

  // Seven of the migrated copies were `s.replace(...)`, which threw a TypeError on
  // a non-string; the shared helper coerces. Every migrated call site already
  // filters to strings upstream, so the change is unreachable today — but it is
  // the one semantic the migration altered, so it is pinned here rather than left
  // to be "fixed" back into a throw by someone reading only this module. Coercion
  // is deliberate: these callers splice user-supplied tokens (LoRA triggers,
  // character aliases, catalog labels) into `new RegExp(...)`, where a throw
  // surfaces as an opaque 500. The trade is that a stray non-string becomes a
  // literal 'null'/'42' pattern rather than an error, which is why callers must
  // keep filtering rather than lean on the coercion.
  it('coerces non-string input instead of throwing', () => {
    expect(escapeRegExp(null)).toBe('null');
    expect(escapeRegExp(undefined)).toBe('undefined');
    expect(escapeRegExp(42)).toBe('42');
    expect(escapeRegExp(1.5)).toBe('1\\.5');
  });
});

describe('trimToClause (boundary-aware prose cap)', () => {
  it('returns text untouched when it fits', () => {
    expect(trimToClause('A short logline.', 500)).toBe('A short logline.');
    expect(trimToClause('  trimmed  ', 500)).toBe('trimmed');
  });

  it('is empty for non-strings (matches trimTo)', () => {
    expect(trimToClause(null, 50)).toBe('');
    expect(trimToClause(undefined, 50)).toBe('');
    expect(trimToClause(42, 50)).toBe('');
  });

  it('clips at a sentence boundary when it preserves a meaningful share of the budget', () => {
    const text = 'First full sentence about the arc here. And then a second clause runs on well past the budget.';
    const out = trimToClause(text, 50);
    expect(out).toBe('First full sentence about the arc here.');
    expect(out.length).toBeLessThanOrEqual(50);
  });

  it('prefers the only complete sentence at 53% over a near-cap fragment', () => {
    const complete = `${'word '.repeat(52)}done.`; // 265 chars
    const tail = ` ${'continuation '.repeat(30)}`;
    const out = trimToClause(complete + tail, 500);
    expect(out).toBe(complete);
    expect(out.endsWith('.')).toBe(true);
  });

  it('does not treat abbreviations or decimals as sentence endings', () => {
    const text = `Dr. Example measured 3.5 units before the actual stop. ${'tail '.repeat(20)}`;
    const out = trimToClause(text, 70);
    expect(out).toBe('Dr. Example measured 3.5 units before the actual stop.');
  });

  it('keeps closing quotes and brackets attached to the sentence', () => {
    const text = `The operator said, "Stop now." ${'tail '.repeat(20)}`;
    expect(trimToClause(text, 50)).toBe('The operator said, "Stop now."');
  });

  it('backs off to a clause boundary when the field holds no sentence break', () => {
    // The shape a saturated 200-char transition label takes: one clause-chained
    // sentence, no terminator anywhere in budget. Cutting on the last whole word
    // leaves "...with no repayment lien, no" — a dangling half-clause the next
    // verification round reports as an incomplete record.
    const label = 'Proves with the validated block that the takeover cannot reach quorum, then closes the short and escrows the proceeds with no repayment lien, no personal withdrawal key, and no veto';
    const out = trimToClause(label, 160);
    expect(out).toBe('Proves with the validated block that the takeover cannot reach quorum, then closes the short and escrows the proceeds with no repayment lien');
    expect(out.length).toBeLessThanOrEqual(160);
    expect(/[,;:—–]$/.test(out)).toBe(false);
  });

  it('prefers a usable sentence break over a later clause break', () => {
    const text = 'The vote carries after a long night of argument. The crews ratify, the boosters transfer, and the manifest is certified.';
    expect(trimToClause(text, 70)).toBe('The vote carries after a long night of argument.');
  });

  it('ignores a clause break so early that honoring it would gut the field', () => {
    // Comma at ~8% of the budget: keeping only "Yes" is worse than the ragged
    // whole-word edge, so the word fallback still wins.
    const text = `Yes, ${'word '.repeat(40)}`;
    const out = trimToClause(text, 60);
    expect(out.startsWith('Yes, word')).toBe(true);
    expect(out.length).toBeGreaterThan(50);
  });

  it('never clips mid-word — falls back to a whole-word boundary on a run-on', () => {
    // No sentence terminator within budget → must still end on a complete word,
    // not "...tracing the brand an".
    const runon = 'JUNO risks her anonymity to be recognized as author while Caroline Marsh starts tracing the brand and the buzz';
    const out = trimToClause(runon, 60);
    expect(out.length).toBeLessThanOrEqual(60);
    expect(out.endsWith(' ')).toBe(false);
    // The last token is a whole word from the source (no partial word).
    const lastWord = out.split(' ').pop();
    expect(runon.split(' ')).toContain(lastWord);
  });

  it('never returns more than max characters', () => {
    const long = 'word '.repeat(400); // 2000 chars, no sentence breaks
    expect(trimToClause(long, 100).length).toBeLessThanOrEqual(100);
  });
});
