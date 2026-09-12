// @vitest-environment node

/**
 * Repo-wide guard: an async effect keyed to a switchable identity must drop a
 * superseded response.
 *
 * The broken shape is an effect that fetches on a dependency and writes the
 * answer straight into state:
 *
 *   useEffect(() => {
 *     loadBible(work.id).then(setCharacters);   // ← no disposal guard
 *   }, [work.id]);
 *
 * Switch work A → work B faster than the first request resolves and A's answer
 * lands after B's, so B is displayed holding A's records. `useMounted()` does
 * NOT cover this — the component never unmounted, only its subject changed —
 * which is exactly why this guard exists alongside
 * `hooks/mountedRefConventions.test.js` rather than inside it.
 *
 * It is not always a transient flicker. `WorkEditor` passed its bible lists
 * down as controlled props, and `BibleSection` returns early rather than
 * refetching when it receives them, so nothing re-read the server: the wrong
 * characters and places stayed until the user manually re-ran an extraction,
 * and in the meantime enriched the image-gen prompts behind persisted
 * storyboard renders. Issues #6996, #6997, #6998, #6999 and #7000 were each
 * filed and fixed as one site of this same class; #7242 swept the rest and
 * added this test, because fixing them one at a time never stopped new ones
 * from landing.
 *
 * ## The sanctioned fixes
 *
 * Three shapes count as a guard, matched on structure rather than on a name —
 * the tree spells the flag `active`, `cancelled`, `canceled`, `live`, `current`
 * and `ignore`, and a rule keyed to that list would be defeated by the next
 * synonym:
 *
 *   1. **A local flip flag** — the dominant idiom, ~150 files:
 *      `let active = true;` … `if (active) setX(v);` … `return () => { active = false; };`
 *   2. **A request-generation ref** — for an effect whose response must be
 *      matched against the LATEST request rather than merely dropped:
 *      `const gen = ++genRef.current;` … `if (gen !== genRef.current) return;`
 *   3. **An `AbortController`** whose `.abort()` runs in the cleanup.
 *
 * ## What this guard CANNOT see
 *
 * It is a lexical scan, not a scope-aware AST pass. The boundary, so a green
 * run is not trusted further than it earns:
 *
 *   - It cannot tell a setter that truly runs in the async continuation from
 *     one that merely appears later in the source than the first `await` /
 *     `.then(`. A synchronous `setX()` written below an unrelated `.then()`
 *     reads as a violation; those sites are on the allowlist with that reason.
 *   - A flag must be declared, flipped, and read, but the read is not traced to
 *     the setter: a flag that gates the WRONG `set*` call still counts, and so
 *     does a flip written outside the returned cleanup.
 *   - One guarded request exempts the whole effect, so a second unguarded fetch
 *     added beside it is invisible. Pinning that needs per-statement dataflow,
 *     which a lexical scan cannot do; the allowlist rows are deliberately
 *     file-scoped for the same reason.
 *   - The self-retrigger rule reads control flow only as far as "this block's
 *     last statement is a `return`". A path that leaves by `throw`, or through a
 *     branch whose return sits anywhere but last, reads as reachable — which
 *     errs toward reporting, so the cost is an allowlist row, not a miss.
 *   - The fetch/apply pair moved into a helper the effect calls is invisible,
 *     and so is a guard living in that helper.
 *   - `depsAllStable` resolves a `useRef` / `useMounted` handle only by a
 *     file-local `const` declaration, so a stable handle arriving as a prop
 *     still reads as switchable.
 *   - Regex literals are not lexed. A `(`, `)` or quote inside one skews the
 *     paren walk and can truncate the effect being read — which fails open for
 *     that effect. Strings, template literals and comments ARE blanked, and
 *     both directions are pinned by fixtures below.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { trackedSourceFiles } from './test/trackedFiles.js';

const CLIENT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Effects exempt from the rule, each with the reason. Adding a row is the
 * moment to ask whether the dependency can really never select a different
 * record — if it can, the fix is a guard, not a row here.
 *
 * Keyed by file: an effect's line number moves on every edit above it, so
 * keying on one would make this list conflict on unrelated commits. The
 * trade-off is that a file listed here is exempt for ALL of its effects, so
 * rows are meant to stay rare.
 */
const ALLOWED = {
  'src/components/QuickBrainCapture.jsx':
    'seededRef latches on the first run, so the fetch fires at most once per mount',
  'src/components/brain/tabs/FeedsTab.jsx':
    'setLoading(false) is a load-finished latch, not a response written into state',
  'src/components/cos/tabs/MemoryTab.jsx':
    'embeddingConfigLoaded latches true on the first run, so the fetch fires at most once',
  'src/components/settings/AssessmentSweepPanel.jsx':
    'the setters run inside a socket handler that the cleanup severs with socket.off, '
    + 'so none can fire for a superseded dependency',
  'src/components/sprites/ImportPanel.jsx':
    'deps are [open] only — a drawer preload with no record identity to switch',
  'src/components/voice/VoiceWidget.jsx':
    'deps are [enabled, navigate] — a session toggle, not a record identity',
  'src/pages/AIProviders.jsx':
    'deps are [fleetSetupOpen] only — a modal preload with no record identity to switch',
  'src/pages/Browser.jsx':
    'deps are [showConfig, config] — a panel toggle re-reading its own config',
};

// ---------------------------------------------------------------------------
// Lexing
// ---------------------------------------------------------------------------

/**
 * Blank out comments, string literals and the literal spans of template
 * literals, preserving offsets and line breaks so reported line numbers stay
 * true. A `(` inside a toast message would otherwise skew the paren walk below
 * and truncate the effect it was reading; `${...}` spans are kept because they
 * hold real code.
 */
export function blankLexical(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') { out += ' '; i += 1; }
      continue;
    }
    if (c === '/' && next === '*') {
      out += '  '; i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' '; i += 1;
      }
      out += '  '; i += 2;
      continue;
    }
    if (c === "'" || c === '"') {
      out += ' '; i += 1;
      while (i < src.length && src[i] !== c) {
        if (src[i] === '\\') { out += '  '; i += 2; continue; }
        out += src[i] === '\n' ? '\n' : ' '; i += 1;
      }
      out += ' '; i += 1;
      continue;
    }
    if (c === '`') {
      out += ' '; i += 1;
      while (i < src.length && src[i] !== '`') {
        if (src[i] === '\\') { out += '  '; i += 2; continue; }
        if (src[i] === '$' && src[i + 1] === '{') {
          out += '  '; i += 2;
          let depth = 1;
          while (i < src.length && depth > 0) {
            if (src[i] === '{') depth += 1;
            else if (src[i] === '}') {
              depth -= 1;
              if (depth === 0) { out += ' '; i += 1; break; }
            }
            out += src[i]; i += 1;
          }
          continue;
        }
        out += src[i] === '\n' ? '\n' : ' '; i += 1;
      }
      out += ' '; i += 1;
      continue;
    }
    out += c; i += 1;
  }
  return out;
}

/**
 * Text between the `(` at `open` and its matching `)`. A lazy `[^)]*` would
 * stop at the first `)` inside the effect — every real effect has several — so
 * the walk counts depth instead. Returns null on an unbalanced run, which
 * reads as "nothing to inspect".
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

/**
 * Split a `useEffect(...)` argument list into its callback body and its
 * dependency array, at the last top-level comma. Returns null when the call has
 * no literal dep array — an effect that runs on every render is a different
 * (and louder) bug that this rule does not own.
 */
export function splitDeps(args) {
  let depth = 0;
  for (let i = args.length - 1; i >= 0; i -= 1) {
    const c = args[i];
    if (c === ')' || c === ']' || c === '}') depth += 1;
    else if (c === '(' || c === '[' || c === '{') depth -= 1;
    else if (c === ',' && depth === 0) {
      const tail = args.slice(i + 1).trim();
      if (tail.startsWith('[') && tail.endsWith(']')) {
        return { body: args.slice(0, i), deps: tail.slice(1, -1) };
      }
      return null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

const ASYNC_BOUNDARY = /\bawait\b|\.then\s*\(/;

// `set[A-Z]` also spells the timer APIs; they set no React state.
const TIMER_SETTERS = new Set(['setTimeout', 'setInterval', 'setImmediate']);

// A bare `setFoo` reference. Deliberately not anchored to an open paren: the
// tree writes state both as `setFoo(v)` and as `.then(setFoo)`, and the second
// spelling is the more dangerous one — it applies the raw response. The leading
// class keeps `obj.setFoo` out; a method on a fetched object is not this
// component's state.
const SETTER_CALL = /(^|[^.\w$])(set[A-Z][\w$]*)\b/g;

const FLAG_DECL = /\b(?:let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(true|false)\b/g;
const GENERATION_BUMP = /\+\+\s*[\w$.]+\.current|[\w$.]+\.current\s*\+=\s*1|[\w$.]+\.current\s*=\s*[\w$.]+\.current\s*\+\s*1/;
const GENERATION_COMPARE = /[\w$.]+\.current\s*(?:!==|===|!=|==)|(?:!==|===|!=|==)\s*[\w$.]+\.current/;
const ABORT_CONTROLLER = /new\s+AbortController\s*\(/;
const ABORT_CALL = /\.abort\s*\(/;

// `const x = useRef(...)` / `const x = useMounted()` — a handle whose identity
// is fixed for the life of the component.
const STABLE_DECL = /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(?:useRef|useMounted)\s*\(/g;

/**
 * A flag declared inside the effect, later assigned its opposite value, AND
 * read at least once somewhere else.
 *
 * The read requirement is what stops the guard from being cosmetic. Declaring
 * and flipping a flag that gates nothing —
 * `let active = true; load(id).then(setValue); return () => { active = false; };`
 * — keeps the exact race this rule exists to reject, and a declaration+flip
 * check alone would pass it.
 */
function flipFlagEnd(body) {
  for (const match of body.matchAll(FLAG_DECL)) {
    const opposite = match[2] === 'true' ? 'false' : 'true';
    // Names may legally contain `$`, a regex anchor — escaping it keeps the
    // pattern from silently becoming unmatchable and passing the offender.
    const name = match[1].replace(/\$/g, '\\$');
    const flip = new RegExp(`\\b${name}\\s*=\\s*${opposite}\\b`);
    const end = match.index + match[0].length;
    const rest = body.slice(end);
    if (!flip.test(rest)) continue;
    // A READ — an occurrence not being assigned to. Counting bare occurrences
    // would let a second write stand in for a read (`active = true; … active =
    // false;`), which is the cosmetic guard this check exists to reject. `==`
    // and `===` are comparisons, so they stay reads.
    const read = new RegExp(`\\b${name}\\b(?!\\s*=[^=])`);
    if (read.test(rest)) return end;
  }
  return -1;
}

const hasFlipFlag = (body) => flipFlagEnd(body) !== -1;

/** Whether `body` disposes of a superseded response by any sanctioned shape. */
export function hasDisposalGuard(body) {
  return hasFlipFlag(body)
    || (GENERATION_BUMP.test(body) && GENERATION_COMPARE.test(body))
    || (ABORT_CONTROLLER.test(body) && ABORT_CALL.test(body));
}

/** The first `set*` call positioned after the effect's first async boundary. */
function setterAfterAsync(body) {
  const async = ASYNC_BOUNDARY.exec(body);
  if (!async) return null;
  for (const match of body.matchAll(SETTER_CALL)) {
    if (TIMER_SETTERS.has(match[2])) continue;
    if (match.index + match[1].length > async.index) return match[2];
  }
  return null;
}

/**
 * Every dep is a ref handle, so the array can never select a different record —
 * the effect is a mount-only load wearing a dep array to satisfy the lint rule.
 */
function depsAllStable(deps, stableNames) {
  const entries = deps.split(',').map((d) => d.trim()).filter(Boolean);
  return entries.length > 0 && entries.every((d) => stableNames.has(d));
}

/** Identity-keyed async effects in `src` that apply their response unguarded. */
export function unguardedEffects(src) {
  const blanked = blankLexical(src);
  const stableNames = new Set([...blanked.matchAll(STABLE_DECL)].map((m) => m[1]));
  const found = [];
  for (const match of blanked.matchAll(/\buseEffect\s*\(/g)) {
    const args = balancedArgs(blanked, match.index + match[0].length - 1);
    if (args === null) continue;
    const split = splitDeps(args);
    if (!split || !split.deps.trim()) continue;
    if (depsAllStable(split.deps, stableNames)) continue;
    const setter = setterAfterAsync(split.body);
    if (!setter) continue;
    if (hasDisposalGuard(split.body)) continue;
    found.push({
      line: blanked.slice(0, match.index).split('\n').length,
      deps: split.deps.replace(/\s+/g, ' ').trim(),
      setter,
    });
  }
  return found;
}

/**
 * Whether a block's own last statement is a `return`, so every path through it
 * leaves the effect.
 *
 * "Contains a return" is not enough: `{ setLoading(true); if (cached) return; }`
 * falls through whenever `cached` is false, and the write still re-triggers.
 * Nested `{…}` become `;` so the statement split sees `if (b) {…}` as finished
 * and `{ if (b) { setX(); } return; }` still reads as an unconditional bail.
 */
function alwaysReturns(inner) {
  let flat = '';
  let depth = 0;
  for (const char of inner) {
    if (char === '{') { depth += 1; if (depth === 1) flat += ';'; continue; }
    if (char === '}') { depth = Math.max(0, depth - 1); continue; }
    if (depth === 0) flat += char;
  }
  const statements = flat.split(';').map((s) => s.trim()).filter(Boolean);
  return /^return\b/.test(statements.at(-1) || '');
}

/**
 * Spans of the nested `{…}` blocks in an effect body that always return.
 *
 * Anything inside one is on a path that leaves the effect, so it cannot reach —
 * and therefore cannot cancel — a request set up after it. The callback's own
 * outermost block is excluded: it holds the cleanup's `return`, so counting it
 * would swallow the whole body.
 *
 * Nesting matters (`if (a) { if (b) { setX(); } return; }` bails too), so every
 * enclosing block is reported, not just the innermost.
 */
function bailingBlocks(body) {
  const spans = [];
  const open = [];
  for (let i = 0; i < body.length; i += 1) {
    if (body[i] === '{') open.push(i);
    else if (body[i] === '}' && open.length) {
      const start = open.pop();
      // depth 1 is the callback body itself
      if (open.length >= 1 && alwaysReturns(body.slice(start + 1, i))) spans.push([start, i]);
    }
  }
  return spans;
}

/**
 * The mirror-image mistake: a lifetime-scoped flip flag in an effect that
 * SYNCHRONOUSLY writes a state value appearing in its own dependency array.
 *
 *   useEffect(() => {
 *     let active = true;
 *     setLoadingOutput(true);              // ← re-runs this effect immediately
 *     load(id).then((v) => { if (active) setValue(v); });
 *     return () => { active = false; };    // ← …whose cleanup fires here
 *   }, [id, loadingOutput]);
 *
 * The re-run's cleanup flips the flag before the response lands, so the update
 * is silently dropped — the guard does not merely fail to help, it breaks the
 * feature. That shipped four times while sweeping #7242 (it took AgentCard's
 * transcript, the pipeline ledger/outline re-reads, and the post-download
 * upscale re-probe offline) and only one of them had a test to catch it.
 *
 * The fix is a request-generation ref: the re-run early-returns without
 * bumping, so the in-flight request stays current.
 *
 * Only a SYNCHRONOUS write counts, and only one that can actually reach the
 * request. The same setter inside `.then()` runs after the response has already
 * been applied, so it cannot cancel itself; and one inside a block that returns
 * (`if (!enabled) { setOffset(0); return; }`) is on a path that bails before any
 * request exists.
 */
export function selfDisposingEffects(src) {
  const blanked = blankLexical(src);
  const found = [];
  for (const match of blanked.matchAll(/\buseEffect\s*\(/g)) {
    const args = balancedArgs(blanked, match.index + match[0].length - 1);
    if (args === null) continue;
    const split = splitDeps(args);
    if (!split || !split.deps.trim()) continue;
    const { body, deps } = split;
    const async = ASYNC_BOUNDARY.exec(body);
    if (!async) continue;
    if (flipFlagEnd(body) === -1) continue;
    const bailing = bailingBlocks(body);
    const depNames = new Set(deps.split(',').map((d) => d.trim()).filter(Boolean));
    for (const setter of body.matchAll(SETTER_CALL)) {
      if (TIMER_SETTERS.has(setter[2])) continue;
      const at = setter.index + setter[1].length;
      if (at > async.index) continue;
      if (bailing.some(([open, close]) => at > open && at < close)) continue;
      // `setLoadingOutput` → `loadingOutput`, the state value it writes.
      const stateName = setter[2][3].toLowerCase() + setter[2].slice(4);
      if (!depNames.has(stateName)) continue;
      found.push({
        line: blanked.slice(0, match.index).split('\n').length,
        setter: setter[2],
        dep: stateName,
      });
      break;
    }
  }
  return found;
}

const violationsIn = (file) => unguardedEffects(readFileSync(join(CLIENT_ROOT, file), 'utf8'))
  .map((v) => `${file}:${v.line}  deps=[${v.deps}] → ${v.setter}()`);

const selfDisposingIn = (file) => selfDisposingEffects(readFileSync(join(CLIENT_ROOT, file), 'utf8'))
  .map((v) => `${file}:${v.line}  ${v.setter}() re-runs the effect via dep \`${v.dep}\``);

describe('identity-keyed async effects drop superseded responses', () => {
  it('has no unguarded identity-keyed async effect outside the allowlist', () => {
    const files = trackedSourceFiles(CLIENT_ROOT);
    // A broken `git ls-files` (wrong cwd, detached checkout) would otherwise
    // make this guard pass by scanning nothing at all.
    expect(files.length).toBeGreaterThan(100);

    const violations = files
      .filter((file) => !(file in ALLOWED))
      .flatMap(violationsIn);

    expect(
      violations,
      'These effects fetch on a dependency and write the answer into state with no '
      + 'disposal guard. Change the dependency faster than the request resolves and the '
      + "superseded record's data is rendered under the current one — and it does not "
      + 'self-correct, because nothing refetches.\n'
      + 'Fix: `let active = true;` at the top of the effect, gate every `set*` on it, and '
      + '`return () => { active = false; };`. Match whichever spelling the file already '
      + 'uses. Where the response must be matched against the newest request rather than '
      + 'merely dropped, bump and compare a generation ref instead.\n'
      + '`useMounted()` does NOT fix this — the component stays mounted; only its subject '
      + 'changed.\n'
      + 'If the dependency genuinely cannot select a different record (a drawer `open` '
      + 'flag, a once-only latch), add the file to ALLOWED in this file with a one-line '
      + `reason.\nOffenders:\n  ${violations.join('\n  ')}`,
    ).toEqual([]);
  });

  it('has no lifetime flag in an effect that re-triggers itself', () => {
    const files = trackedSourceFiles(CLIENT_ROOT);
    expect(files.length).toBeGreaterThan(100);

    const violations = files.flatMap(selfDisposingIn);

    expect(
      violations,
      'These effects hold a `let active`-style flag AND synchronously write a state '
      + 'value that is in their own dependency array. The write re-runs the effect at '
      + "once, and the re-run's cleanup flips the flag before the response lands — so "
      + 'the update is silently dropped. The guard does not just fail to help here, it '
      + 'breaks the feature.\n'
      + 'Fix: use a request-generation ref instead — `const req = ++fooRef.current;` at '
      + 'request time, `if (req === fooRef.current)` at apply time. The re-run '
      + 'early-returns without bumping, so the in-flight request stays current.\n'
      + `Offenders:\n  ${violations.join('\n  ')}`,
    ).toEqual([]);
  });

  // Burn-down: an allowlist entry that no longer needs to be there must go, or
  // the list quietly becomes a list of files nobody has looked at in a year.
  it('has no stale allowlist entry', () => {
    const missing = Object.keys(ALLOWED).filter((file) => !existsSync(join(CLIENT_ROOT, file)));
    expect(missing, `Allowlisted files that no longer exist:\n  ${missing.join('\n  ')}`).toEqual([]);

    const noLongerNeeded = Object.keys(ALLOWED).filter((file) => violationsIn(file).length === 0);
    expect(
      noLongerNeeded,
      'These files are allowlisted but no longer trip the rule. Delete their rows from '
      + `ALLOWED.\n  ${noLongerNeeded.join('\n  ')}`,
    ).toEqual([]);
  });

  it('gives every allowlist entry a reason', () => {
    const unexplained = Object.entries(ALLOWED)
      .filter(([, reason]) => !reason || reason.trim().length < 20)
      .map(([file]) => file);
    expect(
      unexplained,
      `These rows need a one-line reason the dependency cannot switch:\n  ${unexplained.join('\n  ')}`,
    ).toEqual([]);
  });

  // Guards the guard: a detector that stopped recognizing the broken shape would
  // make the scan above vacuously green and let the bug class walk straight back in.
  describe('detector', () => {
    it('flags an identity-keyed fetch that applies its response unguarded', () => {
      const found = unguardedEffects(`
        useEffect(() => {
          loadBible(work.id).then(setCharacters);
        }, [work.id]);
      `);
      expect(found).toHaveLength(1);
      expect(found[0].setter).toBe('setCharacters');
      expect(found[0].deps).toBe('work.id');
    });

    it('flags an unguarded await, not just a .then', () => {
      expect(unguardedEffects(`
        useEffect(() => {
          (async () => {
            const rows = await listItems(subjectId);
            setRows(rows);
          })();
        }, [subjectId]);
      `)).toHaveLength(1);
    });

    it('accepts every sanctioned guard shape', () => {
      // 1. The flip flag, in each spelling the tree uses.
      for (const flag of ['active', 'cancelled', 'canceled', 'live', 'current', 'ignore']) {
        expect(unguardedEffects(`
          useEffect(() => {
            let ${flag} = true;
            load(id).then((v) => { if (${flag}) setValue(v); });
            return () => { ${flag} = false; };
          }, [id]);
        `), `flag spelled \`${flag}\``).toEqual([]);
      }

      // A flag seeded false and raised in the cleanup is the same idiom inverted.
      expect(unguardedEffects(`
        useEffect(() => {
          let stale = false;
          load(id).then((v) => { if (!stale) setValue(v); });
          return () => { stale = true; };
        }, [id]);
      `)).toEqual([]);

      // 2. A request-generation ref.
      expect(unguardedEffects(`
        useEffect(() => {
          const gen = ++genRef.current;
          load(id).then((v) => { if (gen === genRef.current) setValue(v); });
        }, [id]);
      `)).toEqual([]);

      // 3. An AbortController aborted in the cleanup.
      expect(unguardedEffects(`
        useEffect(() => {
          const controller = new AbortController();
          load(id, { signal: controller.signal }).then(setValue);
          return () => controller.abort();
        }, [id]);
      `)).toEqual([]);
    });

    it('ignores effects that cannot strand a superseded response', () => {
      // No dependency array at all — a different bug, not this rule's.
      expect(unguardedEffects('useEffect(() => { load().then(setValue); });')).toEqual([]);

      // Mount-only.
      expect(unguardedEffects('useEffect(() => { load().then(setValue); }, []);')).toEqual([]);

      // Nothing async.
      expect(unguardedEffects('useEffect(() => { setValue(id); }, [id]);')).toEqual([]);

      // Async, but nothing written into state.
      expect(unguardedEffects('useEffect(() => { track(id).then(() => log(id)); }, [id]);')).toEqual([]);

      // A setter that runs BEFORE the async boundary is not a stranded response.
      expect(unguardedEffects(`
        useEffect(() => {
          setLoading(true);
          void refresh(id);
        }, [id]);
      `)).toEqual([]);

      // Timer APIs spell `set[A-Z]` but set no React state.
      expect(unguardedEffects(`
        useEffect(() => {
          load(id).then(() => setTimeout(done, 10));
        }, [id]);
      `)).toEqual([]);

      // A method on the fetched value is not this component's state.
      expect(unguardedEffects('useEffect(() => { load(id).then((r) => r.setName(x)); }, [id]);')).toEqual([]);
    });

    it('treats a dep array of only ref handles as mount-only', () => {
      const src = `
        const mountedRef = useMounted();
        useEffect(() => {
          load().then((v) => { if (mountedRef.current) setValue(v); });
        }, [mountedRef]);
      `;
      expect(unguardedEffects(src)).toEqual([]);

      // …but one switchable dep alongside it still counts.
      expect(unguardedEffects(src.replace('[mountedRef]', '[workId, mountedRef]'))).toHaveLength(1);
    });

    it('does not accept a flag that gates nothing', () => {
      // Declared and flipped, but never consulted — the response is applied
      // unconditionally, so the race is exactly the one being rejected.
      expect(unguardedEffects(`
        useEffect(() => {
          let active = true;
          load(id).then(setValue);
          return () => { active = false; };
        }, [id]);
      `)).toHaveLength(1);

      // A second WRITE is not a read; it must not stand in for one.
      expect(unguardedEffects(`
        useEffect(() => {
          let active = true;
          active = true;
          load(id).then(setValue);
          return () => { active = false; };
        }, [id]);
      `)).toHaveLength(1);

      // A comparison IS a read — `==`/`===` must not be mistaken for assignment.
      expect(unguardedEffects(`
        useEffect(() => {
          let active = true;
          load(id).then((v) => { if (active === true) setValue(v); });
          return () => { active = false; };
        }, [id]);
      `)).toEqual([]);
    });

    it('does not accept a mounted guard as an identity guard', () => {
      // The component never unmounted — `mountedRef.current` is true the whole
      // time — so this is the exact shape the rule exists to reject.
      expect(unguardedEffects(`
        useEffect(() => {
          load(workId).then((v) => { if (mountedRef.current) setValue(v); });
        }, [workId]);
      `)).toHaveLength(1);
    });

    it('reads through parens and braces inside strings, templates and comments', () => {
      // Each of these would truncate the effect (or fake a guard) without lexing.
      expect(unguardedEffects(`
        useEffect(() => {
          toast.error('could not load :( ');
          load(id).then(setValue);
        }, [id]);
      `)).toHaveLength(1);

      expect(unguardedEffects(`
        useEffect(() => {
          const label = \`item (\${id}\`;
          load(label).then(setValue);
        }, [id]);
      `)).toHaveLength(1);

      // A guard written only inside a comment is not a guard.
      expect(unguardedEffects(`
        useEffect(() => {
          // let active = true; return () => { active = false; };
          load(id).then(setValue);
        }, [id]);
      `)).toHaveLength(1);

      // …and a real guard is still seen when a comment sits next to it.
      expect(unguardedEffects(`
        useEffect(() => {
          let active = true; // dropped if \`id\` changes first
          load(id).then((v) => { if (active) setValue(v); });
          return () => { active = false; };
        }, [id]);
      `)).toEqual([]);
    });

    it('flags a lifetime flag beside a synchronous write to its own dep', () => {
      const found = selfDisposingEffects(`
        useEffect(() => {
          let active = true;
          setLoading(true);
          load(id).then((v) => { if (active) setValue(v); });
          return () => { active = false; };
        }, [id, loading]);
      `);
      expect(found).toHaveLength(1);
      expect(found[0].setter).toBe('setLoading');
      expect(found[0].dep).toBe('loading');
    });

    it('does not flag a write that cannot re-trigger the effect first', () => {
      const flagged = (src) => selfDisposingEffects(src).length;

      // The setter's value is not a dependency, so the write re-runs nothing.
      expect(flagged(`
        useEffect(() => {
          let active = true;
          setLoading(true);
          load(id).then((v) => { if (active) setValue(v); });
          return () => { active = false; };
        }, [id]);
      `)).toBe(0);

      // Written only inside `.then()` — the response has already been applied
      // by the time the re-run's cleanup could fire, so it cannot self-cancel.
      expect(flagged(`
        useEffect(() => {
          let active = true;
          load(id).then((v) => { if (active) setConsents(v); });
          return () => { active = false; };
        }, [id, consents]);
      `)).toBe(0);

      // Written in an early-return branch ABOVE the flag: that path bails
      // before the request exists, so it cannot cancel one.
      expect(flagged(`
        useEffect(() => {
          if (!enabled) {
            setOffset(0);
            return;
          }
          let cancelled = false;
          load(offset).then((v) => { if (!cancelled) setItems(v); });
          return () => { cancelled = true; };
        }, [enabled, offset]);
      `)).toBe(0);

      // …but a bare `return` guard above it does NOT put the write on a bailing
      // path: `setLoading(true)` here still runs, and still re-triggers.
      expect(flagged(`
        useEffect(() => {
          if (loading) return;
          setLoading(true);
          let active = true;
          load(id).then((v) => { if (active) setValue(v); });
          return () => { active = false; };
        }, [id, loading]);
      `)).toBe(1);

      // Nested inside a block that bails, two levels down.
      expect(flagged(`
        useEffect(() => {
          if (a) {
            if (b) { setOffset(0); }
            return;
          }
          let active = true;
          load(offset).then((v) => { if (active) setItems(v); });
          return () => { active = false; };
        }, [a, b, offset]);
      `)).toBe(0);

      // A block that only CONDITIONALLY returns does not exempt the write —
      // with `cached` false, execution falls through to the request.
      expect(flagged(`
        useEffect(() => {
          if (enabled) {
            setLoading(true);
            if (cached) return;
          }
          let active = true;
          load(id).then((v) => { if (active) setValue(v); });
          return () => { active = false; };
        }, [id, loading]);
      `)).toBe(1);

      // A generation ref is the sanctioned fix, not a violation.
      expect(flagged(`
        useEffect(() => {
          const req = ++genRef.current;
          setLoading(true);
          load(id).then((v) => { if (req === genRef.current) setValue(v); });
        }, [id, loading]);
      `)).toBe(0);
    });

    it('reports the line of the offending effect', () => {
      const found = unguardedEffects([
        'const a = 1;',
        'const b = 2;',
        'useEffect(() => {',
        '  load(id).then(setValue);',
        '}, [id]);',
      ].join('\n'));
      expect(found[0].line).toBe(3);
    });
  });
});
