/**
 * Install-sync detection — answers "is the checked-out code ahead of what's
 * actually running / installed?" so the UI can tell a user who did a bare
 * `git pull` (without ./update.sh) that their install is half-updated.
 *
 * Four independent signals (issue #1779):
 *   1. running-stale-code   — the server process booted at an older commit than
 *      what's now on disk (a `git pull` advanced HEAD but nothing restarted).
 *   2. stale-deps           — a workspace's package.json/lockfile is newer than
 *      npm's install receipt (`node_modules/.package-lock.json`), or the
 *      receipt is missing entirely (deps never installed). `update.sh` runs
 *      `npm install`; a bare pull does not.
 *   3. stale-build          — the served client bundle (`client/dist`) is older
 *      than the client source (a pull touched the UI but it was never rebuilt).
 *   4. pending-migrations   — migration files exist on disk that aren't in the
 *      applied-list. (Boot normally applies these, so a non-zero count means a
 *      pull landed new migrations and the server hasn't restarted yet.)
 *
 * All four self-clear after a proper `update.sh` cycle (install bumps the npm
 * receipt mtime, build bumps the dist mtime, boot applies migrations and
 * captures the new commit) — so no new on-disk marker format is introduced and
 * existing installs get accurate detection immediately, with no migration.
 *
 * Detection is deliberately mtime/receipt-based rather than reading a marker
 * `update.sh` would have to write: that keeps it backward-compatible with every
 * install that updated before this shipped.
 */

import { join } from 'path';
import { stat, readdir } from 'fs/promises';
import { PATHS } from '../lib/fileUtils.js';
import { execGit } from '../lib/execGit.js';
import { listPendingMigrations } from '../../scripts/run-migrations.js';

// The commit the running process was launched at. Captured once at boot (see
// captureBootCommit, called from server/index.js). null when not yet captured
// or when HEAD couldn't be read (tarball install / not a git repo).
let bootCommit = null;

// Workspaces `update.sh` installs (safe_install . client server autofixer).
// Order is cosmetic; '.' renders as 'root'.
const DEP_WORKSPACES = ['.', 'client', 'server', 'autofixer'];

// Directories never worth walking for client-source freshness.
const WALK_SKIP_DIRS = new Set(['node_modules', 'dist', '.git']);

// The tracked lockfile and npm's receipt (node_modules/.package-lock.json) are
// written by the SAME `npm install`, milliseconds apart, in an order npm does
// not guarantee. Only treat the lockfile as "newer" when it leads the receipt
// by more than this slack — so install-time jitter never produces a permanent
// false "out of sync", while a real pulled-but-uninstalled lock (minutes/hours
// ahead) still trips. A genuine stale lock is never this close.
const LOCKFILE_NEWER_SLACK_MS = 60 * 1000;

/**
 * Capture the commit the process is running. Idempotent — only the first
 * successful read sticks, so a later on-disk `git pull` (which we WANT to
 * detect) can't overwrite the boot value. Call once from boot.
 */
export async function captureBootCommit({ rootDir = PATHS.root, getCommit = gitRevParseHead } = {}) {
  if (bootCommit) return bootCommit;
  const sha = await getCommit(rootDir).catch(() => null);
  if (sha) bootCommit = sha;
  return bootCommit;
}

/** Current boot commit (for inspection / tests). */
export function getBootCommit() {
  return bootCommit;
}

/** Test-only: override/reset the captured boot commit. */
export function __setBootCommitForTest(value) {
  bootCommit = value;
}

async function gitRevParseHead(rootDir) {
  const { stdout, exitCode } = await execGit(['rev-parse', 'HEAD'], rootDir, { ignoreExitCode: true });
  if (exitCode !== 0) return null;
  const sha = stdout.trim();
  return sha || null;
}

/**
 * Is `ancestor` an ancestor of `descendant`? Used to confirm the on-disk HEAD
 * is strictly AHEAD of the boot commit (a real pull-forward) rather than merely
 * different (e.g. the process booted on a feature branch and someone checked out
 * main) — which would otherwise produce a false "stale code" alarm in dev.
 */
async function gitIsAncestor(ancestor, descendant, rootDir) {
  const { exitCode } = await execGit(
    ['merge-base', '--is-ancestor', ancestor, descendant],
    rootDir,
    { ignoreExitCode: true }
  );
  return exitCode === 0;
}

/** mtime in ms for a path, or null when it doesn't exist / can't be stat'd. */
async function statMtimeMs(path) {
  const s = await stat(path).catch(() => null);
  return s ? s.mtimeMs : null;
}

/**
 * Walk client source looking for any file newer than `buildMtimeMs`,
 * short-circuiting on the first hit. Skips node_modules/dist/.git. Returns true
 * as soon as a newer source file is found, false if the build is current.
 */
async function isClientSourceNewer(rootDir, buildMtimeMs, { statMtime = statMtimeMs } = {}) {
  const clientDir = join(rootDir, 'client');
  const stack = [];

  // Every file directly under client/ is a build input or config (index.html,
  // package.json, vite.config.js, postcss.config.js, tailwind/tsconfig, …).
  // Stat them all rather than enumerating filenames, so a config-only change
  // still marks the build stale without a list that rots as configs are added.
  // Directories here are handled below: src/public are walked recursively;
  // node_modules/dist/.git are skipped.
  const rootEntries = await readdir(clientDir, { withFileTypes: true }).catch(() => []);
  for (const entry of rootEntries) {
    if (entry.isDirectory()) {
      // Both client/src AND client/public feed the build — Vite copies public/
      // verbatim into dist/, so a public-asset-only change (e.g. a swapped
      // favicon) still requires a rebuild.
      if (entry.name === 'src' || entry.name === 'public') stack.push(join(clientDir, entry.name));
      continue;
    }
    const m = await statMtime(join(clientDir, entry.name));
    if (m != null && m > buildMtimeMs) return true;
  }

  while (stack.length) {
    const dir = stack.pop();
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!WALK_SKIP_DIRS.has(entry.name)) stack.push(join(dir, entry.name));
        continue;
      }
      const m = await statMtime(join(dir, entry.name));
      if (m != null && m > buildMtimeMs) return true;
    }
  }
  return false;
}

/**
 * Classify each workspace's dependency freshness by comparing its manifest /
 * lockfile mtime against npm's install receipt (`node_modules/.package-lock.json`,
 * rewritten on every `npm install`). A workspace with no package.json is skipped
 * (not present in this install).
 */
async function detectStaleDeps(rootDir, { statMtime = statMtimeMs } = {}) {
  const workspaces = [];
  for (const ws of DEP_WORKSPACES) {
    const manifestMtime = await statMtime(join(rootDir, ws, 'package.json'));
    if (manifestMtime == null) continue; // workspace absent

    const receiptMtime = await statMtime(join(rootDir, ws, 'node_modules', '.package-lock.json'));
    const lockMtime = await statMtime(join(rootDir, ws, 'package-lock.json'));

    let stale = false;
    let reason = null;
    if (receiptMtime == null) {
      stale = true;
      reason = 'not-installed';
    } else if (manifestMtime > receiptMtime) {
      stale = true;
      reason = 'manifest-newer';
    } else if (lockMtime != null && lockMtime - receiptMtime > LOCKFILE_NEWER_SLACK_MS) {
      stale = true;
      reason = 'lockfile-newer';
    }
    workspaces.push({ name: ws === '.' ? 'root' : ws, stale, reason });
  }
  return { stale: workspaces.some(w => w.stale), workspaces };
}

/**
 * Compute the full install-sync picture. Every external dependency is
 * injectable so the detection logic is unit-testable without touching real
 * git/fs. Returns a plain object safe to splice into /api/update/status.
 *
 * Best-effort by contract: callers wrap this in `.catch(() => null)` so a git
 * or fs hiccup never blocks the status response.
 */
export async function getInstallState({
  rootDir = PATHS.root,
  // The migration ledger lives under the DATA install root (data/migrations.applied.json),
  // which boot writes via the PORTOS_DATA_ROOT-resolved root — not the code checkout.
  // Read it from the same place so a pinned-data-root worktree boot doesn't report every
  // already-applied migration as pending (#1947). Equals rootDir for a normal install.
  migrationRootDir = PATHS.installRoot,
  boot = bootCommit,
  getCurrentCommit = () => gitRevParseHead(rootDir),
  isAncestor = (a, b) => gitIsAncestor(a, b, rootDir),
  statMtime = statMtimeMs,
  clientSourceNewer = (buildMs) => isClientSourceNewer(rootDir, buildMs, { statMtime }),
  listPending = () => listPendingMigrations({ rootDir: migrationRootDir }),
} = {}) {
  const currentCommit = await getCurrentCommit().catch(() => null);

  // Running stale code only when the on-disk HEAD is strictly ahead of the
  // boot commit (boot is an ancestor of current). "Merely different" (branch
  // switch, rollback) is NOT flagged — it's not the half-updated state we warn
  // about, and flagging it would cry wolf on every dev branch checkout.
  let runningStaleCode = false;
  if (boot && currentCommit && boot !== currentCommit) {
    runningStaleCode = await isAncestor(boot, currentCommit).catch(() => false);
  }

  const staleDeps = await detectStaleDeps(rootDir, { statMtime });

  // Stale build: null (unknown) when there's no built bundle — that's dev mode
  // (`npm run dev` serves via Vite) or a never-built install, neither of which
  // should raise a false "rebuild needed" alarm.
  const buildMtime = await statMtime(join(rootDir, 'client', 'dist', 'index.html'));
  const staleBuild = buildMtime == null ? null : await clientSourceNewer(buildMtime).catch(() => null);

  const pendingFiles = await listPending().catch(() => []);
  const pendingMigrations = { count: pendingFiles.length, files: pendingFiles };

  const outOfSync =
    runningStaleCode ||
    staleDeps.stale ||
    staleBuild === true ||
    pendingMigrations.count > 0;

  return {
    bootCommit: boot || null,
    currentCommit: currentCommit || null,
    runningStaleCode,
    staleDeps,
    staleBuild,
    pendingMigrations,
    outOfSync
  };
}

// Exported for unit tests of the individual detectors.
export const __internal = { detectStaleDeps, isClientSourceNewer, gitRevParseHead, gitIsAncestor };
