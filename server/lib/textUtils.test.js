import { describe, it, expect } from 'vitest';
import { countWords, escapeRegExp, trimTo } from './textUtils.js';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { collectClientSources, collectServerSources, readClientSource, readServerSource } from './testHelper.js';
import { compareDeclaration } from './mirrorParity.js';

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

// The client mirror. It is the ONE file on that side allowed to spell the escape,
// exactly as `lib/textUtils.js` is on this one — every other client caller imports
// it. There is no third exemption, and the scenePrompt holdout that used to sit
// here is gone: the client mirror is what let `lib/scenePrompt.js` migrate (#5790).
const CLIENT_OWNER = 'lib/textUtils.js';

const escapeIdiomCount = (source) => ESCAPE_IDIOMS
  .map((idiom) => source.match(new RegExp(idiom.source, 'g'))?.length ?? 0)
  .reduce((most, count) => Math.max(most, count), 0);

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

  // The client half of the same guard. The browser cannot import `server/lib`, so
  // for as long as this side had no home for the escape every new client caller
  // copied the nearest one — five product modules and a test had done so by #5790.
  // `collectClientSources` counts `.jsx` and client TESTS too; see its docstring.
  it('leaves client/src/lib/textUtils.js as the only RegExp-escape implementation under client/src/', () => {
    const offenders = collectClientSources()
      .filter((rel) => rel !== CLIENT_OWNER)
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
    expect(escapeIdiomCount(readClientSource(CLIENT_OWNER))).toBeGreaterThan(0);
    expect(escapeIdiomCount('const x = 1;')).toBe(0);
  });
});

// The client copy is a declared mirror (`client/src/lib/README.md`), so
// `mirrorCoverage.test.js` requires a test that reads BOTH files — this is it.
// It is a PARTIAL mirror: only `escapeRegExp` crosses, because it is the only
// member the bundle has a caller for.
describe('escapeRegExp — server/client mirror parity', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const CLIENT_COPY = join(here, '../../client/src/lib/textUtils.js');

  it('keeps escapeRegExp identical', () => {
    const server = readFileSync(join(here, 'textUtils.js'), 'utf8');
    const client = readFileSync(CLIENT_COPY, 'utf8');
    const { clientDecl, serverNorm, clientNorm } = compareDeclaration(server, client, 'escapeRegExp');
    expect(clientDecl, 'client/src/lib/textUtils.js is missing escapeRegExp').not.toBeNull();
    expect(clientNorm).toBe(serverNorm);
  });
});
