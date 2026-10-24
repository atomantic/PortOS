/**
 * Run-wide teardown shared by both workspace configs. Config-load bootstrap
 * redirects temp APIs before Vitest creates its module-transform cache.
 * The server's exclusive capture projects share this single global owner.
 */
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PROCESS_OWNERS_DIR } from './lib/testProcessAttribution.js';
import { lstatSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describeOwnedBrowserObservation, describeStageFixtureRoot, readOwnedBrowserObservations } from '../server/test/ownedBrowserDiagnostics.js';
import { OWNER_FILE, PENDING_FILE, killTestProcessesUnder, verifyPendingTestProcesses } from './lib/vitestStaleRunRoots.js';

export function setup({ vitest }) {
  const root = process.env.PORTOS_TEST_TEMP_ROOT;
  // Vitest runs global teardown before closing its worker pool. Its close hook
  // runs after pool.close(), so live runner workers are not mistaken for leaks.
  vitest.onClose(() => cleanupRunTempRoot(root, { reportPath: process.env.PORTOS_TEST_PROCESS_DIAGNOSTICS_PATH, durable: true }));
}

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
const DOTNET_REGISTRATION_CACHE = 'system-commandline-sentinel-files';

function isDotnetRegistrationCache(root, name) {
  // System.CommandLine (also used by Git Credential Manager) writes these
  // registration receipts under TEMP, not under a fixture's own directory:
  // https://github.com/git-ecosystem/git-credential-manager/issues/505
  if (name !== DOTNET_REGISTRATION_CACHE) return false;
  const path = join(root, name);
  try {
    if (!lstatSync(path).isDirectory()) return false;
    const entries = readdirSync(path);
    return entries.every(entry =>
      entry.startsWith('dotnet-suggest-registration-')
      && entry.length > 'dotnet-suggest-registration-'.length
      && lstatSync(join(path, entry)).isFile());
  } catch {
    return false;
  }
}

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

export function cleanupRunTempRoot(root = process.env.PORTOS_TEST_TEMP_ROOT, { contain = killTestProcessesUnder, reportPath, durable = false, platform = process.platform, verifyPending = verifyPendingTestProcesses } = {}) {
  if (!root) return;
  // A process a suite failed to tear down would outlive the run (#10840).
  const outcomes = [];
  let total = 0;
  let unsettled = 0;
  let inspected = true;
  const processes = platform === 'win32' ? 0 : contain(root, {
    onInspection: value => { inspected = value; if (!value) unsettled++; },
    onOutcome: outcome => {
      total++;
      if (outcome.settlement !== 'terminated') unsettled++;
      if (outcomes.length < 64) outcomes.push(outcome);
    },
  });
  const pendingVerified = platform === 'win32' || verifyPending(root);
  if (!pendingVerified) unsettled++;
  if (total || !inspected || !pendingVerified) {
    const report = { version: 1, inspected, pendingVerified, boundary: 'pool-closed', total, terminated: processes, unsettled, capped: total > outcomes.length, processes: outcomes };
    const retainedPath = join(fileURLToPath(new URL('../.cache/test-process-diagnostics/', import.meta.url)), `${randomUUID()}.json`);
    const destinations = reportPath ? [reportPath, ...(durable ? [retainedPath] : [])] : [retainedPath];
    let retained = true;
    try {
      for (const destination of destinations) {
        mkdirSync(dirname(destination), { recursive: true });
        writeFileSync(destination, JSON.stringify(report));
      }
    } catch {
      retained = false;
      console.error('❌ owned test process evidence could not be persisted');
      unsettled++;
    }
    console.warn(`⚠️ test process leak: signal/settlement evidence=${retained ? 'retained' : 'unavailable'} inspected=${inspected}; found=${total} terminated=${processes} unsettled=${unsettled}`);
    for (const outcome of outcomes) console.warn(`⚠️ owned test process: ${Object.entries(outcome).map(([key, value]) => `${key}=${value}`).join(' ')}`);
  }
  if (unsettled) {
    process.exitCode = 1;
    console.error('❌ owned test process settlement unverified; retaining run temp root');
    return;
  }
  let entries;
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  entries = entries
    .filter((name) => name !== OWNER_FILE && name !== PENDING_FILE && name !== OWNERS_FILE && name !== PROCESS_OWNERS_DIR)
    .filter((name) => !VITEST_INTERNAL_SCRATCH_DIR.test(name))
    .filter((name) => !TOOLCHAIN_CACHE_PREFIXES.has(groupLeakPrefix(name)))
    .filter((name) => !isDotnetRegistrationCache(root, name))
    // A rejected registration cache stays a leak even if the generic empty
    // scan cannot read it; unknown cache contents must fail closed.
    .filter((name) => name === DOTNET_REGISTRATION_CACHE || !isEffectivelyEmpty(join(root, name)));

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
  if (entries.length) {
    // This runs in vitest.onClose, after the reporter's exit-code snapshot, and
    // is the only place a run whose every assertion passed is made to fail.
    // Name it so the nonzero exit never reads as unexplained (#12536).
    console.error(`❌ test temp leak guard: failing the run with exit code 1 for ${entries.length} leaked ${entries.length === 1 ? 'entry' : 'entries'} under the run temp root`);
    process.exitCode = 1;
  }

  try {
    rmSync(root, { recursive: true, force: true });
  } catch (err) {
    // A Windows worker may still hold an open handle. Leave ownership stamped
    // so the next runner can reclaim it once the owner is gone.
    console.warn(`⚠️ could not remove run temp root ${root}: ${err.message}`);
  }
}
