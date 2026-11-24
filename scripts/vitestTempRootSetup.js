/**
 * Run-wide teardown shared by both workspace configs. Config-load bootstrap
 * redirects temp APIs before Vitest creates its module-transform cache.
 * The server's exclusive capture projects share this single global owner.
 */
import { closeSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { OWNER_FILE, killTestProcessesUnder, waitForVitestWatchdog } from './lib/vitestStaleRunRoots.js';

export function setup({ vitest }) {
  const root = process.env.PORTOS_TEST_TEMP_ROOT;
  // Vitest runs global teardown before closing its worker pool. Its close hook
  // runs after pool.close(), so live runner workers are not mistaken for leaks.
  vitest.onClose(async () => {
    const records = root && process.platform !== 'win32' ? await waitForVitestWatchdog(root) : undefined;
    cleanupRunTempRoot(root, { reportPath: process.env.PORTOS_TEST_PROCESS_DIAGNOSTICS_PATH, records });
  });
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
  // Chrome for Testing has its own bundle ID, so its scratch prefix differs.
  'com.google.chrome.for.testing.',
  // Chrome's component updater stages unpacked downloads in this exact prefix.
  'com.google.Chrome.chrome_chrome_Unpacker_BeginUnzipping.',
  // Component download scratch uses this exact prefix (the underscore precedes
  // the random-name separator; keep it when comparing grouped leak prefixes).
  'com.google.Chrome.chrome_chrome_url_fetcher_.',
  '.com.google.Chrome.',
  'org.chromium.Chromium.',
  '.org.chromium.Chromium.',
]);

// Written by server/lib/mockPathsDataRoot.js: one `<dir>\t<test file>` line per
// root it minted. Read bounded so a runaway file cannot stall teardown.
const OWNERS_FILE = '.leak-owners';
const OWNERS_READ_LIMIT = 256 * 1024;

function readTempRootOwners(root) {
  const owners = new Map();
  let fd;
  try {
    fd = openSync(join(root, OWNERS_FILE), 'r');
    const buffer = Buffer.alloc(OWNERS_READ_LIMIT);
    const text = buffer.toString('utf8', 0, readSync(fd, buffer, 0, OWNERS_READ_LIMIT, 0));
    for (const line of text.split('\n')) {
      const [dir, owner] = line.split('\t');
      if (dir && owner) owners.set(dir, owner);
    }
  } catch { /* diagnostics only; a missing or unreadable sidecar just drops attribution */ }
  if (fd !== undefined) closeSync(fd);
  return owners;
}
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

/** Persist the diagnostics report for an explicit CI path; returns whether it was retained. */
function persistProcessReport(reportPath, report) {
  if (!reportPath) return { retained: false, failed: false };
  try {
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, JSON.stringify(report));
    return { retained: true, failed: false };
  } catch {
    console.error('❌ owned test process evidence could not be persisted');
    return { retained: false, failed: true };
  }
}

/** Terminate leaked test processes and report them; returns the count of unsettled ones. */
function containRunProcesses(root, { contain, reportPath, records, platform }) {
  // A process a suite failed to tear down would outlive the run (#10840).
  const outcomes = [];
  let total = 0;
  let unsettled = 0;
  let inspected = true;
  const processes = platform === 'win32' ? 0 : contain(root, {
    records,
    onInspection: value => { inspected = value; if (!value) unsettled++; },
    onOutcome: outcome => {
      total++;
      if (outcome.settlement !== 'terminated') unsettled++;
      if (outcomes.length < 64) outcomes.push(outcome);
    },
  });
  if (!total && inspected) return unsettled;
  const report = { version: 1, inspected, boundary: 'pool-closed', total, terminated: processes, unsettled, capped: total > outcomes.length, processes: outcomes };
  // Diagnostics are written only for an explicit CI path; local runs rely on stderr.
  const { retained, failed } = persistProcessReport(reportPath, report);
  if (failed) unsettled++;
  console.warn(`⚠️ test process leak: signal/settlement evidence=${retained ? 'retained' : 'stderr-only'} inspected=${inspected}; found=${total} terminated=${processes} unsettled=${unsettled}`);
  for (const outcome of outcomes) console.warn(`⚠️ owned test process: ${Object.entries(outcome).map(([key, value]) => `${key}=${value}`).join(' ')}`);
  return unsettled;
}

// Ordered cheapest-first; each decides whether a root entry is not leaked fixture data.
const IGNORED_TEMP_ENTRY_RULES = [
  (_root, name) => name === OWNER_FILE || name === OWNERS_FILE,
  (_root, name) => VITEST_INTERNAL_SCRATCH_DIR.test(name),
  (_root, name) => TOOLCHAIN_CACHE_PREFIXES.has(groupLeakPrefix(name)),
  isDotnetRegistrationCache,
  // A rejected registration cache stays a leak even if the generic empty
  // scan cannot read it; unknown cache contents must fail closed.
  (root, name) => name !== DOTNET_REGISTRATION_CACHE && isEffectivelyEmpty(join(root, name)),
];

function isIgnoredTempEntry(root, name) {
  return IGNORED_TEMP_ENTRY_RULES.some(rule => rule(root, name));
}

/** Warn per leaked-entry group and fail the run when anything leaked. */
function reportLeakedEntries(root, entries) {
  const owners = readTempRootOwners(root);
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
  if (!entries.length) return;
  // This runs in vitest.onClose, after the reporter's exit-code snapshot, and
  // is the only place a run whose every assertion passed is made to fail.
  // Name it so the nonzero exit never reads as unexplained (#12536).
  console.error(`❌ test temp leak guard: failing the run with exit code 1 for ${entries.length} leaked ${entries.length === 1 ? 'entry' : 'entries'} under the run temp root`);
  process.exitCode = 1;
}

export function cleanupRunTempRoot(root = process.env.PORTOS_TEST_TEMP_ROOT, options = {}) {
  if (!root) return;
  const { contain = killTestProcessesUnder, reportPath, records, platform = process.platform } = options;
  if (containRunProcesses(root, { contain, reportPath, records, platform })) {
    process.exitCode = 1;
    console.error('❌ owned test process settlement unverified; retaining run temp root');
    return;
  }
  let names;
  try {
    names = readdirSync(root);
  } catch {
    return;
  }
  reportLeakedEntries(root, names.filter(name => !isIgnoredTempEntry(root, name)));
  try {
    rmSync(root, { recursive: true, force: true });
  } catch (err) {
    // A Windows worker may still hold an open handle. Leave ownership stamped
    // so the next runner can reclaim it once the owner is gone.
    console.warn(`⚠️ could not remove run temp root ${root}: ${err.message}`);
  }
}
