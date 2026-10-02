import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sweepStaleRunRoots, writeOwnerFile } from './vitestStaleRunRoots.js';

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
  }
  process.env.TMPDIR = root;
  process.env.TMP = root;
  process.env.TEMP = root;
  process.env.NODE_DISABLE_COMPILE_CACHE = '1';
  return root;
}
