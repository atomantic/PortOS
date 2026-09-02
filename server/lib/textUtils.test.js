import { describe, it, expect } from 'vitest';
import { countWords, escapeRegExp, trimTo } from './textUtils.js';
import { collectServerSources, readServerSource } from './testHelper.js';

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
// exactly the two files below. Consequence: even quoting the idiom in a comment
// trips the guard — describe the rule in prose, or put the example in textUtils.js,
// which is the file that owns it.
//
// Scope: `collectServerSources` walks all of `server/` but skips `*.test.js`, so
// this covers product code. A copy in a test can't change what the server does.
const ESCAPE_IDIOMS = [
  // The self-referential replacement every copy of the escape uses.
  /'\\\\\$&'/,
  // The escape's character class, for a copy that assembles it differently.
  /\[\.\*\+\?\^\$\{\}\(\)\|\[\\\]\\\\\]/,
  // A copy that reorders the class but keeps the conventional name.
  /(?:^|[^\w$.])(?:const|let|var|function)\s+escapeRegExp\b/,
];

// `scenePrompt.js` is held byte-for-byte identical to `client/src/lib/scenePrompt.js`
// by the mirror-parity suite in scenePrompt.test.js, and the browser cannot import
// `server/lib`. Migrating it needs a client-side textUtils mirror first — #5790,
// which also deletes this entry. It is the one exemption; do not add another
// without an issue that removes it.
const HOLDOUT = 'lib/scenePrompt.js';

const escapeIdiomCount = (source) => ESCAPE_IDIOMS
  .map((idiom) => source.match(new RegExp(idiom.source, 'g'))?.length ?? 0)
  .reduce((most, count) => Math.max(most, count), 0);

describe('no private escapeRegExp', () => {
  it('leaves lib/textUtils.js as the only RegExp-escape implementation under server/', () => {
    const offenders = collectServerSources()
      .filter((rel) => rel !== 'lib/textUtils.js' && rel !== HOLDOUT)
      .filter((rel) => escapeIdiomCount(readServerSource(rel)) > 0);
    expect(
      offenders,
      `these re-inline the RegExp escape — import escapeRegExp from lib/textUtils.js instead: ${offenders.join(', ')}`
    ).toEqual([]);
  });

  // The holdout is an exemption for ONE known copy, not a licence for the file.
  it('holds the exempt mirror to its single known copy', () => {
    expect(escapeIdiomCount(readServerSource(HOLDOUT))).toBe(1);
  });
});
