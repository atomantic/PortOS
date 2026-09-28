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
import { readdirSync, rmSync } from 'node:fs';

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

  entries = entries.filter((name) => !VITEST_INTERNAL_SCRATCH_DIR.test(name));

  if (entries.length > 0) {
    const byPrefix = new Map();
    for (const name of entries) {
      const prefix = groupLeakPrefix(name);
      byPrefix.set(prefix, (byPrefix.get(prefix) || 0) + 1);
    }
    let hasUnknownLeak = false;
    for (const [prefix, count] of byPrefix) {
      const knownThirdParty = KNOWN_THIRD_PARTY_CLI_SCRATCH.has(prefix);
      if (!knownThirdParty) hasUnknownLeak = true;
      console.warn(`⚠️ test temp leak: ${prefix} ×${count}${knownThirdParty ? ' (known third-party CLI scratch, see #9039)' : ''}`);
    }
    // Strict mode (#9032): a leftover entry means some suite wrote outside
    // its own cleanup path. Fail the run so a new leaker is caught locally
    // and in CI instead of quietly growing $TMPDIR — the run root itself is
    // still removed below either way, so the failure never reaches the
    // host's real temp directory. A KNOWN_THIRD_PARTY_CLI_SCRATCH entry is
    // still reported (so it does not silently balloon) but does not fail
    // the run — see that constant's comment.
    if (hasUnknownLeak) process.exitCode = 1;
  }

  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // Best-effort — a lingering open handle on a worker that hasn't fully
    // exited yet must not crash teardown and mask the leak report above.
  }
}
