/**
 * Repo-wide guard: a failure line may not be logged through `console.log`.
 *
 * ## The bug class
 *
 *   console.log(`FAILMARK npm install exit=${code}: ${output}`);
 *
 * `console.log` writes to stdout. Every stderr-based monitor — PM2's error log,
 * a `2>` redirect, a log shipper splitting streams, a human running
 * `npm start 2>errors.log` — is blind to that line, so the one message that
 * explains a failure is filed next to ordinary progress chatter.
 *
 * The defect kept coming back because every fix so far was file-scoped:
 * #6935 converted the media-generation pipeline, and by the time it merged the
 * same shape was live again in other domains (#7945). Nothing failed CI when
 * the next one landed. This scan is what makes the rule hold without anyone
 * remembering it.
 *
 * ## The rule
 *
 * A `console.log(…)` call whose ARGUMENT TEXT carries a failure marker is a
 * violation. Route it by what actually happened:
 *
 *   - a genuine failure          → `console.error`
 *   - a deliberate refusal/skip  → `console.warn`
 *   - a mixed success/failure line (a ternary status message) → pick the sink
 *     first and log through it: `const log = ok ? console.log : console.error;`
 *
 * Only the two FAILURE markers are scanned. The warning marker is deliberately
 * out of scope: plenty of its uses are legitimate information (an intentional
 * version-refusal notice in `services/sharing/importer.js`, for one), and
 * re-leveling those is per-domain judgment, not a tree-wide rule.
 *
 * ## Allowlist
 *
 * There is none, on purpose. Every site in the tree passes; a new violation is
 * a bug to fix, not an entry to add. If you are reading this because the scan
 * just failed, change `console.log` to `console.error` (or `console.warn` for a
 * refusal) on the named line.
 *
 * ## What this guard CANNOT see
 *
 * It is a lexer-assisted source scan, not a scope-aware AST pass. It reads the
 * ARGUMENT TEXT (comment bodies blanked) of a literal `console.log(` call,
 * which means:
 *
 *   - A message built into a variable first (`const line = `FAILMARK …`;
 *     console.log(line);`) is invisible. That is the same shape the mixed-sink
 *     fix produces on purpose, so the guard cannot distinguish the fix from an
 *     evasion — it is a convention backstop, not a sandbox.
 *   - An aliased logger (`const log = console.log; log(…)`) is invisible.
 *   - A failure phrased without a marker emoji is invisible. The markers are
 *     the repo's own single-line-logging convention (root `AGENTS.md`), so they
 *     are the signal available to a text scan.
 *
 * Widening any of these means an AST pass plus a semantic notion of "this
 * message describes a failure", which no scan can have. The shapes above are
 * rare, and the marker convention is what makes the cheap version worth having.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { blankCommentBodies, blankLiterals, matchBracket } from './lib/sourceScan.js';

const SERVER_ROOT = dirname(fileURLToPath(import.meta.url));

// Built from code points so this file's own prose cannot be mistaken for a
// violating call site by a future grep-shaped guard, and so the literals stay
// legible in an editor that renders emoji at inconsistent widths.
const CROSS_MARK = String.fromCodePoint(0x274c);        // cross mark
const NO_ENTRY = String.fromCodePoint(0x26d4);          // no entry
const FAILURE_MARKERS = [CROSS_MARK, NO_ENTRY];

const CONSOLE_LOG_OPEN = /\bconsole\s*\.\s*log\s*\(/g;

/**
 * Every `console.log(…)` call in `src`, as `{ line, args }` where `args` keeps
 * the literal text (the markers live inside template strings, which
 * `blankLiterals` would erase) but has COMMENT bodies blanked, so a marker
 * written in a comment beside the message is not read as part of it.
 *
 * Call boundaries come from the fully BLANKED copy, so a `)` inside a string or
 * a regex character class cannot end the span early and a multi-line call is
 * captured whole rather than by a fixed line window.
 */
export function consoleLogCalls(src) {
  const blanked = blankLiterals(src);
  const codeOnly = blankCommentBodies(src);
  const calls = [];
  for (const match of blanked.matchAll(CONSOLE_LOG_OPEN)) {
    const open = blanked.indexOf('(', match.index);
    const close = matchBracket(blanked, open);
    if (close === -1) continue;
    calls.push({
      line: src.slice(0, match.index).split('\n').length,
      // `close` is one past the matching `)`, so `close - 1` drops it. Both
      // copies preserve length, so the span indexes either one.
      args: codeOnly.slice(open + 1, close - 1),
    });
  }
  return calls;
}

/** `line N: <excerpt>` for every console.log carrying a failure marker. */
export function findMislabeledFailureLogs(src) {
  return consoleLogCalls(src)
    .filter(({ args }) => FAILURE_MARKERS.some((marker) => args.includes(marker)))
    .map(({ line, args }) => `line ${line}: ${args.replace(/\s+/g, ' ').trim().slice(0, 120)}`);
}

// Every module extension the tree actually ships, not just `.js`: the operator
// scripts under `server/scripts/` are `.mjs`, and one of them was logging a
// failure through `console.log` while a `*.js`-only scan reported the tree
// clean.
const trackedServerSources = () => execFileSync('git', ['ls-files', '*.js', '*.mjs', '*.cjs'], {
  cwd: SERVER_ROOT,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
}).split('\n').filter((f) => f && !f.includes('.test.'));

describe('failure lines log at error level (#7945)', () => {
  it('scans the server tree', () => {
    // A broken `git ls-files` (wrong cwd, detached checkout) would otherwise let
    // every assertion below pass by scanning nothing at all.
    expect(trackedServerSources().length).toBeGreaterThan(200);
  });

  it('scans every module extension the tree ships, not only .js', () => {
    // `server/scripts/` is `.mjs`, and a `*.js`-only glob called the tree clean
    // while one of those scripts logged a failure through console.log.
    expect(trackedServerSources().filter((f) => f.endsWith('.mjs')).length).toBeGreaterThan(0);
  });

  it('finds the console.log calls it is meant to read', () => {
    // Proves the extractor still recognizes real call sites — without this the
    // scan below could go vacuously green if `consoleLogCalls` stopped matching.
    const withLogs = trackedServerSources().filter((file) => (
      consoleLogCalls(readFileSync(join(SERVER_ROOT, file), 'utf8')).length > 0
    ));
    expect(withLogs.length).toBeGreaterThan(100);
  });

  it('has no console.log carrying a failure marker', () => {
    const violations = [];
    for (const file of trackedServerSources()) {
      const src = readFileSync(join(SERVER_ROOT, file), 'utf8');
      if (!src.includes('console.log')) continue;
      if (!FAILURE_MARKERS.some((marker) => src.includes(marker))) continue;
      for (const hit of findMislabeledFailureLogs(src)) violations.push(`server/${file} ${hit}`);
    }

    expect(
      violations,
      'These failure lines go to stdout, where every stderr-based monitor (PM2 error log, '
      + 'a `2>` redirect, a stream-splitting log shipper) is blind to them. The level keeps '
      + 'regressing because each past fix was file-scoped (#6935 → #7945).\n'
      + 'Fix: use `console.error` for a genuine failure, `console.warn` for a deliberate '
      + 'refusal or skip. For a mixed success/failure status line, choose the sink first — '
      + '`const log = ok ? console.log : console.error;` — see services/appBuilder.js.\n'
      + `Offenders:\n  ${violations.join('\n  ')}`,
    ).toEqual([]);
  });
});

// Guards the guard: if the recognizer stops seeing the broken shape, the scan
// above goes green and the bug class walks straight back in.
describe('the failure-log recognizer', () => {
  const log = (body) => `console.log(\`${body}\`);`;

  it('flags a failure marker in a console.log', () => {
    expect(findMislabeledFailureLogs(log(`${CROSS_MARK} build failed`)))
      .toEqual([`line 1: \`${CROSS_MARK} build failed\``]);
    expect(findMislabeledFailureLogs(log(`${NO_ENTRY} refused: no consent`)))
      .toEqual([`line 1: \`${NO_ENTRY} refused: no consent\``]);
  });

  it('flags a marker reached only through a ternary', () => {
    // The mixed status line — the shape that hides a failure behind a success
    // message and the reason the fix is "choose the sink first".
    expect(findMislabeledFailureLogs(
      'console.log(`${ok ? "OK" : "' + CROSS_MARK + '"} Build done`);',
    )).toHaveLength(1);
  });

  it('flags a marker on a continuation line of a multi-line call', () => {
    // A per-line grep sees `console.log(` and the marker on different lines and
    // misses this entirely — the whole reason the span is bracket-matched.
    expect(findMislabeledFailureLogs(`
      console.log(
        \`${CROSS_MARK} render failed [\${jobId}]: \${reason}\`,
      );
    `)).toEqual([`line 2: \`${CROSS_MARK} render failed [\${jobId}]: \${reason}\`,`]);
  });

  it('accepts console.error and console.warn', () => {
    expect(findMislabeledFailureLogs(`console.error(\`${CROSS_MARK} build failed\`);`)).toEqual([]);
    expect(findMislabeledFailureLogs(`console.warn(\`${NO_ENTRY} skipping fallback\`);`)).toEqual([]);
  });

  it('leaves non-failure markers alone', () => {
    // Success, progress and warning lines are all legitimate on stdout; the
    // warning marker in particular is deliberately out of scope.
    expect(findMislabeledFailureLogs(log('✅ build complete'))).toEqual([]);
    expect(findMislabeledFailureLogs(log('\u{1f680} deploy started'))).toEqual([]);
    expect(findMislabeledFailureLogs(log('⚠️ version refused — older peer'))).toEqual([]);
  });

  it('is not skewed by a paren or quote inside a literal', () => {
    // An unbalanced `)` in a string would end the span early and hide the
    // marker after it; a quote inside a regex character class would swallow
    // code as if it were a string.
    expect(findMislabeledFailureLogs(`
      console.log(cleaned.replace(/["')]/g, ''), \`${CROSS_MARK} failed\`);
    `)).toHaveLength(1);
    // A neighbouring call must not be absorbed into this one's span.
    expect(findMislabeledFailureLogs(`
      console.log('fine');
      console.error(\`${CROSS_MARK} failed\`);
    `)).toEqual([]);
  });

  it('ignores a marker that only appears in a comment or in unrelated code', () => {
    expect(findMislabeledFailureLogs(`
      // console.log(\`${CROSS_MARK} do not do this\`)
      const marker = '${CROSS_MARK}';
      console.log('fine');
    `)).toEqual([]);
  });

  it('ignores a marker in a comment INSIDE the call', () => {
    // A comment explaining the rule sits in the argument span, so a raw-text
    // marker search reports the message it documents as a violation.
    expect(findMislabeledFailureLogs(
      `console.log(/* ${CROSS_MARK} never here */ 'fine');`,
    )).toEqual([]);
    expect(findMislabeledFailureLogs(`
      console.log(
        // ${CROSS_MARK} would be wrong on this line
        'fine',
      );
    `)).toEqual([]);
    // …but a marker in the MESSAGE is still found when a comment shares the span.
    expect(findMislabeledFailureLogs(
      `console.log(/* explained below */ \`${CROSS_MARK} failed\`);`,
    )).toHaveLength(1);
  });

  it('is not skewed by a regex literal that follows a keyword', () => {
    // `await /…/` is a regex, not division. Read as division it blanks nothing,
    // so the `)` inside the character class ends the span early and the marker
    // after it disappears.
    expect(findMislabeledFailureLogs(
      `async function f() { console.log(await /[)]/.test(s), \`${CROSS_MARK} failed\`); }`,
    )).toHaveLength(1);
    expect(findMislabeledFailureLogs(
      `function f() { console.log(typeof x, /[)]/.test(s), \`${CROSS_MARK} failed\`); }`,
    )).toHaveLength(1);
    // Division after an identifier must still read as division, or the rest of
    // the file would be swallowed as regex body.
    expect(findMislabeledFailureLogs(`
      const ratio = total / count;
      console.log(\`${CROSS_MARK} failed at \${ratio}\`);
    `)).toHaveLength(1);
  });

  // Bypass probe: the scan is only worth its runtime if a reintroduced
  // violation in a REAL tracked file actually turns it red. Mutate a file's
  // source in memory and assert the same predicate the tree-wide scan uses.
  it('would flag a reintroduced violation in a real server file', () => {
    const file = 'services/appBuilder.js';
    const src = readFileSync(join(SERVER_ROOT, file), 'utf8');
    expect(findMislabeledFailureLogs(src)).toEqual([]);
    const regressed = src.replace(
      /console\.error\(`❌ npm install/,
      'console.log(`❌ npm install',
    );
    expect(regressed).not.toBe(src);
    expect(findMislabeledFailureLogs(regressed)).toHaveLength(1);
  });
});
