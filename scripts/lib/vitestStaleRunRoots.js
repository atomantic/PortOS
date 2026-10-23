/**
 * Owner-aware sweep of run-scoped temp roots (#9113, #9804).
 *
 * Workspace configs and the CI launcher stamp `.owner.pid` in each root. A
 * killed run never reaches its runner close hook, so its root is
 * left behind; the next config load calls `sweepStaleRunRoots()` to reclaim
 * it for the caller's exact prefix (default `pvt-`). A recorded owner that is provably gone frees the root immediately, an
 * owner that is alive keeps it however old it is (a >6h run must not be swept
 * from under itself), and a root whose owner cannot be determined falls back
 * to the conservative 6h age rule.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { processAncestors, probeTestPid, readTestProcesses, testProcessRoot, testProcessSettlement } from './testOwnedProcesses.js';
import { processAttribution, processIdentity } from './testProcessAttribution.js';
import { killWithEscalation } from '../../server/lib/killWithEscalation.js';

export const OWNER_FILE = '.owner.pid';
export const PENDING_FILE = '.process-settlement-pending';

function markPending(root) {
  try { writeFileSync(join(root, PENDING_FILE), 'unverified\n'); } catch { /* preserve in this snapshot even if the stamp fails */ }
}
export const STALE_ROOT_AGE_MS = 6 * 60 * 60 * 1000;
// `ps -o lstart=` has 1s resolution and the recorded start is derived from
// process.uptime(), so allow slack before calling a pid "reused".
const START_TOLERANCE_MS = 5000;

/** Record this process as the root's owner: `<pid> <start-ms>`. */
export function writeOwnerFile(root) {
  const startMs = Math.round(Date.now() - process.uptime() * 1000);
  writeFileSync(join(root, OWNER_FILE), `${process.pid} ${startMs}\n`);
}

/** Process state and start time of a live pid, or null when it cannot be read (always null on win32). */
function readProcessInfo(pid, { exec = execFileSync } = {}) {
  if (process.platform === 'win32') return null;
  try {
    const out = exec('ps', ['-o', 'stat=,lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, LC_ALL: 'C' },
    }).trim();
    if (!out) return null;
    const match = /^(\S+)\s+(.+)$/.exec(out);
    if (!match) return null;
    const stat = match[1];
    const ms = Date.parse(match[2].trim());
    return {
      zombie: stat.startsWith('Z'),
      startMs: Number.isNaN(ms) ? null : ms,
    };
  } catch {
    return null;
  }
}

/** Start time of a live pid in ms, or null when it cannot be read or is a zombie. */
function readProcessStartMs(pid, options) {
  const info = readProcessInfo(pid, options);
  return info?.zombie ? null : (info?.startMs ?? null);
}

/**
 * true = owner alive, false = owner gone (or pid reused), null = unknown.
 * `process.kill(pid, 0)` throws ESRCH for a missing pid and EPERM for a live
 * pid owned by someone else (alive).
 */
export function isOwnerAlive({ pid, startMs }, { exec = execFileSync } = {}) {
  try {
    process.kill(pid, 0);
  } catch (err) {
    if (err.code === 'ESRCH') return false;
    if (err.code !== 'EPERM') return null;
  }
  const info = readProcessInfo(pid, { exec });
  if (info?.zombie) return false;
  if (!info && process.platform !== 'win32') {
    try {
      process.kill(pid, 0);
    } catch (err) {
      if (err.code === 'ESRCH') return false;
    }
  }
  const liveStart = info?.startMs ?? null;
  if (liveStart === null || !Number.isFinite(startMs)) return true;
  return Math.abs(liveStart - startMs) <= START_TOLERANCE_MS;
}

function readOwner(path) {
  try {
    const [pid, startMs] = readFileSync(join(path, OWNER_FILE), 'utf8').trim().split(/\s+/).map(Number);
    return Number.isSafeInteger(pid) && pid > 0 && Number.isFinite(startMs) && startMs >= 0 ? { pid, startMs } : null;
  } catch {
    return null;
  }
}

function rootIsOrphaned(root, probe, now) {
  try {
    const stat = lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    const owner = readOwner(root);
    const alive = owner ? probe(owner) : null;
    return alive === false || (alive === null && now - stat.mtimeMs > STALE_ROOT_AGE_MS);
  } catch (error) { return error.code === 'ENOENT'; }
}

// Only fixed categories leave the private process snapshot; never argv or env.
function processKind({ args = [] }) {
  const executable = basename(args[0] ?? '').toLowerCase();
  if (executable === 'esbuild') return 'esbuild';
  if (/^(node|nodejs)(\.exe)?$/.test(executable)) {
    if (args.some(arg => /[/\\]tinypool[/\\]/.test(arg))) return 'tinypool';
    if (args.some(arg => /[/\\]vitest[/\\]/.test(arg))) return 'vitest';
    return 'node';
  }
  if (/^(chrome|chromium|google chrome|google chrome helper)(\.exe)?$/.test(executable)) return 'browser';
  if (/^(sh|bash|zsh)$/.test(executable)) return 'shell';
  if (/^python[0-9.]*$/.test(executable)) return 'python';
  return 'other';
}

function ownedSnapshot(parent, prefix, read) {
  const records = read();
  if (!Array.isArray(records)) return null;
  const ancestors = processAncestors(records);
  if (!ancestors) return null;
  const owned = records.flatMap(record => {
    if (record.terminal || !Number.isSafeInteger(record.pid) || record.pid <= 1 || typeof record.start !== 'string' || !record.start) return [];
    const root = testProcessRoot(record, parent, prefix);
    return root && !ancestors.has(record.pid) ? [{ pid: record.pid, start: record.start, root, kind: processKind(record), parent: ancestors.has(record.ppid) ? 'runner' : 'descendant', identity: processIdentity(record) }] : [];
  });
  return { ancestors, owned };
}

function stillOwned(record, snapshot, parent, prefix, read) {
  const current = read([...snapshot.ancestors, record.pid]);
  if (!Array.isArray(current)) return false;
  const ancestors = processAncestors(current);
  const live = current.find(item => item.pid === record.pid);
  return ancestors && !ancestors.has(record.pid) && live?.start === record.start
    && testProcessRoot(live, parent, prefix) === record.root;
}

export function terminatePid(record, { valid, kill = (pid, signal) => process.kill(pid, signal) }) {
  const signal = kind => {
    if (!valid()) return false;
    try { kill(record.pid, kind); return true; } catch { return false; }
  };
  return killWithEscalation({ exitCode: null, signalCode: null, kill: signal },
    { label: 'Orphaned test process', stillRunning: valid, delayMs: 2000 });
}

/** Only individually proven processes are signalled; an unowned group member is never collateral cleanup.
 * Synchronous settlement also serves Node's exit hook, where promises cannot be awaited.
 */
export function killTestProcessesUnder(root, { read = readTestProcesses, probe = isOwnerAlive,
  kill = (pid, signal) => process.kill(pid, signal), onKilled = () => {}, onOutcome = () => {}, onInspection = () => {},
  probePid = probeTestPid, now = () => performance.now(), wait = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
  settlementMs = 2000 } = {}) {
  let rootExists = true;
  try { const stat = lstatSync(root); if (!stat.isDirectory() || stat.isSymbolicLink()) return 0; } catch (error) {
    if (error.code !== 'ENOENT') return 0;
    rootExists = false;
  }
  const parent = dirname(root);
  const prefix = basename(root);
  const snapshot = ownedSnapshot(parent, prefix, read);
  onInspection(snapshot !== null);
  if (!snapshot) return 0;
  const owner = readOwner(root);
  if (rootExists && !owner) return 0;
  if (owner) {
    const startMs = snapshot.ancestors.has(owner.pid) ? readProcessStartMs(owner.pid) : null;
    const verifiedOwner = startMs !== null && Number.isFinite(owner.startMs)
      && Math.abs(startMs - owner.startMs) <= START_TOLERANCE_MS;
    if (!verifiedOwner && probe(owner) !== false) return 0;
  }
  const pending = [];
  for (const record of snapshot.owned) {
    if (record.root !== root) continue;
    const verified = stillOwned(record, snapshot, parent, prefix, read);
    if (!verified && testProcessSettlement(record, read([record.pid]), probePid) === 'terminated') continue;
    // Read the bounded attribution before signaling; it cannot be reconstructed
    // after the suite worker or run root disappears.
    const attribution = processAttribution(root, record.identity);
    let signal = 'not-attempted';
    if (verified) {
      try { kill(record.pid, 'SIGKILL'); signal = 'delivered'; } catch { signal = 'failed'; }
    }
    pending.push({ record, attribution, signal, settlement: 'unknown' });
  }
  const deadline = now() + settlementMs;
  while (pending.some(item => item.settlement !== 'terminated')) {
    const current = read(pending.map(item => item.record.pid));
    for (const item of pending) {
      if (item.settlement !== 'terminated') item.settlement = testProcessSettlement(item.record, current, probePid);
    }
    if (pending.every(item => item.settlement === 'terminated') || now() >= deadline) break;
    wait(Math.min(25, deadline - now()));
  }
  let killed = 0;
  for (const { record, attribution, signal, settlement } of pending) {
    const outcome = { kind: record.kind, parent: record.parent, ...attribution, signal,
      settlement: settlement === 'running' ? 'unconfirmed' : settlement };
    onOutcome(outcome);
    if (settlement !== 'terminated') markPending(root);
    if (settlement === 'terminated') {
      killed++;
      onKilled({ kind: record.kind, parent: record.parent });
    }
  }
  return killed;
}

export function sweepOrphanedTestProcesses(tmpRoot, { prefix = 'pvt-', now = Date.now(), probe = isOwnerAlive,
  read = readTestProcesses, terminate = terminatePid } = {}) {
  const snapshot = ownedSnapshot(tmpRoot, prefix, read);
  if (!snapshot) return { signaled: 0, inspected: false, preserved: new Set() };
  const preserved = new Set();
  let signaled = 0;
  for (const record of snapshot.owned) {
    const valid = () => stillOwned(record, snapshot, tmpRoot, prefix, read)
      && rootIsOrphaned(record.root, probe, Date.now());
    if (!rootIsOrphaned(record.root, probe, now) || !valid()) { preserved.add(record.root); continue; }
    // Escalation is deferred; retain this root until a later snapshot proves
    // its children gone. Signal scheduling is not verified termination.
    preserved.add(record.root);
    markPending(record.root);
    try { terminate(record, { valid }); signaled++; } catch { /* settlement unknown */ }
  }
  if (signaled) console.warn(`🧹 Requested termination of ${signaled} interrupted-run test processes; settlement pending`);
  return { signaled, inspected: true, preserved };
}

// Retain the established import boundary while callers adopt the broader name.
export const killTestBrowsersUnder = killTestProcessesUnder;

export function sweepStaleRunRoots(tmpRoot, { prefix = 'pvt-', now = Date.now(), probe = isOwnerAlive, read = readTestProcesses, terminate = terminatePid } = {}) {
  // Require an exact directory-name prefix, never a path or an empty match.
  if (typeof prefix !== 'string' || !/^[a-zA-Z0-9-]+-$/.test(prefix)) {
    throw new Error('Owned temp prefix must be a nonempty name ending in a hyphen');
  }
  // Dead-owner evidence is sufficient to reclaim a root even if process
  // inspection failed. Unknown owners still require inspection before aging out.
  const { inspected, preserved } = sweepOrphanedTestProcesses(tmpRoot, { prefix, now, probe, read, terminate });
  let names;
  try {
    names = readdirSync(tmpRoot);
  } catch {
    return; // unreadable tmp dir — skip rather than fail config load
  }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const path = join(tmpRoot, name);
    if (preserved.has(path) || (!inspected && existsSync(join(path, PENDING_FILE)))) continue;
    try {
      const stat = lstatSync(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      const owner = readOwner(path);
      const alive = owner ? probe(owner) : null;
      if (alive === true) continue;
      if (alive === false || (inspected && now - stat.mtimeMs > STALE_ROOT_AGE_MS)) {
        rmSync(path, { recursive: true, force: true });
      }
    } catch {
      // Already gone, or a permissions/race hiccup — best-effort sweep only.
    }
  }
}
