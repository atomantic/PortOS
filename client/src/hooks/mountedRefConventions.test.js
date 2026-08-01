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
 * ## 2. Nothing may hand-roll the guard at all, even correctly
 *
 * `#3264` fixed fourteen sites that hand-rolled the guard *wrong*; thirteen more
 * hand-rolled it *right* and were therefore invisible to rule 1. Those thirteen
 * were the supply line: copying one of them and dropping the setup line
 * reproduces #3264 exactly, and several carried multi-line comments re-deriving
 * the StrictMode hazard from first principles — evidence the hazard was being
 * rediscovered per site instead of read off the hook name. So rule 2 rejects the
 * correct hand-roll too (#3266), leaving `useMounted()` as the only spelling.
 *
 * Rule 2 keys on the *behavior* — one effect that raises a `useRef(true)` and then
 * lowers it — not on the hook's characters. A rule that matched the body verbatim
 * would be defeated by any re-spelling (`||=`, a concise cleanup arrow, a non-empty
 * dep array, a `clearTimeout` next to the flag), and the last of those is exactly
 * the form `Ask.jsx` and `ReactionTimeRunner` were in before #3266. The fix there
 * is the general one: the real cleanup moves to its own effect, and only the ref
 * bookkeeping becomes `useMounted()`.
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
 *     is file-scoped, so A's `= true` satisfies B. (Rule 2 is per-effect, so A's
 *     effect can't vouch for B's.)
 *   - A ref created in one file and lowered in another (a hook returning its ref to
 *     a caller that writes `ref.current = false`).
 *   - Aliasing (`const g = mountedRef; g.current = false`), computed access
 *     (`ref['current']`), or assignment funneled through a setter function.
 *   - An assignment that only appears inside a comment or a string (no comment
 *     stripping), which also means a `(` inside one can skew rule 2's brace walk.
 *   - Rule 2 requires the raise and the lower in the SAME `useEffect` call. Split
 *     across two effects, or funneled through a helper the effect calls, it reads
 *     as ordinary ref use and only rule 1 applies.
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

const USE_EFFECT_OPEN = /\buseEffect\s*\(/g;

/**
 * Text between the `(` at `open` and its matching `)`. A fixed char window or a
 * lazy `[^)]*` would stop at the first `)` inside the effect — every real effect
 * has several — and inspect a truncated body, so the walk counts depth instead.
 * Returns null on an unbalanced run (a truncated file), which reads as "nothing
 * to inspect" rather than a silent partial match.
 */
function balancedArgs(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '(') depth += 1;
    else if (src[i] === ')') {
      depth -= 1;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return null;
}

/** The full argument text (callback + deps) of every `useEffect(...)` in `src`. */
function effectCalls(src) {
  const calls = [];
  for (const match of src.matchAll(USE_EFFECT_OPEN)) {
    const args = balancedArgs(src, match.index + match[0].length - 1);
    if (args !== null) calls.push(args);
  }
  return calls;
}

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

/**
 * Refs in `src` whose mount bookkeeping is hand-rolled instead of delegated to
 * `useMounted()`: a `useRef(true)` that ONE effect raises and then lowers.
 *
 * Matching on that ordered pair rather than on the hook's body verbatim is what
 * makes the rule hold up. Every re-spelling of the same guard — `||=`, a concise
 * cleanup arrow, a non-empty dep array, extra work alongside the flag in either
 * half — still raises before it lowers inside one effect, so all of them are
 * caught. Two effects that happen to touch the same ref are not: the lower must
 * appear inside the same call as the raise.
 */
function findInlinedUseMounted(src) {
  const offenders = [];
  const calls = effectCalls(src);
  for (const match of src.matchAll(TRUE_SEEDED_REF)) {
    const name = match[1];
    if (offenders.includes(name)) continue;
    const raise = assignsRe(name, 'true');
    const lower = assignsRe(name, 'false');
    const handRolled = calls.some((call) => {
      const raisedAt = call.search(raise);
      // Raise in the setup half, lower after it (the cleanup) — in that order.
      return raisedAt !== -1 && call.search(lower) > raisedAt;
    });
    if (handRolled) offenders.push(name);
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
      'These refs hand-roll `useMounted` — one effect raises the flag on setup and '
      + 'lowers it on cleanup — instead of calling it. They work today, but they are '
      + 'how the #3264 freezes got written: copy one, drop the setup line, and the '
      + 'ref is permanently false under StrictMode.\n'
      + 'Fix: `const mountedRef = useMounted();` — import `useMounted` from '
      + '`client/src/hooks/useMounted.js` and delete the ref + its effect. If the '
      + 'effect also does real cleanup (clearTimeout, abort), keep THAT in its own '
      + '`useEffect` and move only the ref bookkeeping to the hook.\n'
      + `Offenders:\n  ${violations.join('\n  ')}`,
    ).toEqual([]);
  });

  // Guards the guard, in both directions. A detector that only knew the hook's
  // exact characters would be trivially defeated by re-spelling it, so every
  // re-spelling that still raises-then-lowers is asserted caught here.
  it('catches every re-spelling of the hand-rolled guard', () => {
    const verbatim = `
      const mountedRef = useRef(true);
      useEffect(() => {
        mountedRef.current = true;
        return () => { mountedRef.current = false; };
      }, []);
    `;
    const oneLine = 'const m = useRef(true);'
      + 'useEffect(() => { m.current = true; return () => { m.current = false; }; }, []);';
    const logicalAssign = `
      const mountedRef = useRef(true);
      useEffect(() => {
        mountedRef.current ||= true;
        return () => { mountedRef.current = false; };
      }, []);
    `;
    const conciseCleanup = `
      const mountedRef = useRef(true);
      useEffect(() => {
        mountedRef.current = true;
        return () => (mountedRef.current = false);
      }, []);
    `;
    // The pre-#3266 shape in Ask.jsx / ReactionTimeRunner: real cleanup work
    // alongside the flag. Still a hand-rolled guard — the fix is to split the
    // real work into its own effect, which is what this PR did.
    const extraCleanup = `
      const mountedRef = useRef(true);
      useEffect(() => {
        mountedRef.current = true;
        return () => { mountedRef.current = false; abortRef.current?.abort(); };
      }, []);
    `;
    const nonEmptyDeps = `
      const mountedRef = useRef(true);
      useEffect(() => {
        mountedRef.current = true;
        return () => { mountedRef.current = false; };
      }, [jobId]);
    `;

    expect(findInlinedUseMounted(verbatim)).toEqual(['mountedRef']);
    expect(findInlinedUseMounted(oneLine)).toEqual(['m']);
    expect(findInlinedUseMounted(logicalAssign)).toEqual(['mountedRef']);
    expect(findInlinedUseMounted(conciseCleanup)).toEqual(['mountedRef']);
    expect(findInlinedUseMounted(extraCleanup)).toEqual(['mountedRef']);
    expect(findInlinedUseMounted(nonEmptyDeps)).toEqual(['mountedRef']);
  });

  it('leaves refs that are not hand-rolled mount guards alone', () => {
    // The sanctioned form has no effect to match.
    const usesHook = 'const mountedRef = useMounted();';
    // A ref seeded `true` that is toggled as ordinary UI state (SongBook's
    // follow-the-playhead flag) is not a mount guard and must not be flagged.
    const unrelatedToggle = `
      const followRef = useRef(true);
      const onPlay = () => { followRef.current = true; };
      const onPan = () => { followRef.current = false; };
    `;
    // Raise and lower in SEPARATE effects is not the copy-paste this rule bans;
    // requiring both inside one call is what keeps the two cases apart.
    const separateEffects = `
      const activeRef = useRef(true);
      useEffect(() => { activeRef.current = true; }, [id]);
      useEffect(() => () => { activeRef.current = false; }, []);
    `;
    // Lowered first, raised after — a re-entrancy latch, not a mount guard.
    const lowerThenRaise = `
      const idleRef = useRef(true);
      useEffect(() => {
        idleRef.current = false;
        return () => { idleRef.current = true; };
      }, [busy]);
    `;
    // The broken shape has no setup half, so rule 1 owns it exclusively.
    const broken = `
      const mountedRef = useRef(true);
      useEffect(() => () => { mountedRef.current = false; }, []);
    `;

    expect(findInlinedUseMounted(usesHook)).toEqual([]);
    expect(findInlinedUseMounted(unrelatedToggle)).toEqual([]);
    expect(findInlinedUseMounted(separateEffects)).toEqual([]);
    expect(findInlinedUseMounted(lowerThenRaise)).toEqual([]);
    expect(findInlinedUseMounted(broken)).toEqual([]);
  });

  // The brace/paren walk is the part most likely to be "simplified" into a regex
  // later, so pin the case that breaks one: an effect body with its own calls.
  it('reads the whole effect, not up to the first inner close-paren', () => {
    const parensBeforeCleanup = `
      const mountedRef = useRef(true);
      useEffect(() => {
        mountedRef.current = true;
        load(runId).then((res) => setRows(res.rows));
        return () => { mountedRef.current = false; };
      }, []);
    `;
    expect(findInlinedUseMounted(parensBeforeCleanup)).toEqual(['mountedRef']);
  });

  // The hook itself is the one sanctioned copy — if the exclusion ever stops
  // matching (file moved/renamed), this fails instead of the guard going quiet.
  it('excludes the hook itself, and the hook still matches the banned shape', () => {
    expect(trackedSourceFiles(CLIENT_ROOT)).toContain(HOOK_FILE);
    const src = readFileSync(join(CLIENT_ROOT, HOOK_FILE), 'utf8');
    expect(findInlinedUseMounted(src)).toEqual(['mountedRef']);
  });
});
