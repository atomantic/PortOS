import { execFile, execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const ownershipKeys = new Set(['PORTOS_TEST_TEMP_ROOT', 'TMPDIR', 'VITEST', 'NODE_ENV']);

function linuxIdentity(pid) {
  const path = `/proc/${pid}`;
  if (statSync(path).uid !== process.getuid()) return null;
  const stat = readFileSync(join(path, 'stat'), 'utf8');
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  return { pid, ppid: Number(fields[1]), start: fields[19], terminal: fields[0] === 'Z' };
}

function linuxProcess(pid) {
  const unavailable = () => probeTestPid(pid) === false ? null : { pid, ownershipComplete: false };
  try {
    const before = linuxIdentity(pid);
    if (!before) return null;
    let metadata = {};
    try {
      const args = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
      const env = {};
      for (const entry of readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')) {
        const equals = entry.indexOf('=');
        const key = entry.slice(0, equals);
        if (equals < 0 || !ownershipKeys.has(key)) continue;
        if (Object.hasOwn(env, key)) throw Error('duplicate ownership field');
        env[key] = entry.slice(equals + 1);
      }
      metadata = { args, env };
    } catch { /* retain ancestry without claiming ownership */ }
    const after = linuxIdentity(pid);
    return after?.start === before.start && after.ppid === before.ppid ? { ...before, ...metadata } : unavailable();
  } catch { return unavailable(); }
}

function validProcessRecords(records) {
  return Array.isArray(records) && records.every(record => record && Number.isSafeInteger(record.pid) && record.pid > 0
    && (record.args === undefined || (Array.isArray(record.args) && record.args.every(arg => typeof arg === 'string')))
    && (record.env === undefined || (record.env !== null && typeof record.env === 'object' && !Array.isArray(record.env)
      && Object.values(record.env).every(value => typeof value === 'string'))));
}

// The Darwin reader uses the existing system Python, with no installation or
// cache. Missing capabilities fail closed as null; raw metadata and OS error
// payloads never leave this boundary.
const DARWIN_READER = ['/usr/bin/python3', ['-I', '-S', join(dirname(fileURLToPath(import.meta.url)), 'darwinTestProcesses.py')]];
const DARWIN_READ_LIMITS = { encoding: 'utf8', timeout: 5000, maxBuffer: 16 * 1024 * 1024 };

export function readTestProcesses(pids = null, { platform = process.platform, exec = execFileSync } = {}) {
  try {
    let records = null;
    if (platform === 'darwin') {
      records = JSON.parse(exec(...DARWIN_READER, {
        ...DARWIN_READ_LIMITS, input: JSON.stringify(pids), stdio: ['pipe', 'pipe', 'ignore'],
      }));
    } else if (platform === 'linux') {
      const ids = pids ?? readdirSync('/proc').filter(name => /^\d+$/.test(name)).map(Number);
      records = ids.map(linuxProcess).filter(Boolean);
    }
    return validProcessRecords(records) ? records : null;
  } catch { return null; }
}

/**
 * `readTestProcesses` for callers racing their own deadlines: the Darwin reader
 * runs without blocking the event loop those timers live on.
 */
export async function readTestProcessesAsync(pids = null, { timeoutMs = DARWIN_READ_LIMITS.timeout } = {}) {
  if (process.platform !== 'darwin') return readTestProcesses(pids);
  try {
    const reading = promisify(execFile)(...DARWIN_READER, {
      ...DARWIN_READ_LIMITS, timeout: Math.min(DARWIN_READ_LIMITS.timeout, timeoutMs), killSignal: 'SIGKILL',
    });
    // A reader that dies before reading its request already rejects `reading`.
    reading.child.stdin.on('error', () => {});
    reading.child.stdin.end(JSON.stringify(pids));
    const records = JSON.parse((await reading).stdout);
    return validProcessRecords(records) ? records : null;
  } catch { return null; }
}

function rootUnder(path, parent, prefix) {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) return null;
  const rel = relative(parent, path);
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) return null;
  const name = rel.split(sep)[0];
  return name.startsWith(prefix) ? join(parent, name) : null;
}

// Chrome resolves its crash database path, and macOS reaches temp roots through
// a symlink, so a detached handler names the same root by its resolved parent.
function databaseRootUnder(path, parent, prefix) {
  const named = rootUnder(path, parent, prefix);
  if (named) return named;
  try {
    const resolved = rootUnder(path, realpathSync(parent), prefix);
    return resolved && join(parent, basename(resolved));
  } catch { return null; }
}

export function testProcessRoot({ args = [], env = {} }, parent, prefix) {
  const roots = new Set();
  if (env.NODE_ENV === 'test' || env.VITEST === 'true') {
    const root = rootUnder(env.PORTOS_TEST_TEMP_ROOT ?? env.TMPDIR, parent, prefix);
    if (root && (env.PORTOS_TEST_TEMP_ROOT === undefined || root === env.PORTOS_TEST_TEMP_ROOT)) roots.add(root);
  }
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    // Script text is data, even when it happens to be an absolute path.
    if (['--eval', '--print', '--command'].includes(arg) || /^-[A-Za-z]*[ecp][A-Za-z]*$/.test(arg)) { index++; continue; }
    const root = arg.startsWith('--database=') ? databaseRootUnder(arg.slice(11), parent, prefix)
      : rootUnder(arg.startsWith('--user-data-dir=') ? arg.slice(16) : arg, parent, prefix);
    if (root) roots.add(root);
  }
  return roots.size === 1 ? [...roots][0] : null;
}

export function processAncestors(records, pid = process.pid) {
  const parents = new Map();
  for (const record of records || []) {
    // An incomplete identity row has a pid and no parent. It is a gap in the
    // chain, not a parent link, and must not void every other owned process.
    if (Number.isSafeInteger(record?.pid) && Number.isSafeInteger(record.ppid) && record.ppid >= 1) {
      parents.set(record.pid, record.ppid);
    }
  }
  if (!Number.isSafeInteger(pid) || pid < 1 || !parents.has(pid)) return null;
  const ancestors = new Set([1, pid, process.ppid]);
  const visited = new Set();
  while (pid > 1) {
    if (visited.has(pid)) return null;
    visited.add(pid);
    // Readers may omit an ancestor owned by another uid, or return it without
    // a parent. Keep every known ancestor excluded without requiring init.
    if (!parents.has(pid)) return ancestors;
    const parent = parents.get(pid);
    if (parent === pid) return null;
    if (parent === 1) return ancestors;
    ancestors.add(parent);
    pid = parent;
  }
  return ancestors;
}

/** A missing inventory row is not proof of exit: readers can lose permission. */
export function probeTestPid(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'ESRCH' ? false : null; }
}

export function testProcessSettlement(record, records, probe = probeTestPid) {
  const current = Array.isArray(records) ? records.find(item => item.pid === record.pid) : null;
  if (!current) return probe(record.pid) === false ? 'terminated' : 'unknown';
  if (typeof current.start !== 'string' || !current.start) return 'unknown';
  if (current.terminal === true) return 'terminated';
  if (current.start !== record.start) return 'terminated';
  return 'running';
}
