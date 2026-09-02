/**
 * Directory guard: an `async` Socket.IO handler may not let an `await` reject.
 *
 * ## The bug class
 *
 *   socket.on('voice:call:detach', async () => {
 *     emitCallState(await detachHost(socket));   // ← rejects on a failed teardown
 *   });
 *
 * Socket.IO hands the promise a listener returns to nobody, and a handler runs
 * outside the Express request lifecycle, so there is no `next(err)` for a throw
 * to bubble to. A rejection therefore surfaces as an unhandled rejection, which
 * Node >= 15 treats as fatal — the server process dies, taking every agent run,
 * PTY session and media job with it. `voice:call:detach` shipped exactly that
 * (#5661), and it held across the other handlers here by review alone.
 *
 * `server/sockets/` is the largest population of "outside the request lifecycle"
 * async code in the tree. This is the same rule and the same shape as
 * `server/timerCallbackConventions.test.js` — the two share their lexer,
 * callback parser and await checker via `server/lib/sourceScan.js`, so they
 * cannot drift on what "owns its rejection" means.
 *
 * ## Scope
 *
 * Every `<emitter>.on('<event>', …)` in this directory, not just `socket.on` —
 * `ns.on('connection', …)` and the `pm2 logs` child's `.on('data', …)` in
 * `logs.js` sit in the identical blast radius, and scoping to the literal
 * `socket.` would let the next one in unnoticed. `server/routes/` is out of
 * scope (the centralized error middleware owns those), and so are timer and
 * child-process callbacks (their own guard files).
 *
 * ## Allowlist
 *
 * None, on purpose. If you are reading this because the scan just failed, wrap
 * the handler body in `try { … } catch (err) { console.error(…); }` or append
 * `.catch(…)` to the awaited expression.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blankLiterals, matchBracket, parseCallbackAt, unguardedAwaits } from '../lib/sourceScan.js';

const HERE = dirname(fileURLToPath(import.meta.url));

// `.once` as well as `.on`: a one-shot listener returns its promise to nobody
// exactly the same way, so leaving it out would be a silent hole rather than a
// narrower rule.
const REGISTRATION = /(?<![\w$.])[\w$]+(?:\.[\w$]+)*\.(?:on|once)\s*\(/g;

/** Index of the `,` separating a call's first two arguments, or -1. */
function firstArgumentEnd(blanked, from, limit) {
  let i = from;
  while (i < limit) {
    const c = blanked[i];
    if (c === '(' || c === '[' || c === '{') {
      i = matchBracket(blanked, i);
      if (i === -1) return -1;
      continue;
    }
    if (c === ',') return i;
    i += 1;
  }
  return -1;
}

/**
 * Every `<emitter>.on('<event>', <callback>)` registration in `src`, with the
 * callback body captured whole by a bracket-balanced walk.
 *
 * Bracket-balanced rather than a fixed character window: a window reads the NEXT
 * statement and attributes it to this handler, so an unguarded handler followed
 * by a guarded one would pass on its neighbour's `try`.
 *
 * The event name is read out of the ORIGINAL source at the offsets the blanked
 * copy reports — `blankLiterals` preserves length, so every index still maps
 * back. A registration with a computed event name is skipped rather than
 * reported under a wrong name.
 * @param {string} src
 * @returns {{event: string, isAsync: boolean, body: string, line: number}[]}
 */
export function socketHandlers(src) {
  const blanked = blankLiterals(src);
  const handlers = [];
  for (const match of blanked.matchAll(REGISTRATION)) {
    const callOpen = match.index + match[0].length - 1;
    const callEnd = matchBracket(blanked, callOpen);
    if (callEnd === -1) continue;
    const comma = firstArgumentEnd(blanked, callOpen + 1, callEnd - 1);
    if (comma === -1) continue;

    const event = /^(['"])((?:[^'"\\]|\\.)*)\1$/.exec(src.slice(callOpen + 1, comma).trim())?.[2];
    if (event === undefined) continue;

    const callback = parseCallbackAt(blanked, comma + 1, callEnd - 1);
    if (!callback) continue;
    handlers.push({
      event,
      isAsync: callback.isAsync,
      body: callback.text,
      line: blanked.slice(0, match.index).split('\n').length,
    });
  }
  return handlers;
}

/** Every unguarded await in every async event handler in one file's source. */
export function findUnguardedHandlerAwaits(src) {
  return socketHandlers(src)
    .filter((handler) => handler.isAsync)
    .flatMap((handler) => unguardedAwaits(handler.body)
      .map((chain) => `line ${handler.line} '${handler.event}': ${chain}`));
}

const socketFiles = readdirSync(HERE)
  .filter((f) => f.endsWith('.js') && !f.includes('.test.'))
  .sort();

describe('async socket handlers own their rejections (#5661)', () => {
  it('finds the handlers it is meant to guard', () => {
    // Without this, a refactor of the registration shape would leave the scan
    // below iterating nothing and passing green forever.
    expect(socketFiles.length).toBeGreaterThan(3);
    const handlers = socketFiles.flatMap((f) => socketHandlers(readFileSync(join(HERE, f), 'utf8')));
    expect(handlers.filter((h) => h.isAsync).length).toBeGreaterThan(10);
    // Sync handlers must survive extraction too, or `isAsync` is doing nothing.
    expect(handlers.filter((h) => !h.isAsync).length).toBeGreaterThan(0);
    expect(handlers.map((h) => h.event)).toEqual(expect.arrayContaining([
      'voice:call:detach', 'logs:subscribe', 'shell:start', 'app:update',
    ]));
  });

  it('has no unguarded await in any async socket handler', () => {
    const violations = socketFiles.flatMap((file) => (
      findUnguardedHandlerAwaits(readFileSync(join(HERE, file), 'utf8'))
        .map((hit) => `server/sockets/${file} ${hit}`)
    ));

    expect(
      violations,
      'These awaits sit in an `async` Socket.IO handler with nothing to own a rejection. '
      + 'A handler runs outside the request lifecycle and nobody holds the promise it returns, '
      + 'so a rejected await becomes an unhandled rejection — fatal on Node >= 15, which is how '
      + 'voice:call:detach could have killed the server on a failed teardown (#5661).\n'
      + 'Fix: wrap the body in `try { … } catch (err) { console.error(`❌ …: ${err.message}`); }`, '
      + 'or append `.catch(…)` to the awaited expression.\n'
      + `Offenders:\n  ${violations.join('\n  ')}`,
    ).toEqual([]);
  });
});

// Guards the guard: if the recognizer stops seeing the broken shape, the scan
// above goes green and the bug class walks straight back in.
describe('the socket-handler recognizer', () => {
  it('flags a bare await in an async handler', () => {
    expect(findUnguardedHandlerAwaits("socket.on('x', async () => { await boom(); });"))
      .toEqual(["line 1 'x': await boom()"]);
    // An early return before the await does not make it safe — the fableLoomHosted
    // handlers all open with a role check.
    expect(findUnguardedHandlerAwaits(`
      socket.on('hosted:mic:start', async () => {
        if (socket.hostedRole !== 'audience') return;
        await startListening(sessionId);
      });
    `)).toEqual(["line 2 'hosted:mic:start': await startListening(sessionId)"]);
  });

  it('does not accept a try that only exists in a comment', () => {
    // The comment blanking is what stops a rule being *described* in prose from
    // satisfying the scan. Drop it and this fixture reads as guarded.
    expect(findUnguardedHandlerAwaits(`
      socket.on('x', async () => {
        // try { … } catch — describing the rule, not applying it
        await boom();
      });
    `)).toEqual(["line 2 'x': await boom()"]);
  });

  it('accepts the two guarded shapes', () => {
    // A default-valued parameter puts an object literal before the body ever
    // opens — half of voice.js is spelled this way.
    expect(findUnguardedHandlerAwaits(`
      socket.on('voice:text', async (payload = {}) => {
        try {
          await respond(payload);
        } catch (err) {
          console.error(\`❌ voice:text failed: \${err.message}\`);
        }
      });
    `)).toEqual([]);
    // Chained across lines — the shape logs.js uses on its pm2-home lookups. A
    // scan that ended the statement at the newline would never see the .catch.
    expect(findUnguardedHandlerAwaits(`
      socket.on('logs:subscribe', async ({ appId }) => {
        const home = await getAppById(appId)
          .then((app) => app?.pm2Home || null)
          .catch((err) => { console.error(\`❌ \${err.message}\`); return null; });
        stream(home);
      });
    `)).toEqual([]);
  });

  it('captures each handler body whole, not a window into the next one', () => {
    const found = findUnguardedHandlerAwaits(`
      socket.on('unguarded', async () => {
        await boom();
      });
      socket.on('guarded', async () => {
        try { await fine(); } catch (err) { console.error(err.message); }
      });
    `);
    // The offender must not borrow its neighbour's \`try\`, and the guarded
    // handler must not be dragged down by its neighbour's bare await.
    expect(found).toEqual(["line 2 'unguarded': await boom()"]);
  });

  it('leaves synchronous handlers and non-function arguments alone', () => {
    expect(findUnguardedHandlerAwaits("socket.on('sync', (chunk) => { buffer.push(chunk); });")).toEqual([]);
    expect(socketHandlers("emitter.on('forwarded', handlerRef);")).toEqual([]);
    // A computed event name is skipped rather than reported under a wrong name.
    expect(socketHandlers('socket.on(EVENT, async () => { await boom(); });')).toEqual([]);
  });

  it('reads a non-socket emitter, and a one-shot listener, in this directory too', () => {
    // `ns.on('connection', …)` and the pm2-logs child's `.on('data', …)` are in
    // the same blast radius; scoping the scan to the literal `socket.` would let
    // the next one in unnoticed. `.once` returns its promise to nobody the same
    // way `.on` does.
    expect(findUnguardedHandlerAwaits("logProcess.stdout.on('data', async (chunk) => { await flush(chunk); });"))
      .toEqual(["line 1 'data': await flush(chunk)"]);
    expect(findUnguardedHandlerAwaits("socket.once('shell:attach', async () => { await attach(); });"))
      .toEqual(["line 1 'shell:attach': await attach()"]);
  });

  it('sees a parenthesized concise body rather than stepping over it', () => {
    // `parseCallbackAt` used to skip a second `(` after the `=>`, reading it as
    // a parameter list and jumping the whole body — so every await inside was
    // invisible and the handler passed green.
    expect(findUnguardedHandlerAwaits("socket.on('x', async () => (await boom()));"))
      .toEqual(["line 1 'x': await boom()"]);
  });

  it('reports the voice call handlers as guarded', () => {
    // The site that motivated the rule — pinned so a revert is caught here and
    // not only by the directory-wide scan.
    const src = readFileSync(join(HERE, 'voice.js'), 'utf8');
    expect(src).toContain("socket.on('voice:call:detach'");
    expect(findUnguardedHandlerAwaits(src)).toEqual([]);
  });
});
