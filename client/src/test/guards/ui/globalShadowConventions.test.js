/**
 * Rule: No local `const`/`let`/`var` binding may shadow a bare-called global (`setTimeout`, `setInterval`, `fetch`, etc.).
 * Fix: Rename the local binding (e.g. `pollInterval`, `fetchItems`).
 * What this guard cannot see:
 *   - Function parameters, `catch` bindings, and re-assignment of an import alias to a banned name.
 *   - Banned names in comments or template literals matching a declaration shape still count.
 */

import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { trackedSourceFiles } from '../../trackedFiles.js';
import { readText, REPO_ROOT } from '../../../../../scripts/lib/guardCorpus.js';

const CLIENT_ROOT = join(REPO_ROOT, 'client');

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
      .map((file) => [file, shadowedGlobals(readText(join(CLIENT_ROOT, file)))])
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
