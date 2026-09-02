/**
 * Repo-wide guard: an `async` timer callback may not let an `await` reject.
 *
 * ## The bug class
 *
 *   setTimeout(async () => {
 *     const orphaned = await cleanupOrphanedAgents();   // ← rejects on a corrupt state file
 *   }, DELAY);
 *
 * A timer callback runs outside the Express request lifecycle, so there is no
 * `next(err)` for a throw to bubble to and nobody holds the promise the `async`
 * callback returns. A rejection therefore surfaces as an unhandled rejection,
 * which Node >= 15 treats as fatal — the process dies. The CoS runner shipped
 * exactly that at boot (#5668): its orphan-cleanup timer awaited a state-file
 * read/write, so one truncated `agents` file killed the runner seconds after
 * start and PM2 restart-looped it against the same bad file forever.
 *
 * Root `AGENTS.md` already states the rule ("try/catch IS required in … timer
 * callbacks and anything outside the request lifecycle") and
 * `services/mediaJobQueue/index.js` carries the worked example. This test is
 * what makes the rule hold without anyone remembering it.
 *
 * ## The rule
 *
 * Inside the body of a `setTimeout(async …)` / `setInterval(async …)` callback,
 * every `await` must be either
 *
 *   1. lexically inside a `try { … } catch` block (a `try … finally` with no
 *      `catch` re-throws, so it does not count), or
 *   2. applied to an expression whose chain ENDS in `.catch(…)`
 *      (`await save().catch(() => {})`). A `.catch` with another link after it
 *      does not count — `await work().catch(recover).then(rethrow)` can still
 *      reject.
 *
 * Both spellings are load-bearing in the tree today, and both genuinely own the
 * rejection, so neither is preferred over the other. The rule deliberately does
 * NOT demand that `try {` be the callback's FIRST statement: the mediaJobQueue
 * watchdog opens with cheap synchronous re-entrancy guards (`if (inFlight)
 * return;`) before its try, and hoisting those inside the try to satisfy a
 * position-based rule would make correct code worse.
 *
 * ## Allowlist
 *
 * There is none, on purpose. Every site in the tree passes; a new violation is
 * a bug to fix, not an entry to add. If you are reading this because the scan
 * just failed, wrap the body in `try { … } catch (err) { console.error(…); }`.
 *
 * ## What this guard CANNOT see
 *
 * It is a lexer-assisted source scan, not a scope-aware AST pass. Strings,
 * comments, template-literal text, and regex literals are blanked before
 * matching (so an `await` written in a comment does not count, and a `}` inside
 * a string cannot skew the brace walk), but these shapes still slip through:
 *
 *   - A timer whose callback is a named function declared elsewhere
 *     (`setTimeout(sweep, 1000)` where `sweep` is `async`).
 *   - An `await` guarded by a helper the callback calls, rather than by its own
 *     `try` — reads as unguarded, so the guard errs toward flagging.
 *   - A nested `async` callback inside the timer body: its awaits are attributed
 *     to the timer. That is conservative in the right direction — a
 *     fire-and-forget inner async callback has the same ownerless-rejection
 *     problem — but it means the fix may belong on the inner function.
 *   - A promise created but never awaited (`finish(...)` fire-and-forget). Those
 *     are a sibling hazard this rule does not cover.
 *
 * Tightening any of these means moving to an AST pass; the shapes above are
 * rare enough here that the scan earns its keep as-is.
 *
 * ## Where the machinery lives
 *
 * The lexer, bracket matcher, callback parser and the await checker are in
 * `server/lib/sourceScan.js`, shared with `sockets/asyncHandlerGuard.test.js` —
 * the same rule for Socket.IO handlers. Only the `setTimeout`/`setInterval`
 * recognizer below is timer-specific; keeping the rest shared is what stops the
 * two guards drifting on what "owns its rejection" means.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { blankLiterals, matchBracket, parseCallbackAt, unguardedAwaits } from './lib/sourceScan.js';

const SERVER_ROOT = dirname(fileURLToPath(import.meta.url));

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
  return timerCallbackBodies(blanked).flatMap(({ start, text }) => {
    const line = blanked.slice(0, start).split('\n').length;
    return unguardedAwaits(text).map((chain) => `line ${line}: ${chain}`);
  });
}

const trackedServerSources = () => execFileSync('git', ['ls-files', '*.js'], {
  cwd: SERVER_ROOT,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
}).split('\n').filter((f) => f && !f.includes('.test.'));

describe('async timer callbacks own their rejections (#5668)', () => {
  it('scans the server tree', () => {
    // A broken `git ls-files` (wrong cwd, detached checkout) would otherwise let
    // every assertion below pass by scanning nothing at all.
    expect(trackedServerSources().length).toBeGreaterThan(200);
  });

  it('finds the async timer callbacks it is meant to guard', () => {
    // Proves the extractor still recognizes real call sites — without this the
    // scan below could go vacuously green after an unrelated refactor.
    const sites = trackedServerSources().filter((file) => (
      timerCallbackBodies(blankLiterals(readFileSync(join(SERVER_ROOT, file), 'utf8'))).length > 0
    ));
    expect(sites).toEqual(expect.arrayContaining([
      'cos-runner/index.js',
      'services/mediaJobQueue/index.js',
      'services/tuiPromptRunner.js',
    ]));
  });

  it('has no unguarded await in any async timer callback', () => {
    const violations = [];
    for (const file of trackedServerSources()) {
      const src = readFileSync(join(SERVER_ROOT, file), 'utf8');
      if (!src.includes('setTimeout') && !src.includes('setInterval')) continue;
      for (const hit of findUnguardedTimerAwaits(src)) violations.push(`server/${file} ${hit}`);
    }

    expect(
      violations,
      'These awaits sit in an `async` setTimeout/setInterval callback with nothing to own a '
      + 'rejection. A timer callback runs outside the request lifecycle, so a rejected await '
      + 'becomes an unhandled rejection — fatal on Node >= 15, which is how the CoS runner died '
      + 'at boot on a corrupt state file (#5668).\n'
      + 'Fix: wrap the body in `try { … } catch (err) { console.error(`❌ …: ${err.message}`); }`, '
      + 'or append `.catch(…)` to the awaited expression. See services/mediaJobQueue/index.js for '
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
    const src = readFileSync(join(SERVER_ROOT, 'cos-runner/index.js'), 'utf8');
    expect(src).toContain('cleanupOrphanedAgents()');
    expect(findUnguardedTimerAwaits(src)).toEqual([]);
  });
});
