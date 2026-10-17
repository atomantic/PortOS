import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { OWNER_FILE, killTestProcessesUnder, sweepStaleRunRoots, writeOwnerFile } from './vitestStaleRunRoots.js';

// Vitest sets these in every pool worker; the enclosing main process owns the root.
const inVitestWorker = () => Boolean(process.env.VITEST_POOL_ID || process.env.VITEST_WORKER_ID);

/**
 * A watch-mode config restart runs global teardown (which removes the root)
 * and then reloads the config in the SAME main process, with the inherited
 * env still naming the removed pathname. Re-materialize it and re-stamp this
 * process as owner before the framework recreates scratch under it; otherwise
 * the next launch's sweep reads an unknown owner and reclaims a live session
 * after the age threshold (#10755). An existing stamp belongs to the
 * enclosing owner (CI launcher, earlier config load) and is never replaced,
 * and a pool worker re-importing the config never claims the root.
 */
function restoreInheritedRootOwnership(root) {
  if (inVitestWorker() || !basename(root).startsWith('pvt-')) return;
  mkdirSync(root, { recursive: true });
  if (!existsSync(join(root, OWNER_FILE))) writeOwnerFile(root);
}

/**
 * The owner of a run root stops every test process still running under it
 * when it exits or is interrupted (#10840), so an aborted run cannot strand a
 * child whose worker died. A signal is re-raised once the sweep runs unless
 * another listener (Vitest's own) is there to handle it.
 */
function killRootProcessesOnExit(root) {
  if (process.platform === 'win32') return;
  const sweep = () => {
    try { killTestProcessesUnder(root); } catch { /* best effort at exit */ }
  };
  process.once('exit', sweep);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.once(signal, () => {
      sweep();
      if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
    });
  }
}

/** Establish containment at config-load time, before Vitest creates its cache or workers. */
export function bootstrapVitestTempRoot() {
  const hostRoot = tmpdir();
  let root = process.env.PORTOS_TEST_TEMP_ROOT;
  if (!root) {
    sweepStaleRunRoots(hostRoot);
    // Keep Unix socket paths below macOS's short sockaddr_un limit.
    root = mkdtempSync(join(hostRoot, 'pvt-'));
    writeOwnerFile(root);
    process.env.PORTOS_TEST_TEMP_ROOT = root;
    killRootProcessesOnExit(root);
  } else {
    restoreInheritedRootOwnership(root);
  }
  process.env.TMPDIR = root;
  process.env.TMP = root;
  process.env.TEMP = root;
  // Chromium on macOS ignores TMPDIR in favor of this override. Without it,
  // test-owned socket/download scratch escapes the root and its teardown.
  process.env.MAC_CHROMIUM_TMPDIR = root;
  process.env.NODE_DISABLE_COMPILE_CACHE = '1';
  // Spawned npm would otherwise write debug logs into the developer's ~/.npm/_logs, evicting real ones (logs-max default 10).
  process.env.npm_config_logs_max = '0';
  return root;
}
