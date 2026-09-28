/**
 * Vitest globalSetup — the other half of the run-scoped temp root (#9032).
 *
 * `server/vitest.config.js` creates a run-scoped `mkdtempSync` root and
 * points `TMPDIR`/`TMP`/`TEMP` at it, at config-load time, before any worker
 * spawns. `os.tmpdir()` reads those env vars dynamically, so every call in
 * this process, in a forked worker (workers inherit `process.env` unless a
 * suite overrides it), or in any spawned child that inherits `process.env`
 * (Python's `tempfile` module, `ffmpeg`, `git`) resolves inside that root
 * instead of the host's real temp directory — a leaked directory can no
 * longer escape into `$TMPDIR` no matter which file left it behind.
 *
 * This module is that root's lifecycle manager as a Vitest `globalSetup`:
 * it runs once in the main process, before test collection starts and again
 * once after every test has finished (see
 * https://vitest.dev/config/#globalsetup). `setup()` has nothing to do — the
 * root already exists by the time this loads. `teardown()` reports and
 * removes whatever is still sitting in the root: this is the STRICT check
 * the issue asks for — once every per-file leaker in the tree is fixed, any
 * new leak fails the run instead of silently reappearing in $TMPDIR.
 */
import { readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

export function setup() {
  // No-op: server/vitest.config.js already created the root and pointed
  // TMPDIR/TMP/TEMP at it before this module loaded.
}

// Vitest itself keeps a per-run module-transform scratch dir under
// os.tmpdir() (vite-node's SSR/module fetch cache — `join(tmpdir(), nanoid())`
// in vitest's own source) and removes it via `project.close()` -> `clearTmpDir
// ()`. That close() call happens AFTER `_teardownGlobalSetup()` runs (see
// vitest's `Vitest.close()`), so this module's own teardown always observes
// it as still present — not a leak from PortOS test code, just an ordering
// artifact of two independent teardown sequences. nanoid()'s default alphabet
// (`A-Za-z0-9_-`) and length (21) make a false-negative collision with a real
// PortOS leak (which always mkdtemps with a human-readable `prefix-` name)
// effectively impossible, so entries matching it are excluded from the
// report — the root-level rmSync below still removes them either way.
const VITEST_INTERNAL_SCRATCH_DIR = /^[A-Za-z0-9_-]{21}$/;

// A handful of PortOS's own provider-availability tests spawn a REAL,
// installed third-party CLI (kilo, opencode, …) when one is present on the
// developer's PATH (`hasCli()`-style gates) — a binary that then writes its
// OWN scratch/cache state (a config dir, a Node module compile cache, …)
// into whatever TMPDIR it inherits, which since this file is our run root.
// That state is not a PortOS temp-file leak — it belongs to the third-party
// tool, only appears on a machine that actually has the tool installed
// (invisible in CI, where those tests are gated off), and fixing it means
// giving each such CLI invocation its own isolated cache dir, tracked in
// #9039. Reported for visibility but never fails the run — unlike an
// unrecognized name, which still does.
const KNOWN_THIRD_PARTY_CLI_SCRATCH = new Set(['kilo', 'opencode', 'escape', 'node-compile-cache']);

// A leak this file is NOT the right place to fix: `server/services/
// htmlComposition/*` is a different work area's tree (#9032 was explicitly
// scoped out of it), and its `renderComposition.preflight.test.js` leaves a
// real, non-empty `portos-html-composition-preflight-*` directory behind —
// confirmed by direct inspection, not a false positive. Tracked in #9044,
// which names the fix (the same `sweepStrayTempRoots()` helper that already
// closed the identical symptom in two other real-ffmpeg/real-browser
// suites). Remove this entry once #9044 lands.
//
// `mv-vocal-stem-route-test-` (server/routes/musicVideoVocalStem.test.js)
// and `portos-mv-composition-` (server/services/musicVideo/compositionRender
// .test.js) both already use that same sweepStrayTempRoots() helper, and it
// reliably closes the leak on macOS and on CI's Linux server-test shards —
// but NOT on Windows CI, where a still-terminating ffprobe/ffmpeg child
// evidently holds its file handle past the helper's ~300ms retry window.
// Tracked in #9045 (make the retry window platform-aware, or find and
// directly await the still-running background work instead of retrying
// blind). Remove these two entries once #9045 lands.
//
// `mediaJobQueue-test-` (server/services/mediaJobQueue/index.test.js) is
// the same "not the right place to fix" case as the htmlComposition entry
// above — that tree is a different work area, out of scope for #9032 —
// seen leaking on a Windows CI shard. Tracked in #9046. Remove this entry
// once #9046 lands.
const KNOWN_PENDING_LEAKS = new Set([
  'portos-html-composition-preflight-',
  'mv-vocal-stem-route-test-',
  'portos-mv-composition-',
  'mediaJobQueue-test-',
]);

/**
 * Groups a leaked entry's basename by its mkdtemp call site as closely as a
 * cheap heuristic can: mkdtemp appends a short random alphanumeric suffix
 * directly after the prefix a caller passed in, so stripping a trailing run
 * of 6+ alphanumeric characters recovers the prefix, e.g.
 * `portos-dump-a1b2c3` -> `portos-dump-`. Fixed-name files (`*-out.log`)
 * pass through unchanged and are reported individually. Exported for the
 * regression test.
 */
export function groupLeakPrefix(name) {
  return name.replace(/[0-9a-zA-Z]{6,}$/, '') || name;
}

/**
 * True when `path` holds no real content: a zero-byte file, or a directory
 * whose entries (recursively) are all themselves empty. A shared,
 * production-managed scratch container — `creativeDirectorScratchCwd`'s
 * `portos-cd-cwd`, or a fixed-name log a service truncates with `writeFile
 * (path, '')` before every start — is meant to persist across runs and be
 * reused; once its own per-run content is cleaned up (as production code
 * already does), what remains costs nothing and is not a leak worth
 * reporting or failing over. This also sidesteps a real hazard two files
 * sharing that literal path would otherwise create: each file removing the
 * whole shared container in its own `afterAll` races the other if Vitest
 * runs them concurrently, and one can delete a sibling's still-in-use
 * fixture. Skipping empty entries here means neither file needs to touch
 * the shared path at all — production's own per-item cleanup is trusted,
 * and this function only asks "is anything really left". Exported for the
 * regression test.
 */
export function isEffectivelyEmpty(path) {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return true; // already gone
  }
  if (stat.isFile()) return stat.size === 0;
  if (!stat.isDirectory()) return false; // a socket, symlink, etc. — never silently drop it
  let children;
  try {
    children = readdirSync(path);
  } catch {
    return true;
  }
  return children.every((child) => isEffectivelyEmpty(join(path, child)));
}

export function teardown() {
  const root = process.env.TMPDIR;
  if (!root) return;

  let entries = [];
  try {
    entries = readdirSync(root);
  } catch {
    // Root was never created (config didn't run, e.g. a unit test of this
    // module) or was already removed — nothing to report or clean.
    return;
  }

  entries = entries
    .filter((name) => !VITEST_INTERNAL_SCRATCH_DIR.test(name))
    .filter((name) => !isEffectivelyEmpty(join(root, name)));

  if (entries.length > 0) {
    const byPrefix = new Map();
    for (const name of entries) {
      const prefix = groupLeakPrefix(name);
      byPrefix.set(prefix, (byPrefix.get(prefix) || 0) + 1);
    }
    let hasUnknownLeak = false;
    for (const [prefix, count] of byPrefix) {
      const knownThirdParty = KNOWN_THIRD_PARTY_CLI_SCRATCH.has(prefix);
      const knownPending = KNOWN_PENDING_LEAKS.has(prefix);
      if (!knownThirdParty && !knownPending) hasUnknownLeak = true;
      const note = knownThirdParty ? ' (known third-party CLI scratch, see #9039)'
        : knownPending ? ' (known pending leak, see KNOWN_PENDING_LEAKS above)' : '';
      console.warn(`⚠️ test temp leak: ${prefix} ×${count}${note}`);
    }
    // Strict mode (#9032): a leftover entry means some suite wrote outside
    // its own cleanup path. Fail the run so a new leaker is caught locally
    // and in CI instead of quietly growing $TMPDIR — the run root itself is
    // still removed below either way, so the failure never reaches the
    // host's real temp directory. A KNOWN_THIRD_PARTY_CLI_SCRATCH or
    // KNOWN_PENDING_LEAKS entry is still reported (so it does not silently
    // balloon) but does not fail the run — see those constants' comments.
    if (hasUnknownLeak) process.exitCode = 1;
  }

  try {
    rmSync(root, { recursive: true, force: true });
  } catch (err) {
    // Best-effort — a lingering open handle on a worker that hasn't fully
    // exited yet (most often on Windows) must not crash teardown and mask
    // the leak report above. Not silent, though: warn so a stubborn root is
    // visible rather than just reappearing next run — the stale-root sweep
    // in vitest.config.js cleans it up once it's 6h old either way.
    console.warn(`⚠️ could not remove run temp root ${root}: ${err.message}`);
  }
}
