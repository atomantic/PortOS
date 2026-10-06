/**
 * Run-wide teardown shared by both workspace configs. Config-load bootstrap
 * redirects temp APIs before Vitest creates its module-transform cache.
 * The server's exclusive capture projects share this single global owner.
 */
import { readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { OWNER_FILE } from './lib/vitestStaleRunRoots.js';

export function setup() {}

// Vitest's nanoid transform scratch still exists when global teardown runs.
// Exclude it only inside our owned root; never sweep arbitrary host directories.
const VITEST_INTERNAL_SCRATCH_DIR = /^[A-Za-z0-9_-]{21}$/;

// macOS `xcrun` (spawned by any descendant resolving an Apple toolchain) writes
// its lookup cache to $TMPDIR, which is our owned root. It is toolchain-owned
// output, not fixture data: match the exact cache name only, so a real leaked
// fixture is still reported.
const TOOLCHAIN_CACHE_PREFIXES = new Set([
  'xcrun_db',
  // Linux Chrome/Chromium create `[.]com.google.Chrome.<random>` (or
  // `org.chromium.Chromium.`) scratch directories in $TMPDIR and remove them only
  // on a clean exit; the owned test browsers are terminated, so they linger. They
  // are browser-owned, not fixture data, and surface once a real-Chrome suite runs
  // under this guard on Linux (#10312). Exact browser prefixes only.
  'com.google.Chrome.',
  '.com.google.Chrome.',
  'org.chromium.Chromium.',
  '.org.chromium.Chromium.',
]);

export function groupLeakPrefix(name) {
  return name.replace(/[0-9a-zA-Z]{6,}$/, '') || name;
}

/** Empty shared containers/zero-byte logs contain no leaked fixture data. */
export function isEffectivelyEmpty(path) {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return true;
  }
  if (stat.isFile()) return stat.size === 0;
  if (!stat.isDirectory()) return false;
  let children;
  try {
    children = readdirSync(path);
  } catch {
    return true;
  }
  return children.every((child) => isEffectivelyEmpty(join(path, child)));
}

export function teardown() {
  const root = process.env.PORTOS_TEST_TEMP_ROOT;
  if (!root) return;
  let entries;
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  entries = entries
    .filter((name) => name !== OWNER_FILE)
    .filter((name) => !VITEST_INTERNAL_SCRATCH_DIR.test(name))
    .filter((name) => !TOOLCHAIN_CACHE_PREFIXES.has(groupLeakPrefix(name)))
    .filter((name) => !isEffectivelyEmpty(join(root, name)));

  const byPrefix = new Map();
  for (const name of entries) {
    const prefix = groupLeakPrefix(name);
    byPrefix.set(prefix, (byPrefix.get(prefix) || 0) + 1);
  }
  for (const [prefix, count] of byPrefix) {
    console.warn(`⚠️ test temp leak: ${prefix} ×${count}`);
  }
  if (entries.length) process.exitCode = 1;

  try {
    rmSync(root, { recursive: true, force: true });
  } catch (err) {
    // A Windows worker may still hold an open handle. Leave ownership stamped
    // so the next runner can reclaim it once the owner is gone.
    console.warn(`⚠️ could not remove run temp root ${root}: ${err.message}`);
  }
}
