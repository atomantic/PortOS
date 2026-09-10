import { describe, it, expect } from 'vitest';
import { clampToCharLimit, countWords, escapeRegExp, isNonBlankStr, isStr, trimTo, trimToClause } from './textUtils.js';
import { collectClientSources, collectServerSources, readClientSource, readServerSource } from './testHelper.js';

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

// The extraction of `escapeRegExp` into this module landed once and then rotted:
// twenty-odd server modules kept (or re-added) a private copy — some named
// `escapeRe`/`escapeRegex`, most just inlined at the call site — because nothing
// failed when they did, and the copies drifted (`s.replace` threw on a non-string
// where `String(s).replace` coerced). This guard is what makes the extraction
// stick: a fresh copy fails the suite instead of shipping.
//
// It keys on the escape IDIOM, not on the identifier, because every copy this repo
// ever grew was a byte-identical paste under a different name (or no name at all).
// The `'\\$&'` replacement is the spelling-independent half — it is what makes a
// `.replace` an escape rather than an edit, and after this migration it appears in
// exactly two source files repo-wide: `server/lib/textUtils.js` and its client
// mirror. Consequence: even quoting the idiom in a comment trips the guard —
// describe the rule in prose, or put the example in a textUtils.js, which is the
// file that owns it on each side.
//
// Scope: `collectServerSources` walks all of `server/` but skips `*.test.js`, so
// that half covers product code — a copy in a server test can't change what the
// server does, and this very file spells the idiom. `collectClientSources` walks
// `client/src/` and does NOT skip tests (nor `.jsx`), because nothing over there
// needs the exemption and a client test was one of the copies #5790 migrated.
const ESCAPE_IDIOMS = [
  // The self-referential replacement every copy of the escape uses.
  /'\\\\\$&'/,
  // The escape's character class, for a copy that assembles it differently.
  /\[\.\*\+\?\^\$\{\}\(\)\|\[\\\]\\\\\]/,
  // A copy that reorders the class but keeps the conventional name.
  /(?:^|[^\w$.])(?:const|let|var|function)\s+escapeRegExp\b/,
];

// How many times the most-spelled idiom in `idioms` appears in `source`.
const idiomCount = (idioms) => (source) => idioms
  .map((idiom) => source.match(new RegExp(idiom.source, 'g'))?.length ?? 0)
  .reduce((most, count) => Math.max(most, count), 0);

const escapeIdiomCount = idiomCount(ESCAPE_IDIOMS);

describe('no private escapeRegExp', () => {
  it('leaves lib/textUtils.js as the only RegExp-escape implementation under server/', () => {
    const offenders = collectServerSources()
      .filter((rel) => rel !== 'lib/textUtils.js')
      .filter((rel) => escapeIdiomCount(readServerSource(rel)) > 0);
    expect(
      offenders,
      `these re-inline the RegExp escape — import escapeRegExp from lib/textUtils.js instead: ${offenders.join(', ')}`
    ).toEqual([]);
  });

  // The client half of the same guard, and it now allows NO exemption: since #6364
  // `client/src/lib/textUtils.js` re-exports this module rather than copying it, so
  // no file under `client/src/` spells the escape at all. Before that, every new
  // client caller copied the nearest one — five product modules and a test had done
  // so by #5790. `collectClientSources` counts `.jsx` and client TESTS too; see its
  // docstring.
  it('leaves no RegExp-escape implementation anywhere under client/src/', () => {
    const offenders = collectClientSources()
      .filter((rel) => escapeIdiomCount(readClientSource(rel)) > 0);
    expect(
      offenders,
      `these re-inline the RegExp escape — import escapeRegExp from lib/textUtils.js instead: ${offenders.join(', ')}`
    ).toEqual([]);
  });

  // Both walks feed the same detector, so pin that it actually fires — an empty
  // offender list is equally what a walk returning nothing produces.
  it('detects a re-inlined copy under any of its spellings', () => {
    expect(escapeIdiomCount(readServerSource('lib/textUtils.js'))).toBeGreaterThan(0);
    // The client walk has no exempt file left to prove itself against, so pin it
    // on a synthetic copy instead — an empty offender list must mean "nobody
    // spells it", not "the walk read nothing".
    expect(collectClientSources().length).toBeGreaterThan(100);
    expect(escapeIdiomCount("const escapeRegExp = (s) => s;")).toBeGreaterThan(0);
    expect(escapeIdiomCount('const x = 1;')).toBe(0);
  });
});

// `countWords` had the same history as the escape: extracted here as "the
// canonical whitespace-token count", then re-spelled in five product modules and
// the client's formatters — whose copy justified itself with "the client cannot
// import from server/", untrue since #6364. Same remedy: key on the counting
// IDIOMS rather than the identifier, since the copies were pastes under three
// names and four under none. The whitespace-token match is how every named copy
// counted; split-and-drop-empties is how the inline ones did. A `matchAll` or a
// `re.exec` loop over the same class is NOT matched — those are the tokenizers
// that need each token's position (rapid reader, tab notation, clichés), and a
// tokenizer is not a count.
//
// A bare split-on-whitespace `.length` (no filter) is deliberately absent: it is
// the five-field cron check's spelling far more often than a word count, and the
// one word-count use (the brain digest's word cap) truncates with the same split,
// so it is at least internally consistent.
const WORD_COUNT_IDIOMS = [
  // The whitespace-token match used as a count.
  /\.match\(\/\\S\+\/g\)/,
  // The split-and-drop-empties count.
  /\.split\(\/\\s\+\/\)\.filter\(Boolean\)\.length/,
  // A helper re-declared under either conventional name.
  /(?:^|[^\w$.])(?:(?:const|let|var)\s+(?:countWords|wordCount)\s*=\s*(?:async\s*)?\(|function\s+(?:countWords|wordCount)\s*\()/,
];

const wordCountIdiomCount = idiomCount(WORD_COUNT_IDIOMS);

describe('no private countWords', () => {
  it('leaves lib/textUtils.js as the only whitespace word count under server/', () => {
    const offenders = collectServerSources()
      .filter((rel) => rel !== 'lib/textUtils.js')
      .filter((rel) => wordCountIdiomCount(readServerSource(rel)) > 0);
    expect(
      offenders,
      `these re-spell the word count — import countWords from lib/textUtils.js instead: ${offenders.join(', ')}`
    ).toEqual([]);
  });

  // The client walk allows no exemption either: `client/src/lib/textUtils.js`
  // re-exports this module's count, and the formatters copy is gone.
  it('leaves no whitespace word count anywhere under client/src/', () => {
    const offenders = collectClientSources()
      .filter((rel) => wordCountIdiomCount(readClientSource(rel)) > 0);
    expect(
      offenders,
      `these re-spell the word count — import countWords from lib/textUtils.js instead: ${offenders.join(', ')}`
    ).toEqual([]);
  });

  it('detects a re-spelled count under any of its idioms, and not a tokenizer', () => {
    expect(wordCountIdiomCount(readServerSource('lib/textUtils.js'))).toBeGreaterThan(0);
    expect(wordCountIdiomCount('const wordCount = (t) => t.split(/\\s+/).filter(Boolean).length;')).toBeGreaterThan(0);
    expect(wordCountIdiomCount('function countWords(text) { return 0; }')).toBeGreaterThan(0);
    expect(wordCountIdiomCount('for (const m of text.matchAll(/\\S+/g)) {}')).toBe(0);
    expect(wordCountIdiomCount('const isCron = value.trim().split(/\\s+/).length === 5;')).toBe(0);
    expect(wordCountIdiomCount('const wordCount = useMemo(() => countWords(body), [body]);')).toBe(0);
  });
});

// String predicates and `trimTo`-shaped bounders had the same history as the
// RegExp escape above. The only exported predicate lived in `storyBible.js`
// behind `crypto` / `fileUtils`, so 73 sanitizers grew a private copy: 17
// spelling the bare type check, 28 a non-empty / non-blank variant — under
// `isStr`, `hasText`, `isText`, `isUsable`, `isNonEmptyStr`, …, with half of
// FableLoom's `isStr` accepting `''` and the other half rejecting it — and 26
// re-rolling `trimTo` as `clampStr` / `trimString` / `str` / `text` / `trim`.
// #6837 moved every one onto `isStr` / `isNonBlankStr` / `trimTo` here; this
// guard is what keeps them here.
//
// It keys on the declared BODY, never the identifier, and every idiom is
// anchored on the statement's terminating `;` (or a function's closing brace).
// That anchoring is what leaves a DOMAIN predicate alone: one whose first line
// merely ends in `typeof x === 'string'` and continues with `&& RE.test(x)`,
// or one that adds any clause at all, never matches — only the pure generic
// bodies do. A one-line alias (`const hasText = isNonBlankStr;`) has no
// `typeof` and passes; a normalizer without `.slice(` is not a bounder.
const GENERIC_STRING_TAIL = String.raw`(?:\s*&&\s*(?:!!\2|\2(?:\.trim\(\))?\.length\s*>\s*0|\2\.trim\(\)\s*!==\s*''))?`;
const STRING_HELPER_IDIOMS = [
  // const isX = (v) => typeof v === 'string'[ && <generic non-empty / non-blank tail>];
  new RegExp(String.raw`^[ \t]*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*\(?\s*(\w+)\s*\)?\s*=>\s*typeof\s+\2\s*===\s*'string'${GENERIC_STRING_TAIL}\s*;[ \t]*$`, 'gm'),
  // function isX(v) { return typeof v === 'string'[ && <tail>]; }
  new RegExp(String.raw`^[ \t]*(?:export\s+)?function\s+(\w+)\s*\(\s*(\w+)\s*\)\s*\{\s*return\s+typeof\s+\2\s*===\s*'string'${GENERIC_STRING_TAIL}\s*;?\s*\}`, 'gm'),
  // const trimX = (v, max[ = DEFAULT]) => [(]typeof v === 'string' ? v.trim().slice(0, max) : ''[)];   (isStr(v) ? … as well)
  new RegExp(String.raw`^[ \t]*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*\(\s*(\w+)\s*,\s*(\w+)(?:\s*=\s*[^,)]+)?\s*\)\s*=>\s*\(?\s*(?:typeof\s+\2\s*===\s*'string'|isStr\(\s*\2\s*\))\s*\?\s*\2\.trim\(\)\.slice\(\s*0\s*,\s*\3\s*\)\s*:\s*''\s*\)?\s*;[ \t]*$`, 'gm'),
];

// Total declarations across all three idioms (a file carrying a predicate AND a
// bounder counts both) — unlike `idiomCount` above, which takes the max of
// alternative spellings of ONE idiom and drops the `m` flag these rely on.
const stringHelperDeclarationCount = (source) => STRING_HELPER_IDIOMS
  .reduce((sum, idiom) => sum + (source.match(new RegExp(idiom.source, idiom.flags))?.length ?? 0), 0);

describe('no private string predicate or bounder', () => {
  it('leaves lib/textUtils.js as the only string predicate or bounder under server/', () => {
    const offenders = collectServerSources()
      .filter((rel) => rel !== 'lib/textUtils.js')
      .filter((rel) => stringHelperDeclarationCount(readServerSource(rel)) > 0);
    expect(
      offenders,
      `these re-declare a string predicate or a trimTo-shaped bounder — import isStr / isNonBlankStr / trimTo from lib/textUtils.js instead: ${offenders.join(', ')}`
    ).toEqual([]);
  });

  // The client mirror re-exports the predicates, so nothing over there needs one.
  it('leaves no string predicate or bounder anywhere under client/src/', () => {
    const offenders = collectClientSources()
      .filter((rel) => stringHelperDeclarationCount(readClientSource(rel)) > 0);
    expect(
      offenders,
      `these re-declare a string predicate or a trimTo-shaped bounder — import isStr / isNonBlankStr / trimTo from lib/textUtils instead: ${offenders.join(', ')}`
    ).toEqual([]);
  });

  it('detects a re-rolled copy under any of its spellings, and not a domain predicate', () => {
    // Positive control on the owner: isStr, isNonBlankStr, and the two-line trimTo.
    expect(stringHelperDeclarationCount(readServerSource('lib/textUtils.js'))).toBe(3);
    expect(collectClientSources().length).toBeGreaterThan(100);

    const fires = [
      "const isStr = (v) => typeof v === 'string';",
      "export const isString = value => typeof value === 'string';",
      "const isNonEmptyString = (value) => typeof value === 'string' && !!value;",
      "const isNonEmptyStr = (v) => typeof v === 'string' && v.length > 0;",
      "  const hasText = (value) => typeof value === 'string' && value.trim().length > 0;",
      "const filled = (v) => typeof v === 'string' && v.trim() !== '';",
      "export function isNonEmptyString(value) {\n  return typeof value === 'string' && value.trim().length > 0;\n}",
      "const clampStr = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');",
      "const trimString = (value, max = MAX_PROMPT_LEN) =>\n  typeof value === 'string' ? value.trim().slice(0, max) : '';",
      "const asBoundedString = (value, max) => (\n  typeof value === 'string' ? value.trim().slice(0, max) : ''\n);",
      "const trimTo = (v, max) => (isStr(v) ? v.trim().slice(0, max) : '');",
    ];
    for (const copy of fires) expect(stringHelperDeclarationCount(copy), copy).toBe(1);

    const passes = [
      "const isHexHash = (v) => typeof v === 'string' && HEX_64.test(v);",
      "const isInstanceId = (id) => typeof id === 'string' && id.length > 0 && id.length <= MAX_ID_LEN;",
      "const validLibraryPath = (path) => typeof path === 'string'\n  && path.startsWith('/') && !path.includes('..');",
      "const hasPrompt = (prompt) => typeof prompt === 'string' && prompt.trim() !== '' && prompt !== '(no prompt)';",
      "const normalizeText = (text) => typeof text === 'string' ? text.trim() : '';",
      "const normalizeTitle = (title) => typeof title === 'string' ? title.trim().slice(0, MAX_TITLE_LENGTH) : '';",
      "const text = (value, max = 6000) => typeof value === 'string'\n  ? value.length > max ? `${value.slice(0, max)}\\n[truncated]` : value : '';",
      'const hasText = isNonBlankStr;',
      "const label = typeof name === 'string' ? name.trim().slice(0, 80) : '';",
    ];
    for (const source of passes) expect(stringHelperDeclarationCount(source), source).toBe(0);
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
