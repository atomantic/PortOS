// @vitest-environment node
// test-memo: never (tree-wide scanner)

/**
 * Rule: Use `hooks/useMounted.js` instead of hand-rolling a `useRef(true)` mounted-guard ref (StrictMode double-mounts leave un-rearmed refs stuck `false`).
 * Fix: Replace the `useRef(true)` + `useEffect` cleanup with `useMounted()`, moving any other cleanup into its own `useEffect`.
 * What this guard cannot see:
 *   - `let`/`var` declarations, non-literal seeds (`useRef(INIT)`), or refs lowered in another file.
 *   - Two components in one file where A re-arms and B does not (rule 1 is file-scoped).
 *   - Aliasing (`const g = mountedRef`), computed access (`ref['current']`), or assignments in helpers.
 *   - Comments/strings/regexes are not stripped: comments count as assignments, and unbalanced parens skew rule 2's walk.
 *   - Raise and lower split across two `useEffect` calls bypasses rule 2.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { trackedSourceFiles } from '../test/trackedFiles.js';
import { escapeRegExp } from '../lib/textUtils.js';

const CLIENT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let trackedFilesCache;
const trackedClientSources = () => (trackedFilesCache ??= trackedSourceFiles(CLIENT_ROOT));

let scanCache;
function scanTree() {
  if (scanCache) return scanCache;
  const oneWayViolations = [];
  const inlinedHookViolations = [];

  for (const file of trackedClientSources()) {
    const src = readFileSync(join(CLIENT_ROOT, file), 'utf8');
    if (!src.includes('useRef')) continue;

    for (const name of findOneWayRefs(src)) {
      oneWayViolations.push(`${file}: ${name}`);
    }
    if (file !== HOOK_FILE) {
      for (const name of findInlinedUseMounted(src)) {
        inlinedHookViolations.push(`${file}: ${name}`);
      }
    }
  }

  scanCache = { oneWayViolations, inlinedHookViolations };
  return scanCache;
}

afterAll(() => {
  scanCache = undefined;
  trackedFilesCache = undefined;
});

// The one file allowed to contain the shape — it IS the shape.
const HOOK_FILE = 'src/hooks/useMounted.js';

// `const <name> = useRef(true)` — the seed value that marks a mounted-style guard.
// A ref seeded `useRef(false)` and raised to `true` on mount is a different (and
// correct) pattern, so it is intentionally out of scope.
const TRUE_SEEDED_REF = /const\s+([A-Za-z_$][\w$]*)\s*=\s*useRef\(\s*true\s*\)/g;

// `=` and `||=` both count as re-arming. Matching only `=` would report a ref
// re-armed with `ref.current ||= true` as broken — a false positive that would
// push someone to "fix" already-correct code. The name is escaped because ref
// names may legally contain `$`, which is a regex anchor — interpolating one raw
// would silently make the pattern unmatchable and pass the offender.
const assignsRe = (name, value) => new RegExp(`\\b${escapeRegExp(name)}\\.current\\s*(?:\\|\\|)?=\\s*${value}\\b`);

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
    const files = trackedClientSources();
    // A broken `git ls-files` (wrong cwd, detached checkout) would otherwise make
    // this guard pass by scanning nothing at all.
    expect(files.length).toBeGreaterThan(100);

    const violations = scanTree().oneWayViolations;

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
    const files = trackedClientSources().filter((f) => f !== HOOK_FILE);
    expect(files.length).toBeGreaterThan(100);

    const violations = scanTree().inlinedHookViolations;

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

  // The paren walk is the part most likely to be "simplified" into a regex later,
  // so pin the case that breaks one: an effect body with its own nested calls.
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

  // The known lexical blind spot, pinned rather than described. The walk counts
  // every paren, so an unbalanced one inside a string or comment closes the slice
  // early and the guard reads a truncated effect. Closing this means lexing JS,
  // which is the AST-pass threshold the file docblock draws; until someone crosses
  // it, this fixture is what tells the next reader the boundary is known and where
  // it sits. If a future change DOES make the walk lexical, this test fails —
  // flip it to `['mountedRef']` and drop the caveat from the docblock.
  it('is defeated by an unbalanced paren inside a string (known floor)', () => {
    const evadesTheWalk = `
      const mountedRef = useRef(true);
      useEffect(() => {
        log(')');
        mountedRef.current = true;
        return () => { mountedRef.current = false; };
      }, []);
    `;
    expect(findInlinedUseMounted(evadesTheWalk)).toEqual([]);
  });

  // The hook itself is the one sanctioned copy — if the exclusion ever stops
  // matching (file moved/renamed), this fails instead of the guard going quiet.
  it('excludes the hook itself, and the hook still matches the banned shape', () => {
    expect(trackedClientSources()).toContain(HOOK_FILE);
    const src = readFileSync(join(CLIENT_ROOT, HOOK_FILE), 'utf8');
    expect(findInlinedUseMounted(src)).toEqual(['mountedRef']);
  });
});
