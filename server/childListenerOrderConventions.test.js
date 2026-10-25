/**
 * Repo-wide guard: a spawned child must have its terminal listener attached
 * before the function next yields (#11761).
 *
 * ## The bug class
 *
 *   const child = spawn(cli, args);
 *   const scan = await securityScans.read(id);   // ← real file I/O
 *   child.on('error', onError);                  // ← too late
 *
 * Node reports a failed spawn (ENOENT, EACCES, EMFILE) through
 * `process.nextTick`, and a fast-dying child exits while the function is
 * suspended. An `error` with no listener THROWS and, outside the request
 * lifecycle, takes the process down; a `close`/`exit` with no listener is lost
 * and strands the job `running`. It shipped four times before this guard
 * (#4617, #5655, #5791, and the CoS Runner `/spawn` + `/spawn-tui` + local
 * image render sites of #11761).
 *
 * ## The rule
 *
 * In one function body, a `spawn(` / `pty.spawn(` / `spawnDetached(` result
 * bound to a name must, before the next `await`, have one of:
 *
 *   - `<name>.on('error', …)` (or `once` / `addListener` / `prependListener`),
 *   - `bufferChildExit(<name>, …)`,
 *   - `<name>.onExit(…)` (node-pty).
 *
 * The operand of that first `await` is evaluated before the function suspends,
 * so a listener attached inside it (`await new Promise((r) => child.on('error', r))`)
 * counts. A spawn with no `await` after it in its block has no yield window and
 * passes.
 *
 * There is no allowlist: a new violation is a bug to fix by moving the awaited
 * work BEFORE the spawn, or by calling `bufferChildExit(child)` in the same tick.
 *
 * ## What this guard CANNOT see
 *
 * Lexer-assisted, not scope-aware (see `lib/sourceScan.js`):
 *   - Only spawns bound by `name = spawn(…)` / `const name = await spawnDetached(…)`
 *     are tracked; a spawn passed straight into a helper or chained
 *     (`spawn(…).on(…)`) is not.
 *   - The scan stops at the end of the enclosing function body. It walks out of
 *     `try`/`if`/loop blocks (skipping a `try`'s `catch`) but not out of object
 *     literals or callbacks, where it conservatively reports nothing.
 *   - Awaits inside a nested `async` function body are not the spawning
 *     function's yield point and are skipped.
 */
import { trackedFiles } from '../scripts/lib/trackedFiles.js';

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { blankLiterals, matchBracket, parseCallbackAt } from './lib/sourceScan.js';

const SERVER_ROOT = dirname(fileURLToPath(import.meta.url));

// `name = [await] [ns.]spawn|spawnDetached(`. `spawnSync` is excluded on purpose:
// it returns after the child exits and emits nothing.
const SPAWN_BINDING = /([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*=\s*(?:await\s+)?(?:[A-Za-z_$][\w$]*\.)?(?:spawn|spawnDetached)\s*\(/g;

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `[start, end)` of every nested async function body in `blanked`. */
function asyncBodySpans(blanked) {
  const spans = [];
  for (const match of blanked.matchAll(/\basync\b/g)) {
    // Arrow / `async function` spelling.
    const parsed = parseCallbackAt(blanked, match.index, blanked.length);
    if (parsed && blanked[parsed.start] === '{') {
      spans.push([parsed.start, parsed.start + parsed.text.length]);
      continue;
    }
    // Method spelling: `async name(params) {`.
    const method = /^async\s+[\w$]+\s*\(/.exec(blanked.slice(match.index, match.index + 200));
    if (!method) continue;
    const paramsEnd = matchBracket(blanked, match.index + method[0].length - 1);
    if (paramsEnd === -1) continue;
    const open = blanked.slice(paramsEnd).search(/\S/);
    if (open === -1 || blanked[paramsEnd + open] !== '{') continue;
    const end = matchBracket(blanked, paramsEnd + open);
    if (end !== -1) spans.push([paramsEnd + open, end]);
  }
  return spans;
}

/** Index of the `{` that opens the innermost block containing `pos`, or -1. */
function enclosingOpen(blanked, pos) {
  let depth = 0;
  for (let i = pos - 1; i >= 0; i -= 1) {
    if (blanked[i] === '}') depth += 1;
    else if (blanked[i] === '{') {
      if (depth === 0) return i;
      depth -= 1;
    }
  }
  return -1;
}

/**
 * Whether the block opened at `open` is a control block of the SAME function
 * (`try`, `catch`, `finally`, `if`, `else`, loops) rather than a function body or
 * object literal. Returns 'try' for a try block so its catch clause can be skipped.
 */
function controlBlockKind(blanked, open) {
  const before = blanked.slice(0, open).trimEnd();
  if (/\btry$/.test(before)) return 'try';
  if (/\b(?:else|finally|do)$/.test(before)) return 'control';
  if (!before.endsWith(')')) return null;
  let depth = 0;
  for (let i = before.length - 1; i >= 0; i -= 1) {
    if (before[i] === ')') depth += 1;
    else if (before[i] === '(') {
      depth -= 1;
      if (depth === 0) {
        return /\b(?:if|for|while|switch|catch)(?:\s+await)?\s*$/.test(before.slice(0, i)) ? 'control' : null;
      }
    }
  }
  return null;
}

/**
 * Index of the first `await` after `from` that belongs to the spawning function,
 * or -1 when none follows before the function body ends. Leaving a `try`/`if`/loop
 * block keeps scanning (the spawn is commonly bound inside a `try`), and a
 * `catch` clause is skipped: it only runs when the spawn itself threw.
 */
function nextAwait(blanked, from, spans) {
  let depth = 0;
  let scope = from;
  for (let i = from; i < blanked.length; i += 1) {
    // Only bodies that OPEN after the spawn are nested; the enclosing async
    // function itself starts before it and its awaits are the ones that count.
    const span = spans.find(([start, end]) => start >= from && i >= start && i < end);
    if (span) { i = span[1] - 1; continue; }
    const c = blanked[i];
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth < 0) {
        const open = enclosingOpen(blanked, scope);
        const kind = open === -1 ? null : controlBlockKind(blanked, open);
        if (!kind) return -1;
        scope = open;
        depth = 0;
        const clause = kind === 'try' ? /^\s*catch\b\s*(?:\([^)]*\))?\s*\{/.exec(blanked.slice(i + 1)) : null;
        if (clause) i = matchBracket(blanked, i + clause[0].length) - 1;
      }
    } else if (c === 'a' && blanked.startsWith('await', i)
      && !/[\w$]/.test(blanked[i - 1] || '') && !/[\w$]/.test(blanked[i + 5] || '')) {
      return i;
    }
  }
  return -1;
}

/** End of the expression an `await` at `awaitIndex` operates on (the `;` or closing bracket). */
function awaitOperandEnd(blanked, awaitIndex) {
  let depth = 0;
  for (let i = awaitIndex + 5; i < blanked.length; i += 1) {
    const c = blanked[i];
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') {
      depth -= 1;
      if (depth < 0) return i;
    } else if (c === ';' && depth === 0) return i;
  }
  return blanked.length;
}

/** Every spawned-child binding in one file's source that awaits before wiring a terminal listener. */
export function findLateChildListeners(src) {
  const { code, blanked } = blankLiterals(src, { includeCommentOnly: true });
  // `code` keeps literal text, so `'error'` is still readable; `blanked` is what
  // await/bracket walks use.
  const spans = asyncBodySpans(blanked);
  const offenders = [];
  for (const match of blanked.matchAll(SPAWN_BINDING)) {
    const name = match[1];
    const callEnd = matchBracket(blanked, match.index + match[0].length - 1);
    if (callEnd === -1) continue;
    const awaitAt = nextAwait(blanked, callEnd, spans);
    if (awaitAt === -1) continue;
    const window = code.slice(callEnd, awaitOperandEnd(blanked, awaitAt));
    const n = escapeRe(name);
    const attached = new RegExp(
      `\\b${n}\\.(?:on|once|addListener|prependListener)\\(\\s*['"\`]error['"\`]`
      + `|\\bbufferChildExit\\(\\s*${n}\\b`
      + `|\\b${n}\\.onExit\\(`,
    ).test(window);
    if (attached) continue;
    const line = blanked.slice(0, match.index).split('\n').length;
    const awaited = blanked.slice(awaitAt, awaitOperandEnd(blanked, awaitAt)).replace(/\s+/g, ' ').trim();
    offenders.push(`line ${line}: ${name} is awaited past (${awaited.slice(0, 80)}) before an error/exit listener`);
  }
  return offenders;
}

const trackedServerSources = () => trackedFiles(SERVER_ROOT, ['*.js', '*.mjs', '*.cjs']).filter((f) => f && !f.includes('.test.'));

describe('spawned children get a terminal listener before the next await (#11761)', () => {
  it('scans the server tree, every module extension included', () => {
    const files = trackedServerSources();
    expect(files.length).toBeGreaterThan(200);
    expect(files.some((f) => f.endsWith('.mjs'))).toBe(true);
  });

  it('still recognizes the spawn sites it is meant to guard', () => {
    // Without this the scan below could go vacuously green after a refactor
    // renames the spawn helpers.
    const sites = trackedServerSources().filter((file) => {
      const src = readFileSync(join(SERVER_ROOT, file), 'utf8');
      return /\b(?:spawn|spawnDetached)\s*\(/.test(src) && [...blankLiterals(src).matchAll(SPAWN_BINDING)].length > 0;
    });
    expect(sites).toEqual(expect.arrayContaining([
      'cos-runner/index.js',
      'services/imageGen/local.js',
      'services/videoGen/spawnWatch.js',
    ]));
  });

  it('has no spawn whose listener waits behind an await', () => {
    const violations = [];
    for (const file of trackedServerSources()) {
      const src = readFileSync(join(SERVER_ROOT, file), 'utf8');
      if (!src.includes('spawn')) continue;
      for (const hit of findLateChildListeners(src)) violations.push(`server/${file} ${hit}`);
    }
    expect(
      violations,
      'These children are spawned and then the function awaits before any error/exit listener is '
      + 'attached. Node reports a failed spawn on process.nextTick and a fast-dying child exits '
      + 'during the await: an unlistened `error` throws and kills the process, an unlistened '
      + '`close` strands the job running (#4617, #5655, #5791, #11761).\n'
      + 'Fix: do the awaited work BEFORE the spawn, or call `bufferChildExit(child)` (videoGen/'
      + 'generateVideoHelpers.js) in the same tick and replay its result once the real handlers are on.\n'
      + `Offenders:\n  ${violations.join('\n  ')}`,
    ).toEqual([]);
  });
});

// Guards the guard: if the recognizer stops seeing the broken shape, the scan
// above goes green and the bug class walks straight back in.
describe('the child-listener-order recognizer', () => {
  it('flags the pre-fix CoS Runner /spawn shape', () => {
    expect(findLateChildListeners(`
      const claudeProcess = spawn(cmd, args, { cwd });
      const agent = {
        process: claudeProcess,
        securityScan: await securityScans.read(agentId),
      };
      claudeProcess.on('error', (err) => {});
    `)).toHaveLength(1);
  });

  it('flags the pre-fix /spawn-tui shape (pty.spawn, exit subscribed after the read)', () => {
    expect(findLateChildListeners(`
      tuiProcess = pty.spawn(ptyCommand, ptyArgs, { cwd });
      const agent = { securityScan: await securityScans.read(agentId) };
      tuiProcess.onExit(handler);
    `)).toHaveLength(1);
  });

  it('flags the pre-fix local image shape (handoff awaited before listeners)', () => {
    expect(findLateChildListeners(`
      try {
        proc = spawn(bin, args, opts);
        activeProcess = proc;
        await heavyClaim.handoffTo?.(proc.pid);
      } catch (err) { throw err; }
      proc.on('error', onError);
    `)).toHaveLength(1);
  });

  it('flags a spawnDetached result that waits and a member-bound child', () => {
    expect(findLateChildListeners(`
      firstProc = await spawnDetached(bin, args);
      await claim.handoffTo(firstProc.pid);
      firstProc.on('error', onError);
    `)).toHaveLength(1);
    expect(findLateChildListeners(`
      state.child = spawn(bin);
      await prepare();
      state.child.on('error', onError);
    `)).toHaveLength(1);
  });

  it('walks out of a try block but skips its catch clause', () => {
    expect(findLateChildListeners(`
      try {
        child = spawn(bin);
      } catch (err) {
        await cleanup();
        throw err;
      }
      child.on('error', onError);
    `)).toEqual([]);
    expect(findLateChildListeners(`
      try {
        child = spawn(bin);
      } catch (err) {
        throw err;
      }
      await prepare();
      child.on('error', onError);
    `)).toHaveLength(1);
  });

  it('treats an unrelated error listener on another object as no listener', () => {
    expect(findLateChildListeners(`
      const child = spawn(bin);
      other.on('error', noop);
      await prepare();
      child.on('error', onError);
    `)).toHaveLength(1);
  });

  it('accepts a listener, bufferChildExit or onExit attached before the await', () => {
    expect(findLateChildListeners(`
      const child = spawn(bin);
      child.on('error', onError);
      await prepare();
    `)).toEqual([]);
    expect(findLateChildListeners(`
      proc = spawn(bin);
      const take = bufferChildExit(proc, { bufferOutput: true });
      await heavyClaim.handoffTo?.(proc.pid);
    `)).toEqual([]);
    expect(findLateChildListeners(`
      const pty1 = pty.spawn(cmd, args);
      pty1.onExit(handler);
      await prepare();
    `)).toEqual([]);
    expect(findLateChildListeners(`
      const child = spawn(bin);
      child.once("error", onError);
      await prepare();
    `)).toEqual([]);
  });

  it('accepts a listener attached inside the first await operand', () => {
    expect(findLateChildListeners(`
      const child = spawn(bin);
      await new Promise((resolve, reject) => {
        child.on('error', reject);
        child.on('close', resolve);
      });
    `)).toEqual([]);
  });

  it('accepts a spawn with no await after it in its block', () => {
    expect(findLateChildListeners(`
      async function run() {
        await prepare();
        const child = spawn(bin);
        child.stdout.on('data', onData);
        child.on('error', onError);
      }
      async function other() { await somethingElse(); }
    `)).toEqual([]);
  });

  it('ignores awaits inside a nested async function and in comments or strings', () => {
    expect(findLateChildListeners(`
      const child = spawn(bin);
      // await prepare();
      const note = 'await prepare()';
      const later = async () => { await prepare(); };
      child.on('error', onError);
    `)).toEqual([]);
  });

  it('does not treat spawnSync or a plain assignment named like spawn as a spawn', () => {
    expect(findLateChildListeners(`
      const result = spawnSync(bin);
      const respawn = respawnCount + 1;
      await prepare();
    `)).toEqual([]);
  });
});
