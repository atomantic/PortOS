/**
 * Rule: Every `await` inside an `async` `setTimeout`/`setInterval` callback must be inside a `try { … } catch` block or end in `.catch(…)` (see root `AGENTS.md`, shared lexer in `server/lib/sourceScan.js`).
 * Fix: Wrap the callback body in `try { … } catch (err) { console.error(…); }` or chain `.catch(…)` on the awaited promise.
 * What this guard cannot see:
 *   - Named callback functions declared elsewhere (`setTimeout(sweep, 1000)`).
 *   - An `await` guarded by a helper rather than its own `try` (errs toward flagging).
 *   - Nested `async` callbacks inside the timer body (attributed to the timer).
 *   - Unawaited fire-and-forget promises.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { join } from 'path';
import { matchBracket, parseCallbackAt, unguardedAwaits } from '../../../lib/sourceScan.js';
import { blankLiterals } from '../../guardSources.js';
import { readText, REPO_ROOT, trackedFiles } from '../../../../scripts/lib/guardCorpus.js';

const SERVER_ROOT = join(REPO_ROOT, 'server');

// The lookahead leaves `match.index + match[0].length` sitting ON `async`, which
// is where `parseCallbackAt` expects to start.
const TIMER_OPEN = /\b(setTimeout|setInterval)\s*\(\s*(?=async\b)/g;

/**
 * The body text of every `setTimeout(async …)` / `setInterval(async …)` in
 * `blanked` (which must already have been through `blankLiterals`).
 */
export function timerCallbackBodies(blanked) {
  const bodies = [];
  for (const match of blanked.matchAll(TIMER_OPEN)) {
    const callOpen = blanked.indexOf('(', match.index);
    const callEnd = matchBracket(blanked, callOpen);
    if (callEnd === -1) continue;
    // `callEnd - 1` is the call's `)` — the bound a concise arrow body runs to.
    const callback = parseCallbackAt(blanked, match.index + match[0].length, callEnd - 1);
    if (callback) bodies.push({ start: callback.start, text: callback.text });
  }
  return bodies;
}

/** Every unguarded await in every async timer callback in one file's source. */
export function findUnguardedTimerAwaits(src) {
  const blanked = blankLiterals(src);
  return timerAwaitViolations(blanked, timerCallbackBodies(blanked));
}

function timerAwaitViolations(blanked, bodies) {
  return bodies.flatMap(({ start, text }) => {
    const line = blanked.slice(0, start).split('\n').length;
    return unguardedAwaits(text).map((chain) => `line ${line}: ${chain}`);
  });
}

// Every module extension the tree actually ships, not just `.js`: the operator
// scripts under `server/scripts/` are `.mjs`, and a `*.js`-only glob would
// report the tree clean while one of them held an unguarded timer (#7953).
let files;
const trackedServerSources = () => files ??= trackedFiles(SERVER_ROOT, ['*.js', '*.mjs', '*.cjs']).filter((f) => f && !f.includes('.test.'));

let treeScan;
function scanTree() {
  if (treeScan) return treeScan;
  const start = performance.now();
  let readMs = 0;
  let lexMs = 0;
  let analysisMs = 0;
  let candidates = 0;
  let slowest = { file: 'none', ms: 0, bytes: 0 };
  const sites = [];
  const violations = [];
  for (const file of trackedServerSources()) {
    const readStart = performance.now();
    const src = readText(join(SERVER_ROOT, file));
    readMs += performance.now() - readStart;
    // Literal/comment blanking cannot create either identifier from absent text.
    if (!src.includes('setTimeout') && !src.includes('setInterval')) continue;
    candidates += 1;
    const lexStart = performance.now();
    const blanked = blankLiterals(src);
    const elapsed = performance.now() - lexStart;
    lexMs += elapsed;
    if (elapsed > slowest.ms) slowest = { file, ms: elapsed, bytes: Buffer.byteLength(src) };
    const analysisStart = performance.now();
    const bodies = timerCallbackBodies(blanked);
    if (bodies.length) sites.push(file);
    for (const hit of timerAwaitViolations(blanked, bodies)) violations.push(`server/${file} ${hit}`);
    analysisMs += performance.now() - analysisStart;
  }
  treeScan = { sites, violations };
  if (process.env.CI || process.env.PORTOS_SOURCE_SCAN_PROFILE) {
    process.stdout.write(`🔎 timer scan: files=${files.length} candidates=${candidates} read=${readMs.toFixed(1)}ms lex=${lexMs.toFixed(1)}ms analysis=${analysisMs.toFixed(1)}ms total=${(performance.now() - start).toFixed(1)}ms slowestLexer=${slowest.file}:${slowest.bytes}B:${slowest.ms.toFixed(1)}ms\n`);
  }
  return treeScan;
}

afterAll(() => { treeScan = undefined; files = undefined; });

describe('async timer callbacks own their rejections (#5668)', () => {
  it('scans the server tree', () => {
    // A broken `git ls-files` (wrong cwd, detached checkout) would otherwise let
    // every assertion below pass by scanning nothing at all.
    expect(trackedServerSources().length).toBeGreaterThan(200);
  });

  it('scans every module extension the tree ships, not only .js', () => {
    // `server/scripts/` is `.mjs`, and a `*.js`-only glob would call the tree
    // clean while a script in that extension held an unguarded timer.
    expect(trackedServerSources().filter((f) => f.endsWith('.mjs')).length).toBeGreaterThan(0);
  });

  it('finds the async timer callbacks it is meant to guard', () => {
    // Proves the extractor still recognizes real call sites — without this the
    // scan below could go vacuously green after an unrelated refactor.
    const { sites } = scanTree();
    expect(sites).toEqual(expect.arrayContaining([
      'cos-runner/index.js',
      'services/mediaJobQueue/execution.js',
      'services/tuiPromptRunner.js',
    ]));
  });

  it('has no unguarded await in any async timer callback', () => {
    const { violations } = scanTree();

    expect(
      violations,
      'These awaits sit in an `async` setTimeout/setInterval callback with nothing to own a '
      + 'rejection. A timer callback runs outside the request lifecycle, so a rejected await '
      + 'becomes an unhandled rejection — fatal on Node >= 15, which is how the CoS runner died '
      + 'at boot on a corrupt state file (#5668).\n'
      + 'Fix: wrap the body in `try { … } catch (err) { console.error(`❌ …: ${err.message}`); }`, '
      + 'or append `.catch(…)` to the awaited expression. See services/mediaJobQueue/execution.js for '
      + 'the worked example.\n'
      + `Offenders:\n  ${violations.join('\n  ')}`,
    ).toEqual([]);
  });
});

// Guards the guard: if the recognizer stops seeing the broken shape, the scan
// above goes green and the bug class walks straight back in.
describe('the timer-callback recognizer', () => {
  it('flags a bare await in an async timer callback', () => {
    expect(findUnguardedTimerAwaits('setTimeout(async () => { await f(); }, 100);'))
      .toEqual(['line 1: await f()']);
    expect(findUnguardedTimerAwaits('setInterval(async () => { const x = await load(id); use(x); }, 100);'))
      .toEqual(['line 1: await load(id)']);
    // An early guard before the await does not make it safe.
    expect(findUnguardedTimerAwaits(`
      setTimeout(async () => {
        if (done) return;
        await sweep();
      }, 100);
    `)).toEqual(['line 2: await sweep()']);
    // `async function () {}` is the same callback in a different spelling.
    expect(findUnguardedTimerAwaits('setTimeout(async function () { await f(); }, 100);'))
      .toEqual(['line 1: await f()']);
    // A concise body has no braces to walk, but still owns its await.
    expect(findUnguardedTimerAwaits('setTimeout(async () => await f(), 100);'))
      .toEqual(['line 1: await f()']);
    // Parenthesized concise body. The parser used to read the `(` after the `=>`
    // as a parameter list and jump the whole body, so the await inside was
    // invisible and this passed green.
    expect(findUnguardedTimerAwaits('setTimeout(async () => (await f()), 100);'))
      .toEqual(['line 1: await f()']);
  });

  it('accepts a try-wrapped body', () => {
    expect(findUnguardedTimerAwaits(`
      setTimeout(async () => {
        try {
          await sweep();
        } catch (err) {
          console.error(\`❌ sweep failed: \${err.message}\`);
        }
      }, 100);
    `)).toEqual([]);
  });

  it('accepts a try that opens after cheap synchronous guards', () => {
    // The mediaJobQueue watchdog shape. A rule keyed on `try {` being the FIRST
    // statement would flag this and push someone to hoist the guards inside the
    // try, where the `finally` reset would then be wrong.
    expect(findUnguardedTimerAwaits(`
      setInterval(async () => {
        if (inFlight) return;
        if (job.status !== 'running') return;
        inFlight = true;
        try {
          await tick();
        } catch (err) {
          console.error(\`❌ tick failed: \${err.message}\`);
        } finally {
          inFlight = false;
        }
      }, 100);
    `)).toEqual([]);
  });

  it('rejects a try with only a finally', () => {
    // `finally` runs the cleanup and re-throws — the rejection still escapes.
    expect(findUnguardedTimerAwaits(`
      setTimeout(async () => {
        try {
          await sweep();
        } finally {
          inFlight = false;
        }
      }, 100);
    `)).toEqual(['line 2: await sweep()']);
  });

  it('accepts an awaited chain that ends in .catch()', () => {
    expect(findUnguardedTimerAwaits('setTimeout(async () => { await save().catch(() => {}); }, 500);'))
      .toEqual([]);
    // The `.catch` may sit on its own continuation line — the real shape in
    // routes/apps/lifecycle.js.
    expect(findUnguardedTimerAwaits(`
      setTimeout(async () => {
        for (const name of names) {
          await pm2.restartApp(name)
            .catch(err => console.error(\`❌ restart failed: \${err.message}\`));
        }
      }, 100);
    `)).toEqual([]);
    // A chain whose LAST link is .catch still counts when a .then precedes it.
    expect(findUnguardedTimerAwaits('setTimeout(async () => { await f().then(g).catch(h); }, 1);'))
      .toEqual([]);
  });

  it('rejects a .catch() that is not the last link in the chain', () => {
    // `.then(h)` is handed the recovered promise and can reject on its own, so
    // the awaited chain as a whole is still unowned.
    expect(findUnguardedTimerAwaits('setTimeout(async () => { await f().catch(g).then(h); }, 1);'))
      .toEqual(['line 1: await f().catch(g).then(h)']);
  });

  it('leaves synchronous timer callbacks alone', () => {
    expect(findUnguardedTimerAwaits('setTimeout(() => { tick(); }, 100);')).toEqual([]);
    // `await` in a plain function elsewhere in the file is not a timer callback.
    expect(findUnguardedTimerAwaits('async function run() { await f(); }')).toEqual([]);
  });

  it('ignores an await that only appears in a comment or a string', () => {
    expect(findUnguardedTimerAwaits(`
      setTimeout(async () => {
        // await f() would need a try here
        log('await f()');
        try { await f(); } catch { /* ignored */ }
      }, 100);
    `)).toEqual([]);
  });

  it('is not skewed by a brace or quote inside a literal', () => {
    // An unbalanced \`}\` in a string would truncate the body walk and hide the
    // await after it; a quote inside a regex character class would swallow code
    // as if it were a string.
    expect(findUnguardedTimerAwaits(`
      setTimeout(async () => {
        log('unbalanced } brace');
        const cleaned = raw.replace(/["']/g, '');
        await f();
      }, 100);
    `)).toEqual(['line 2: await f()']);
    // A template literal's \`\${}\` holes are real code and must not blank the
    // statements that follow them.
    expect(findUnguardedTimerAwaits(`
      setTimeout(async () => {
        log(\`ran \${count} times\`);
        await f();
      }, 100);
    `)).toEqual(['line 2: await f()']);
  });

  it('reports the CoS runner boot timer as guarded', () => {
    // The site that motivated the rule — pinned so a revert is caught here and
    // not only by the tree-wide scan.
    const src = readText(join(SERVER_ROOT, 'cos-runner/index.js'));
    expect(src).toContain('cleanupOrphanedAgents()');
    expect(findUnguardedTimerAwaits(src)).toEqual([]);
  });
});
