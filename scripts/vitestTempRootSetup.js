/**
 * Run-wide teardown shared by both workspace configs. Config-load bootstrap
 * redirects temp APIs before Vitest creates its module-transform cache.
 * The server's exclusive capture projects share this single global owner.
 */
import { lstatSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describeOwnedBrowserObservation, describeStageFixtureRoot, readOwnedBrowserObservations } from '../server/test/ownedBrowserDiagnostics.js';
import { OWNER_FILE, killTestProcessesUnder } from './lib/vitestStaleRunRoots.js';

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
  // Chrome's component updater stages unpacked downloads in this exact prefix.
  'com.google.Chrome.chrome_chrome_Unpacker_BeginUnzipping.',
  // Component download scratch uses this exact prefix (the underscore precedes
  // the random-name separator; keep it when comparing grouped leak prefixes).
  'com.google.Chrome.chrome_chrome_url_fetcher_.',
  '.com.google.Chrome.',
  'org.chromium.Chromium.',
  '.org.chromium.Chromium.',
]);

// Written by server/lib/mockPathsDataRoot.js (`<dir>\t<test file>` per root it
// minted), plus optional bounded composition snapshots. The decoder reaches
// only Node builtins and the existing owner writer, never a service graph.
const OWNERS_FILE = '.leak-owners';

export function groupLeakPrefix(name) {
  return name.replace(/[0-9a-zA-Z]{6,}$/, '') || name;
}

/** Empty shared containers/zero-byte logs contain no leaked fixture data. */
export function isEffectivelyEmpty(path) {
  let stat;
  try {
    // A leftover fixture can link outside the run root or back into itself.
    // Inspect the link, never its target: following branching cycles can keep
    // this synchronous scan busy indefinitely before cleanup gets a chance.
    stat = lstatSync(path);
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
  // A process a suite failed to tear down would outlive the run (#10840).
  const processes = process.platform === 'win32' ? 0 : killTestProcessesUnder(root);
  if (processes) console.warn(`⚠️ test process leak: stopped ${processes} process${processes === 1 ? '' : 'es'} still running under the run temp root`);
  let entries;
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  entries = entries
    .filter((name) => name !== OWNER_FILE && name !== OWNERS_FILE)
    .filter((name) => !VITEST_INTERNAL_SCRATCH_DIR.test(name))
    .filter((name) => !TOOLCHAIN_CACHE_PREFIXES.has(groupLeakPrefix(name)))
    .filter((name) => !isEffectivelyEmpty(join(root, name)));

  const { owners, observations, state } = readOwnedBrowserObservations(root);
  const byPrefix = new Map();
  for (const name of entries) {
    const prefix = groupLeakPrefix(name);
    const group = byPrefix.get(prefix) || { count: 0, files: new Set() };
    group.count++;
    if (owners.has(name)) group.files.add(owners.get(name));
    byPrefix.set(prefix, group);
  }
  for (const [prefix, { count, files }] of byPrefix) {
    const by = files.size ? ` (created by ${[...files].join(', ')})` : '';
    console.warn(`⚠️ test temp leak: ${prefix} ×${count}${by}`);
  }
  const composition = entries.filter(name => name.startsWith('portos-composition-browser-'));
  for (const [index, name] of composition.slice(0, 8).entries()) {
    console.warn(`⚠️ composition profile ${index + 1}: ${describeOwnedBrowserObservation(observations.get(name), state)}`);
  }
  if (composition.length > 8) console.warn(`⚠️ composition profile provenance capped: ${composition.length - 8} additional entries`);
  const stages = entries.filter(name => name.startsWith('portos-code-animation-stages-'));
  for (const [index, name] of stages.slice(0, 8).entries()) {
    console.warn(`⚠️ stage fixture ${index + 1}: ${describeStageFixtureRoot(join(root, name), observations.get(name), state)}`);
  }
  if (stages.length > 8) console.warn(`⚠️ stage fixture provenance capped: ${stages.length - 8} additional entries`);
  if (entries.length) process.exitCode = 1;

  try {
    rmSync(root, { recursive: true, force: true });
  } catch (err) {
    // A Windows worker may still hold an open handle. Leave ownership stamped
    // so the next runner can reclaim it once the owner is gone.
    console.warn(`⚠️ could not remove run temp root ${root}: ${err.message}`);
  }
}
