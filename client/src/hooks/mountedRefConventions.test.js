/**
 * Repo-wide guard: `hooks/useMounted.js` is the only mounted-guard ref.
 *
 * Two rules, one bug class.
 *
 * ## 1. A mounted-guard ref must re-arm itself on mount
 *
 * The broken shape is a ref seeded `useRef(true)` whose ONLY assignment is
 * `false` in an effect cleanup:
 *
 *   const mountedRef = useRef(true);
 *   useEffect(() => () => { mountedRef.current = false; }, []);   // ← no setup body
 *
 * It reads as correct, and it is — in production. But the app runs under
 * `React.StrictMode` (`client/src/main.jsx`), and React's dev build mounts every
 * component as setup → cleanup → setup on the SAME instance. Refs survive that
 * cycle, so the cleanup flips the flag to `false` and nothing ever flips it back:
 * every `if (mountedRef.current) setX(...)` in the component is dead for the rest
 * of the dev session. That shipped as two user-visible freezes — MusicGenPanel
 * stuck on "Loading generators…" forever, and every `useAsyncAction` button stuck
 * in its disabled/spinner state after one click (#3264).
 *
 * The rule is deliberately shape-based rather than name-based — a ref called
 * `editorMountedRef` carries the identical bug, and one of the sites this guard
 * was written for was named exactly that.
 *
 * ## 2. Nothing may hand-inline `useMounted`'s body, even correctly
 *
 * `#3264` fixed fourteen sites that hand-rolled the guard *wrong*; thirteen more
 * hand-rolled it *right* and were therefore invisible to rule 1. Those thirteen
 * were the supply line: copying one of them and dropping the setup line
 * reproduces #3264 exactly, and several carried multi-line comments re-deriving
 * the StrictMode hazard from first principles — evidence the hazard was being
 * rediscovered per site instead of read off the hook name. So rule 2 rejects the
 * correct hand-roll too (#3266), leaving `useMounted()` as the only spelling.
 *
 * ## What this guard CANNOT see
 *
 * It is a source grep, not a scope-aware AST pass, so these semantically identical
 * shapes slip through. They are listed so the next person extending it knows where
 * the floor is rather than trusting a green run too far:
 *
 *   - `let`/`var` declarations (the pattern hardcodes `const`).
 *   - A non-literal seed: `const INIT = true; const r = useRef(INIT)`.
 *   - Two components in ONE file where A is correct and B is broken — rule 1's scan
 *     is file-scoped, so A's `= true` satisfies B. (Rule 2 is per-occurrence and
 *     unaffected.)
 *   - A ref created in one file and lowered in another (a hook returning its ref to
 *     a caller that writes `ref.current = false`).
 *   - Aliasing (`const g = mountedRef; g.current = false`), computed access
 *     (`ref['current']`), or assignment funneled through a setter function.
 *   - An assignment that only appears inside a comment (no comment stripping).
 *   - Rule 2 matches the hook's body verbatim (modulo whitespace), so a re-spelling
 *     — extra statements in either half, `||=`, a non-empty dep array, the cleanup
 *     before the setup — reads as "does more than useMounted" and is left to rule 1.
 *     That is the intended floor: rule 2 is aimed at the copy-paste, and a variant
 *     that still re-arms correctly is not the bug this file is chasing.
 *
 * Tightening any of these means moving to an AST pass; the shapes above are all
 * unusual enough in this codebase that the grep earns its keep as-is.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { trackedSourceFiles } from '../test/trackedFiles.js';

const CLIENT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// The one file allowed to contain the shape — it IS the shape.
const HOOK_FILE = 'src/hooks/useMounted.js';

// `const <name> = useRef(true)` — the seed value that marks a mounted-style guard.
// A ref seeded `useRef(false)` and raised to `true` on mount is a different (and
// correct) pattern, so it is intentionally out of scope.
const TRUE_SEEDED_REF = /const\s+([A-Za-z_$][\w$]*)\s*=\s*useRef\(\s*true\s*\)/g;

// Ref names may legally contain `$`, which is a regex anchor — interpolating one
// raw would silently make the pattern unmatchable and pass the offender.
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// `=` and `||=` both count as re-arming. Matching only `=` would report a ref
// re-armed with `ref.current ||= true` as broken — a false positive that would
// push someone to "fix" already-correct code.
const assignsRe = (name, value) => new RegExp(`\\b${escapeRe(name)}\\.current\\s*(?:\\|\\|)?=\\s*${value}\\b`);

// The body of `hooks/useMounted.js`, hand-inlined: an effect on an empty dep array
// whose setup does nothing but raise the ref and whose cleanup does nothing but
// lower it. `\s*` spans newlines, so the one-line and multi-line spellings both
// match. Anything with extra work in either half is a different effect and is left
// alone — see "What this guard CANNOT see".
const inlinedUseMountedRe = (name) => {
  const ref = `${escapeRe(name)}\\.current`;
  return new RegExp(
    `useEffect\\(\\s*\\(\\s*\\)\\s*=>\\s*\\{\\s*`
    + `${ref}\\s*=\\s*true\\s*;?\\s*`
    + `return\\s*\\(\\s*\\)\\s*=>\\s*\\{\\s*${ref}\\s*=\\s*false\\s*;?\\s*\\}\\s*;?\\s*`
    + `\\}\\s*,\\s*\\[\\s*\\]\\s*\\)`,
  );
};

/** Refs in `src` that are lowered to false but never re-raised to true. */
function findOneWayRefs(src) {
  const offenders = [];
  for (const match of src.matchAll(TRUE_SEEDED_REF)) {
    const name = match[1];
    if (assignsRe(name, 'false').test(src) && !assignsRe(name, 'true').test(src)) {
      offenders.push(name);
    }
  }
  return offenders;
}

/** Refs in `src` that re-implement `useMounted()` verbatim instead of calling it. */
function findInlinedUseMounted(src) {
  const offenders = [];
  for (const match of src.matchAll(TRUE_SEEDED_REF)) {
    const name = match[1];
    if (inlinedUseMountedRe(name).test(src)) offenders.push(name);
  }
  return offenders;
}

describe('mounted-guard refs re-arm on mount (StrictMode)', () => {
  it('has no ref that is only ever set to false', () => {
    const files = trackedSourceFiles(CLIENT_ROOT);
    // A broken `git ls-files` (wrong cwd, detached checkout) would otherwise make
    // this guard pass by scanning nothing at all.
    expect(files.length).toBeGreaterThan(100);

    const violations = [];
    for (const file of files) {
      const src = readFileSync(join(CLIENT_ROOT, file), 'utf8');
      for (const name of findOneWayRefs(src)) violations.push(`${file}: ${name}`);
    }

    expect(
      violations,
      'These refs are seeded `useRef(true)` and set to `false` on cleanup, but never '
      + 'back to `true` on setup. Under React.StrictMode the dev mount→cleanup→mount '
      + 'cycle reuses the same ref, so each one is permanently false after first mount '
      + 'and every setState it guards silently no-ops.\n'
      + 'Fix: replace the ref + its cleanup effect with `useMounted()` from '
      + '`client/src/hooks/useMounted.js`.\n'
      + `Offenders:\n  ${violations.join('\n  ')}`,
    ).toEqual([]);
  });

  // Guards the guard: if the detector stops recognizing the broken shape, the test
  // above goes vacuously green and the bug class walks straight back in.
  it('detects the broken shape and accepts every correct re-arm', () => {
    const broken = `
      const mountedRef = useRef(true);
      useEffect(() => () => { mountedRef.current = false; }, []);
    `;
    const brokenRenamed = `
      const editorMountedRef = useRef(true);
      useEffect(() => () => { editorMountedRef.current = false; }, []);
    `;
    // Re-arms correctly, so rule 1 passes it. (Rule 2 rejects it separately —
    // it is `useMounted`'s body inlined. See the second describe block.)
    const handRolled = `
      const mountedRef = useRef(true);
      useEffect(() => {
        mountedRef.current = true;
        return () => { mountedRef.current = false; };
      }, []);
    `;
    // `||=` re-arms just as well as `=`; flagging it would be a false positive.
    const fixedLogicalAssign = `
      const mountedRef = useRef(true);
      useEffect(() => {
        mountedRef.current ||= true;
        return () => { mountedRef.current = false; };
      }, []);
    `;
    // A ref that is never lowered has nothing to re-arm.
    const neverLowered = 'const readyRef = useRef(true);';

    expect(findOneWayRefs(broken)).toEqual(['mountedRef']);
    expect(findOneWayRefs(brokenRenamed)).toEqual(['editorMountedRef']);
    expect(findOneWayRefs(handRolled)).toEqual([]);
    expect(findOneWayRefs(fixedLogicalAssign)).toEqual([]);
    expect(findOneWayRefs(neverLowered)).toEqual([]);
  });
});

describe('mounted-guard refs call useMounted() instead of inlining it', () => {
  it('has no file re-implementing the hook', () => {
    const files = trackedSourceFiles(CLIENT_ROOT).filter((f) => f !== HOOK_FILE);
    expect(files.length).toBeGreaterThan(100);

    const violations = [];
    for (const file of files) {
      const src = readFileSync(join(CLIENT_ROOT, file), 'utf8');
      for (const name of findInlinedUseMounted(src)) violations.push(`${file}: ${name}`);
    }

    expect(
      violations,
      'These refs inline the exact body of `useMounted` instead of calling it. They '
      + 'work today, but they are how the #3264 freezes got written: copy one, drop '
      + 'the setup line, and the ref is permanently false under StrictMode.\n'
      + 'Fix: `const mountedRef = useMounted();` — import `useMounted` from '
      + '`client/src/hooks/useMounted.js` and delete the ref + its effect. If the '
      + 'effect also does real cleanup (clearTimeout, abort), keep THAT in its own '
      + '`useEffect` and move only the ref bookkeeping to the hook.\n'
      + `Offenders:\n  ${violations.join('\n  ')}`,
    ).toEqual([]);
  });

  // Guards the guard: the detector must still fire on the shape it exists to ban,
  // and must not fire on refs that merely happen to be seeded `true`.
  it('detects the inlined hook body and leaves other true-seeded refs alone', () => {
    const inlinedMultiline = `
      const mountedRef = useRef(true);
      useEffect(() => {
        mountedRef.current = true;
        return () => { mountedRef.current = false; };
      }, []);
    `;
    const inlinedOneLine = 'const m = useRef(true);'
      + 'useEffect(() => { m.current = true; return () => { m.current = false; }; }, []);';
    // The sanctioned form has no effect to match.
    const usesHook = 'const mountedRef = useMounted();';
    // A ref seeded `true` that is toggled as ordinary UI state (SongBook's
    // follow-the-playhead flag) is not a mounted guard and must not be flagged.
    const unrelatedToggle = `
      const followRef = useRef(true);
      const onPlay = () => { followRef.current = true; };
      const onPan = () => { followRef.current = false; };
    `;
    // Does strictly more than the hook — rule 1 already covers whether it re-arms.
    const doesExtraCleanup = `
      const mountedRef = useRef(true);
      useEffect(() => {
        mountedRef.current = true;
        return () => { mountedRef.current = false; clearTimeout(timerRef.current); };
      }, []);
    `;
    // The broken shape has no setup half, so only rule 1 owns it.
    const broken = `
      const mountedRef = useRef(true);
      useEffect(() => () => { mountedRef.current = false; }, []);
    `;

    expect(findInlinedUseMounted(inlinedMultiline)).toEqual(['mountedRef']);
    expect(findInlinedUseMounted(inlinedOneLine)).toEqual(['m']);
    expect(findInlinedUseMounted(usesHook)).toEqual([]);
    expect(findInlinedUseMounted(unrelatedToggle)).toEqual([]);
    expect(findInlinedUseMounted(doesExtraCleanup)).toEqual([]);
    expect(findInlinedUseMounted(broken)).toEqual([]);
  });

  // The hook itself is the one sanctioned copy — if the exclusion ever stops
  // matching (file moved/renamed), this fails instead of the guard going quiet.
  it('excludes the hook itself, and the hook still matches the banned shape', () => {
    expect(trackedSourceFiles(CLIENT_ROOT)).toContain(HOOK_FILE);
    const src = readFileSync(join(CLIENT_ROOT, HOOK_FILE), 'utf8');
    expect(findInlinedUseMounted(src)).toEqual(['mountedRef']);
  });
});
