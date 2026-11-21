/**
 * Rule: Failure-marker logs in `server/` and `autofixer/` must use `console.error`/`console.warn` (not `console.log`), every literal log needs a leading marker emoji, and never pass a bare error object (see root `AGENTS.md`).
 * Fix: Route failures to `console.error`, warnings to `console.warn`, or non-failure skips to `console.log` with a non-failure marker; interpolate `${err.message}` instead of passing `err`.
 * What this guard cannot see:
 *   - Messages built into a variable before the call, aliased loggers (`const log = console.log`), or `emitLog` with a non-literal level.
 *   - Failures phrased without a marker emoji, or non-literal first arguments.
 *   - `scripts/`, `client/`, `server/scripts/` (marker rule), and `server/test/` (marker rule) are out of scope.
 */

import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { matchBracket } from '../../../lib/sourceScan.js';
import { blankLiterals } from '../../guardSources.js';
import { readText, REPO_ROOT, trackedFiles } from '../../../../scripts/lib/guardCorpus.js';

const SERVER_ROOT = join(REPO_ROOT, 'server');

// Built from code points so this file's own prose cannot be mistaken for a
// violating call site by a future grep-shaped guard, and so the literals stay
// legible in an editor that renders emoji at inconsistent widths.
const CROSS_MARK = String.fromCodePoint(0x274c);        // cross mark
const NO_ENTRY = String.fromCodePoint(0x26d4);          // no entry
const FAILURE_MARKERS = [CROSS_MARK, NO_ENTRY];

const CONSOLE_LOG_OPEN = /\bconsole\s*\.\s*log\s*\(/g;

// Four scans lex the same ~1,000 sources. One paired traversal yields both views
// (`blanked` and comment-only `code`), memoized per source text so each file is
// lexed once per run instead of twice per scan.
const lexCache = new Map();
function lexViews(src) {
  let views = lexCache.get(src);
  if (!views) {
    views = blankLiterals(src, { includeCommentOnly: true });
    lexCache.set(src, views);
  }
  return views;
}

// Source of each tracked file, read once and shared by every scan.
const sourceCache = new Map();
function readSource(root, file) {
  const key = join(root, file);
  let src = sourceCache.get(key);
  if (src === undefined) {
    src = readText(key);
    sourceCache.set(key, src);
  }
  return src;
}

// 1-based line of an ascending sequence of indexes, counting newlines
// incrementally instead of re-splitting the prefix for every match.
function lineCounter(src) {
  let at = 0;
  let line = 1;
  return (index) => {
    for (let nl = src.indexOf('\n', at); nl !== -1 && nl < index; nl = src.indexOf('\n', at)) {
      line += 1;
      at = nl + 1;
    }
    return line;
  };
}
const CONSOLE_LOG_SHAPE = /\bconsole\s*\.\s*log\s*\(/;

/**
 * Every `console.log(…)` call in the covered process trees, as `{ line, args }` where `args` keeps
 * the literal text (the markers live inside template strings, which
 * `blankLiterals` would erase) but has COMMENT bodies blanked, so a marker
 * written in a comment beside the message is not read as part of it.
 *
 * Call boundaries come from the fully BLANKED copy, so a `)` inside a string or
 * a regex character class cannot end the span early and a multi-line call is
 * captured whole rather than by a fixed line window.
 */
export function consoleLogCalls(src) {
  const { blanked, code: codeOnly } = lexViews(src);
  const calls = [];
  const lineAt = lineCounter(src);
  for (const match of blanked.matchAll(CONSOLE_LOG_OPEN)) {
    const open = blanked.indexOf('(', match.index);
    const close = matchBracket(blanked, open);
    if (close === -1) continue;
    calls.push({
      line: lineAt(match.index),
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

// info and success always reach console.log; debug does too when it is printed
// (COS_LOG_LEVEL=debug). warn and error already use console.warn / console.error.
// Only a literal level is visible. Only the message argument is scanned: that
// is the text emitLog writes, and the issue's rule is the message, not data.
const EMIT_LOG_OPEN = /\bemitLog\s*\(/g;
const QUIET_EMIT_LEVEL = /^\s*(['"`])(info|debug|success)\1\s*$/;

function splitCallArgs(blanked, codeOnly, open, close) {
  const end = close - 1;
  const args = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open + 1; i < end; i++) {
    const c = blanked[i];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ',' && depth === 0) {
      args.push(codeOnly.slice(start, i).trim());
      start = i + 1;
    }
  }
  const last = codeOnly.slice(start, end).trim();
  if (last) args.push(last);
  return args;
}

/** `line N: <excerpt>` for every quiet emitLog whose message carries a failure marker. */
export function findMislabeledEmitLogs(src) {
  const { blanked, code: codeOnly } = lexViews(src);
  const hits = [];
  const lineAt = lineCounter(src);
  for (const match of blanked.matchAll(EMIT_LOG_OPEN)) {
    const open = blanked.indexOf('(', match.index);
    const close = matchBracket(blanked, open);
    if (close === -1) continue;
    const args = splitCallArgs(blanked, codeOnly, open, close);
    if (!QUIET_EMIT_LEVEL.test(args[0] ?? '')) continue;
    const message = args[1] ?? '';
    if (!FAILURE_MARKERS.some((marker) => message.includes(marker))) continue;
    const line = lineAt(match.index);
    hits.push(`line ${line}: ${message.replace(/\s+/g, ' ').trim().slice(0, 120)}`);
  }
  return hits;
}

const CONSOLE_CALL_OPEN = /\bconsole\s*\.\s*(log|warn|error|info|debug)\s*\(/g;
const BARE_ERROR_ARG = /^(?:err|error|e|ex|reason)$/;
// Shown to the reader of a failing marker scan — only literals whose first
// character a lexer can see are judged (see the rule above).
const LEADING_MARKER = /^\p{Extended_Pictographic}/u;

/**
 * Every `console.<level>(…)` call as `{ line, method, args }`, where `args` is the
 * top-level argument list with comment bodies blanked and literal text kept.
 * Argument boundaries come from the fully blanked copy, so a comma inside a
 * string or template cannot split an argument.
 */
export function consoleCalls(src) {
  const { blanked, code: codeOnly } = lexViews(src);
  const calls = [];
  const lineAt = lineCounter(src);
  for (const match of blanked.matchAll(CONSOLE_CALL_OPEN)) {
    const open = blanked.indexOf('(', match.index);
    const close = matchBracket(blanked, open);
    if (close === -1) continue;
    calls.push({
      line: lineAt(match.index),
      method: match[1],
      args: splitCallArgs(blanked, codeOnly, open, close),
    });
  }
  return calls;
}

/** `line N: <excerpt>` for every console call whose literal message has no leading marker emoji. */
export function findMarkerlessLogs(src) {
  const hits = [];
  for (const { line, args } of consoleCalls(src)) {
    const literal = (args[0] ?? '').match(/^(['"`])([\s\S]*)/);
    if (!literal) continue;
    // `\n` / `\r` escapes lead a spaced-out block; they are not part of the message.
    const body = literal[2].replace(/^(?:\\[nr])+/, '');
    if (body.startsWith('${') || body.startsWith('  ')) continue;
    if (!LEADING_MARKER.test(body.trimStart())) hits.push(`line ${line}: ${args[0].slice(0, 80)}`);
  }
  return hits;
}

/** `line N: <excerpt>` for every console call passing a bare error identifier as an argument. */
export function findBareErrorArguments(src) {
  return consoleCalls(src)
    .filter(({ args }) => args.some((arg) => BARE_ERROR_ARG.test(arg)))
    .map(({ line, args }) => `line ${line}: ${args.join(', ').slice(0, 80)}`);
}

// Every module extension the covered process trees actually ship, not just
// `.js`. The repository root is important: using `server/` as cwd silently
// excludes the sibling `autofixer/` daemon.
const PROCESS_ROOTS = ['server/', 'autofixer/'];
// One-shot operator CLIs print human-formatted output, and fixtures stub other
// code; neither is a log stream a marker grep or stderr monitor reads.
const LINE_SHAPE_EXEMPT_PREFIXES = ['server/scripts/', 'server/test/'];
const trackedServerSources = () => trackedFiles(REPO_ROOT, ['*.js', '*.mjs', '*.cjs']).filter((f) => f && PROCESS_ROOTS.some((root) => f.startsWith(root)) && !f.includes('.test.'));

describe('failure lines log at error level (#7945)', () => {
  it('scans both long-running Node process trees', () => {
    // A broken `git ls-files` (wrong cwd, detached checkout) would otherwise let
    // every assertion below pass by scanning nothing at all.
    const sources = trackedServerSources();
    expect(sources.length).toBeGreaterThan(200);
    expect(PROCESS_ROOTS.every((root) => sources.some((file) => file.startsWith(root)))).toBe(true);
  });

  it('scans every module extension the tree ships, not only .js', () => {
    // `server/scripts/` is `.mjs`, and a `*.js`-only glob called the tree clean
    // while one of those scripts logged a failure through console.log.
    expect(trackedServerSources().filter((f) => f.endsWith('.mjs')).length).toBeGreaterThan(0);
  });

  it('finds the console.log calls it is meant to read', () => {
    // Proves the extractor still recognizes real call sites — without this the
    // scan below could go vacuously green if `consoleLogCalls` stopped matching.
    // Most server modules do not log at all. A cheap lexical pre-filter keeps
    // this guard from lexing 30 MB of unrelated source on every worker while
    // `consoleLogCalls` remains the authority for what counts as a call.
    const withLogs = trackedServerSources().filter((file) => {
      const src = readSource(REPO_ROOT, file);
      return CONSOLE_LOG_SHAPE.test(src) && consoleLogCalls(src).length > 0;
    });
    expect(withLogs.length).toBeGreaterThan(100);
  });

  it('has no emitLog at a non-failure level carrying a failure marker', () => {
    const violations = [];
    for (const file of trackedServerSources()) {
      const src = readSource(REPO_ROOT, file);
      if (!/\bemitLog\s*\(/.test(src)) continue;
      if (!FAILURE_MARKERS.some((marker) => src.includes(marker))) continue;
      for (const hit of findMislabeledEmitLogs(src)) violations.push(`${file} ${hit}`);
    }
    expect(
      violations,
      'emitLog routes info/debug/success to console.log, so a failure-marked line there is '
      + 'invisible to stderr monitors. Fix: emitLog(\'warn\', …) for a refusal/skip, '
      + 'emitLog(\'error\', …) for a failure.\n'
      + `Offenders:\n  ${violations.join('\n  ')}`,
    ).toEqual([]);
  });

  it('has no console.log carrying a failure marker', () => {
    const violations = [];
    for (const file of trackedServerSources()) {
      const src = readSource(REPO_ROOT, file);
      if (!CONSOLE_LOG_SHAPE.test(src)) continue;
      if (!FAILURE_MARKERS.some((marker) => src.includes(marker))) continue;
      for (const hit of findMislabeledFailureLogs(src)) violations.push(`${file} ${hit}`);
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

describe('log lines carry a marker and no bare error object (#9951)', () => {
  const scanned = () => trackedServerSources()
    .filter((file) => !LINE_SHAPE_EXEMPT_PREFIXES.some((prefix) => file.startsWith(prefix)))
    .map((file) => ({ file, src: readSource(REPO_ROOT, file) }))
    .filter(({ src }) => /\bconsole\s*\.\s*(?:log|warn|error|info|debug)\s*\(/.test(src));

  it('has no console call whose message lacks a leading marker emoji', () => {
    const violations = scanned().flatMap(({ file, src }) => findMarkerlessLogs(src).map((hit) => `${file} ${hit}`));
    expect(
      violations,
      'These log lines have no leading marker emoji (root `AGENTS.md` single-line logging: '
      + '`console.log(`🚀 …`)`, `❌` failure, `⚠️` refusal). Add the marker; the stream picks the level.\n'
      + `Offenders:\n  ${violations.join('\n  ')}`,
    ).toEqual([]);
  });

  it('passes no bare error object to a console call', () => {
    const violations = scanned().flatMap(({ file, src }) => findBareErrorArguments(src).map((hit) => `${file} ${hit}`));
    expect(
      violations,
      'These calls hand a whole error object to console, which prints a multi-line stack. '
      + 'Interpolate it: `console.error(`❌ … ${err.message}`)`.\n'
      + `Offenders:\n  ${violations.join('\n  ')}`,
    ).toEqual([]);
  });

  it('flags a marker-less literal and accepts the shapes it cannot judge', () => {
    expect(findMarkerlessLogs("console.warn(`Failed to read ${p}`);")).toHaveLength(1);
    expect(findMarkerlessLogs("console.log('server started');")).toHaveLength(1);
    expect(findMarkerlessLogs('console.error(`[Tag] failed`);')).toHaveLength(1);

    expect(findMarkerlessLogs(`console.log(\`\\n${String.fromCodePoint(0x1f6d1)} stopping\`);`)).toEqual([]);
    expect(findMarkerlessLogs("console.warn(`⚠️ refused`);")).toEqual([]);
    // The marker may live in an interpolated prefix the scan cannot see.
    expect(findMarkerlessLogs('console.log(`${LOG_PREFIX}: armed`);')).toEqual([]);
    // Indented follow-on line of a multi-line notice.
    expect(findMarkerlessLogs("console.error('   Set up the database with: npm run setup:db');")).toEqual([]);
    // A non-literal first argument is never judged.
    expect(findMarkerlessLogs('console.error(logMsg, stack);')).toEqual([]);
    expect(findMarkerlessLogs("// console.log('no marker in a comment')")).toEqual([]);
  });

  it('flags a bare error argument and accepts interpolated or property access', () => {
    expect(findBareErrorArguments("console.error('❌ failed', err);")).toHaveLength(1);
    expect(findBareErrorArguments("console.error('❌ failed:', error);")).toHaveLength(1);

    expect(findBareErrorArguments('console.error(`❌ failed: ${err.message}`);')).toEqual([]);
    expect(findBareErrorArguments('console.error(err.stack);')).toEqual([]);
    // A comma inside a template must not split off a fake bare argument.
    expect(findBareErrorArguments('console.error(`❌ a, err, b`);')).toEqual([]);
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

  it('flags a failure marker on a quiet emitLog level', () => {
    expect(findMislabeledEmitLogs(`emitLog('info', \`${CROSS_MARK} blocked\`, { id: 1 });`))
      .toHaveLength(1);
    expect(findMislabeledEmitLogs(`emitLog('debug', \`${CROSS_MARK} blocked\`);`))
      .toHaveLength(1);
    expect(findMislabeledEmitLogs(`emitLog("success", \`${NO_ENTRY} skipping\`);`))
      .toHaveLength(1);
    // The marker may sit anywhere in the message, not only as its first character.
    expect(findMislabeledEmitLogs(`emitLog('info', \`queued ${NO_ENTRY}\`);`)).toHaveLength(1);
    expect(findMislabeledEmitLogs(`
      emitLog(
        'info',
        \`${NO_ENTRY} Skipping install-wide \${taskType}\`,
      );
    `)).toHaveLength(1);
    // warn and error are the routed sinks. A variable level is not judged.
    expect(findMislabeledEmitLogs(`emitLog('warn', \`${NO_ENTRY} skipping\`);`)).toEqual([]);
    expect(findMislabeledEmitLogs(`emitLog('error', \`${CROSS_MARK} failed\`);`)).toEqual([]);
    expect(findMislabeledEmitLogs(`emitLog(level, \`${CROSS_MARK} failed\`);`)).toEqual([]);
    expect(findMislabeledEmitLogs(`emitLog('info', 'started');`)).toEqual([]);
    // A marker in a comment, the data object, or the prefix is not the message.
    expect(findMislabeledEmitLogs(`emitLog('info', /* ${NO_ENTRY} */ 'started');`)).toEqual([]);
    expect(findMislabeledEmitLogs(`emitLog('info', 'started', { note: '${NO_ENTRY}' });`)).toEqual([]);
    expect(findMislabeledEmitLogs(`emitLog('info', 'started', {}, '${NO_ENTRY}');`)).toEqual([]);
  });

  it('would flag a restored quiet emitLog in agentCompletionCleanup.js', () => {
    const src = readText(join(SERVER_ROOT, 'services/agent/agentCompletionCleanup.js'));
    expect(findMislabeledEmitLogs(src)).toEqual([]);
    const quiet = "emitLog('warn', `" + NO_ENTRY + ' Pipeline';
    const regressed = src.replace(quiet, quiet.replace("'warn'", "'info'"));
    expect(regressed).not.toBe(src);
    expect(findMislabeledEmitLogs(regressed)).toHaveLength(1);
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
    // `of` is a contextual keyword AND a legal identifier, so it must stay out
    // of the keyword set: reading `of / n` as a regex opener blanks the rest of
    // the line and the marker after it vanishes.
    expect(findMislabeledFailureLogs(
      `const of = 4; console.log(of / (count), \`${CROSS_MARK} failed\`);`,
    )).toHaveLength(1);
    // A property named after a keyword is a value, so the `/` after it divides.
    expect(findMislabeledFailureLogs(
      `console.log(limits.in / (count), \`${CROSS_MARK} failed\`);`,
    )).toHaveLength(1);
    // Same for a private field — `#return` is a name, not the keyword.
    expect(findMislabeledFailureLogs(
      `class C { #return = 4; m(n) { console.log(this.#return / (n), \`${CROSS_MARK} failed\`); } }`,
    )).toHaveLength(1);
    // And for an identifier that merely ENDS in a keyword's letters, including
    // one with a non-ASCII character an ASCII-only boundary would split on.
    expect(findMislabeledFailureLogs(
      `console.log(caseCount / (n), \`${CROSS_MARK} failed\`);`,
    )).toHaveLength(1);
    expect(findMislabeledFailureLogs(
      `console.log(café / (n), \`${CROSS_MARK} failed\`);`,
    )).toHaveLength(1);
  });

  // Bypass probe: the scan is only worth its runtime if a reintroduced
  // violation in a REAL tracked file actually turns it red. Mutate a file's
  // source in memory and assert the same predicate the tree-wide scan uses.
  it('would flag a reintroduced violation in a real server file', () => {
    const file = 'services/appBuilder.js';
    const src = readText(join(SERVER_ROOT, file));
    expect(findMislabeledFailureLogs(src)).toEqual([]);
    const regressed = src.replace(
      /console\.error\(`❌ npm install/,
      'console.log(`❌ npm install',
    );
    expect(regressed).not.toBe(src);
    expect(findMislabeledFailureLogs(regressed)).toHaveLength(1);
  });
});
