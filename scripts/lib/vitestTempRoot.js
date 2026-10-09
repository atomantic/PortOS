import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { OWNER_FILE, sweepStaleRunRoots, writeOwnerFile } from './vitestStaleRunRoots.js';

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
  } else {
    restoreInheritedRootOwnership(root);
  }
  process.env.TMPDIR = root;
  process.env.TMP = root;
  process.env.TEMP = root;
  process.env.NODE_DISABLE_COMPILE_CACHE = '1';
  return root;
}
