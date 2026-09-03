// @vitest-environment node

/**
 * Repo-wide guard: no local binding shadows a global whose shadowing fails silently.
 *
 * `CreateLoopForm` held `const [interval, setInterval] = useState('10m')` (#5728),
 * and `RunnerPage` held `const [timeout, setTimeout] = useState(30)`. Either one
 * shadows the timer API for the whole component body, so a timer added to that
 * component later — a countdown, a debounce, a poll — calls the React state
 * setter with a function and a number instead of scheduling anything. Nothing
 * throws: `setTimeout(fn, 1000)` just stores `fn` as the timeout value and
 * re-renders. `ReferenceReposPanel` had the same shape with `const fetch =
 * useCallback(...)`, which turns a stray `fetch(url)` into a zero-arg reload.
 *
 * That failure mode — a call that compiles, runs, and does the wrong thing with
 * no error — is what scopes the list below. It is deliberately NOT "every
 * global": `const [open, setOpen]`, `const [status, setStatus]`, and
 * `const [name, setName]` appear in dozens of components and are idiomatic
 * React. They shadow `window.open` / `window.status` / `window.name`, but
 * nothing in this tree calls those bare, and banning them would buy an
 * allowlist longer than the rule. The names here are the ones that are
 * routinely called as bare functions in view code, so shadowing one is a live
 * trap rather than a naming quibble.
 *
 * ## What this guard CANNOT see
 *
 * It is a source scan, not an AST pass:
 *   - Function parameters and `catch` bindings are not checked, only
 *     `const` / `let` / `var` declarations (including destructuring).
 *   - A banned name written only inside a comment or a template literal that
 *     happens to match a declaration shape would count.
 *   - Re-assignment of an import alias to a banned name is invisible.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { trackedSourceFiles } from './test/trackedFiles.js';

const CLIENT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Globals that view code calls bare, so a same-named local binding silently
 * redirects the call instead of failing. Keep this list to that property —
 * a global nobody calls unqualified belongs in a lint rule, not here.
 */
const BANNED = new Set([
  'setInterval',
  'clearInterval',
  'setTimeout',
  'clearTimeout',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'fetch',
]);

/** `const foo =`, `let foo`, `var foo` — a plain (non-destructured) binding. */
const PLAIN_DECL = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[=;]/g;

/** `const [a, b] = …` / `const { a, b: c } = …` — the destructuring head. */
const DESTRUCTURED_DECL = /\b(?:const|let|var)\s*([[{][^\]}]*[\]}])\s*=/g;

/**
 * Names a destructuring pattern actually binds. For `{ a: b }` that is `b`, not
 * `a` — renaming an incoming `fetch` field to something else is the fix, not
 * the violation, so keying on the left half would report it backwards.
 */
function boundNames(pattern) {
  return pattern
    .slice(1, -1)
    .split(',')
    .map((part) => part.split(':').pop())
    .map((part) => part.replace(/=.*$/s, ''))
    .map((part) => part.replace(/^\s*\.\.\./, '').trim())
    .filter((part) => /^[A-Za-z_$][\w$]*$/.test(part));
}

/** Every banned global a source declares as a local binding. */
function shadowedGlobals(source) {
  const found = new Set();
  for (const [, name] of source.matchAll(PLAIN_DECL)) {
    if (BANNED.has(name)) found.add(name);
  }
  for (const [, pattern] of source.matchAll(DESTRUCTURED_DECL)) {
    for (const name of boundNames(pattern)) {
      if (BANNED.has(name)) found.add(name);
    }
  }
  return [...found];
}

describe('no local binding shadows a silently-failing global', () => {
  it('has no shadowed timer or fetch global in client/src', () => {
    const files = trackedSourceFiles(CLIENT_ROOT);
    // A broken `git ls-files` (wrong cwd, detached checkout) would otherwise
    // make this guard pass by scanning nothing at all.
    expect(files.length).toBeGreaterThan(100);

    const violations = files
      .map((file) => [file, shadowedGlobals(readFileSync(join(CLIENT_ROOT, file), 'utf8'))])
      .filter(([, names]) => names.length > 0)
      .map(([file, names]) => `${file}: ${names.join(', ')}`);

    expect(
      violations,
      'These files bind a global that view code calls bare, so the next call to it '
      + 'in the same scope silently hits the local instead — no error, no throw.\n'
      + 'Fix: rename the binding for what it holds (`intervalPreset` / '
      + '`timeoutMinutes` / `loadRefs`), not for the API it collides with.\n'
      + 'There is deliberately no allowlist: every one of these names has a better '
      + `local name.\nOffenders:\n  ${violations.join('\n  ')}`,
    ).toEqual([]);
  });

  // Guards the guard: a detector that stopped recognizing the shape would make
  // the scan above vacuously green and let the bug class walk back in.
  it('recognizes a shadowing declaration in each of its forms', () => {
    expect(shadowedGlobals("const [interval, setInterval] = useState('10m');")).toEqual(['setInterval']);
    expect(shadowedGlobals('const [timeout, setTimeout] = useState(30);')).toEqual(['setTimeout']);
    expect(shadowedGlobals('const fetch = useCallback(async () => {}, []);')).toEqual(['fetch']);
    expect(shadowedGlobals('let clearTimeout;')).toEqual(['clearTimeout']);
    expect(shadowedGlobals('const { fetch } = window;')).toEqual(['fetch']);
    // Renaming an incoming field OUT of the collision is the fix, not a violation.
    expect(shadowedGlobals('const { fetch: doFetch } = window;')).toEqual([]);
    // …and renaming one INTO the collision still is one.
    expect(shadowedGlobals('const { load: fetch } = deps;')).toEqual(['fetch']);
  });

  it('leaves non-shadowing code alone', () => {
    expect(shadowedGlobals("const [intervalPreset, setIntervalPreset] = useState('10m');")).toEqual([]);
    expect(shadowedGlobals('const [timeoutMinutes, setTimeoutMinutes] = useState(30);')).toEqual([]);
    expect(shadowedGlobals('const loadRefs = useCallback(async () => {}, []);')).toEqual([]);
    // Calling the real global is the whole point of keeping the name free.
    expect(shadowedGlobals('const t = setTimeout(run, 1000);')).toEqual([]);
    expect(shadowedGlobals('clearTimeout(t);')).toEqual([]);
    // Idiomatic React state deliberately outside the list — see the header.
    expect(shadowedGlobals('const [open, setOpen] = useState(false);')).toEqual([]);
    expect(shadowedGlobals('const [status, setStatus] = useState(null);')).toEqual([]);
    expect(shadowedGlobals('const [name, setName] = useState("");')).toEqual([]);
  });
});
