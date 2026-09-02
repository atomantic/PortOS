import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from './childProcess.js';

/**
 * Checked-in generated manifests must be addressed by CONTENT, never by
 * POSITION.
 *
 * A manifest that records "declared at foo.js:412" is rewritten by every edit
 * that inserts a line above 412 — a rename, a comment, an unrelated handler —
 * even when nothing the manifest describes has changed. The drift test that
 * keeps such a manifest honest then fires on those no-op edits, so each
 * parallel branch regenerates the same file differently and every rebase or
 * merge conflicts on it. The manifest stops being a description of the code
 * and becomes a second, position-coupled copy of it.
 *
 * The fix is the same everywhere: identify a record by something intrinsic —
 * the declaring file plus the semantic identity of the thing declared — and
 * keep any positional detail in memory, where a fresh scan can still use it
 * for verification without committing it. `apiRouteCatalog.generated.json`
 * keys declarations as `file#routerId METHOD /path`; `promptStageCallSites`
 * keys them by stage key and lists file paths only.
 *
 * This guard is the cheap tree-wide net, and it is deliberately shallow: it
 * matches key NAMES, so it can only catch spellings someone anticipated. A
 * generator proves itself clean with the property test in
 * `scripts/lib/positionInvariance.js` instead — shift every line in its inputs
 * and demand byte-identical output. Both generators here do that; this file
 * catches the manifest whose generator never did.
 */

const HERE = resolve(fileURLToPath(import.meta.url), '..');
const REPO_ROOT = resolve(HERE, '..', '..');

// Keys whose numeric value points into a file rather than describing content.
// Offsets are here for the same reason a line number is: they name a position
// in something that moves.
//
// A name list is a cheap tree-wide net, not a proof: it only catches the
// spellings someone thought of. What actually proves a generator clean is the
// property test in `scripts/lib/positionInvariance.js` — shift every line in
// the inputs and demand byte-identical output — which catches `at`, `span`,
// `row`, and every other name this list will never have. Use both.
const POSITIONAL_KEYS = new Set([
  'line', 'lineNumber', 'lineNo', 'startLine', 'endLine',
  'column', 'columnNumber', 'col', 'startColumn', 'endColumn',
  'offset', 'startOffset', 'endOffset', 'charIndex', 'byteOffset',
  // Names for a position that carries its own pair or range. They only fire on
  // a numeric value (or an all-numeric array), so a `span` counting items or a
  // `loc` naming a place is left alone.
  'loc', 'span', 'pos', 'position', 'range',
]);

// A position is always a number. Several of these key names have perfectly
// good non-positional uses with a non-numeric value — a `column` naming a
// Postgres column — and rejecting those would make this guard block manifests
// it has no quarrel with.
// A range or coordinate pair is still a position — `loc: [412, 8]` and
// `line: [412, 420]` are exactly the shapes a generator reaches for once a
// scalar line number feels too coarse, and checking only scalars would recurse
// into the array and find nothing but bare numbers with no key to judge them by.
const isPositionalValue = (value) => typeof value === 'number'
  || (typeof value === 'string' && /^\d+$/.test(value.trim()))
  || (Array.isArray(value) && value.length > 0 && value.every(isPositionalValue));

// A `path/to/file.js:412` (optionally `:8` for a column) pointer smuggled into
// a string, which is how a positional reference survives dropping the key.
const SOURCE_POINTER_RE = /[\w./-]+\.(?:js|jsx|mjs|cjs|ts|tsx|json|md):\d+(?::\d+)?/;

/** Every positional reference in one parsed manifest, as `jsonPath — why`. */
const findPositionalReferences = (value, path = '$') => {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => findPositionalReferences(entry, `${path}[${index}]`));
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, entry]) => {
      const child = `${path}.${key}`;
      if (POSITIONAL_KEYS.has(key) && isPositionalValue(entry)) {
        return [`${child} — positional key "${key}"`];
      }
      return findPositionalReferences(entry, child);
    });
  }
  if (typeof value === 'string' && SOURCE_POINTER_RE.test(value)) {
    return [`${path} — file:line pointer in "${value}"`];
  }
  return [];
};

// `git ls-files` prints POSIX separators, so join against the repo root rather
// than trusting the string to be a usable path on Windows.
// Memoized: this file is in ALWAYS_RUN_TESTS, so it runs on every CI job and
// there is no reason to spawn git once per assertion.
let tracked;
const trackedManifests = () => (tracked ??= execFileSync('git', ['ls-files', '*.generated.json'], {
  cwd: REPO_ROOT,
  encoding: 'utf8',
}).split('\n').filter(Boolean));

describe('checked-in generated manifests', () => {
  it('finds the manifests it is meant to guard', () => {
    // A regression here means the glob stopped matching and every assertion
    // below started passing vacuously.
    expect(trackedManifests()).toEqual(expect.arrayContaining([
      'server/lib/apiRouteCatalog.generated.json',
      'server/lib/promptStageCallSites.generated.json',
    ]));
  });

  it('records no line, column, or offset pointers into the source they describe', () => {
    const offenders = trackedManifests().flatMap((relativePath) => {
      const parsed = JSON.parse(readFileSync(join(REPO_ROOT, relativePath), 'utf8'));
      return findPositionalReferences(parsed).map((reason) => `${relativePath}: ${reason}`);
    });
    expect(offenders, [
      'A generated manifest is pointing at a position in a file instead of at its content.',
      'Line numbers move on edits that change nothing the manifest describes, so the',
      'drift test rewrites the file on unrelated commits and every parallel branch',
      'conflicts on it. Key the record by file + semantic identity instead, and keep',
      'the position in memory for the generator\'s own verification.',
    ].join(' ')).toEqual([]);
  });

  // Bypass probe: the detector must actually fire, or the assertion above is
  // just asserting that JSON.parse succeeded.
  it('flags positional data wherever it hides', () => {
    expect(findPositionalReferences({ routes: [{ sources: [{ source: 'a.js', line: 12 }] }] }))
      .toEqual(['$.routes[0].sources[0].line — positional key "line"']);
    expect(findPositionalReferences({ sources: ['server/routes/a.js:412'] }))
      .toEqual(['$.sources[0] — file:line pointer in "server/routes/a.js:412"']);
    expect(findPositionalReferences({ at: { startLine: 3, endLine: 9 } }))
      .toHaveLength(2);
    // A numeric string is still a position — dropping the type doesn't help.
    expect(findPositionalReferences({ loc: { line: '412' } }))
      .toEqual(['$.loc.line — positional key "line"']);
    // Nor does wrapping it in an array: a range and a coordinate pair are the
    // shapes a generator reaches for when one number stops being enough.
    expect(findPositionalReferences({ loc: [412, 8] }))
      .toEqual(['$.loc — positional key "loc"']);
    expect(findPositionalReferences({ line: [412, 420] }))
      .toEqual(['$.line — positional key "line"']);
    // An empty array names no position, and a list of paths is not one either.
    expect(findPositionalReferences({ line: [] })).toEqual([]);
    // Plain file paths and ordinary counts are what a manifest SHOULD contain,
    // and a positional-sounding key holding a non-numeric value is not a
    // position at all — a Postgres column name.
    expect(findPositionalReferences({ sources: ['server/routes/a.js'], stats: { operations: 2153 } }))
      .toEqual([]);
    expect(findPositionalReferences({ column: 'user_id' })).toEqual([]);
  });

  // The two guards above only reach a generator that followed the naming
  // convention and got its property test written. Neither is structural: a
  // third generator can be added tomorrow with no position-invariance test at
  // all, and nothing fails — the rule would live only in AGENTS.md prose,
  // which is the same "someone has to remember" problem this whole change set
  // exists to delete. This makes adoption structural instead.
  it('requires every generator to carry the position-invariance property test', () => {
    const listed = execFileSync('git', ['ls-files', 'scripts/*.js'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    }).split('\n').filter(Boolean);
    const tests = new Set(listed.filter((path) => path.endsWith('.test.js')));

    // Scope by what a script PRODUCES, not by what it is named. Keying off
    // `generate-*.js` fails a future generate-types.js or generate-fixtures.js
    // that writes no manifest and has nothing to hold invariant, while missing
    // a manifest generator named build-*.js. Writing a checked-in
    // `*.generated.json` is the property that actually incurs the obligation.
    // `scripts/*.js` as a git pathspec also matches nested paths, and the
    // helper library itself names `.generated.json` in its own docstring —
    // so require a runnable script directly under scripts/, not a module it
    // imports.
    const generators = listed.filter((path) => !path.endsWith('.test.js')
      && path.split('/').length === 2
      && readFileSync(join(REPO_ROOT, path), 'utf8').includes('.generated.json'));

    // Guard the guard: if the filter stops matching, the assertion below passes
    // vacuously over an empty list.
    expect(generators).toEqual(expect.arrayContaining([
      'scripts/generate-api-route-catalog.js',
      'scripts/generate-prompt-stage-call-sites.js',
    ]));

    // Require a real import, not a passing mention: a comment naming the module
    // would satisfy a bare substring check while asserting nothing.
    const IMPORTS_HELPER = /^\s*import\s[^;]*from\s+['"][^'"]*positionInvariance\.js['"]/m;
    const missing = generators.filter((path) => {
      const testPath = path.replace(/\.js$/, '.test.js');
      if (!tests.has(testPath)) return true;
      return !IMPORTS_HELPER.test(readFileSync(join(REPO_ROOT, testPath), 'utf8'));
    });

    expect(missing, [
      'A generator under scripts/ has no position-invariance property test.',
      'Import generateAcrossShiftedSources (or shiftSourceText, for a generator that',
      'takes in-memory sources) from scripts/lib/positionInvariance.js in its sibling',
      '.test.js, regenerate across shifted sources, and assert byte-identical output.',
      'Without it, this generator can start recording line numbers and only the',
      'shallow key-name net above would notice — and only if it guessed the name.',
    ].join(' ')).toEqual([]);
  });
});
