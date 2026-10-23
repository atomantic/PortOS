import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ownershipKeys = new Set(['PORTOS_TEST_TEMP_ROOT', 'TMPDIR', 'VITEST', 'NODE_ENV']);

function legacyBrowserProcesses(pids, exec) {
  try {
    const output = exec('ps', [...(pids ? ['-p', pids.join(',')] : ['-A']), '-ww', '-o', 'pid=,ppid=,uid=,stat=,lstart=,args='], {
      encoding: 'utf8', timeout: 5000, maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, LC_ALL: 'C' },
    });
    return output.split('\n').flatMap(line => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/.exec(line);
      if (!match || Number(match[3]) !== process.getuid()) return [];
      // Compatibility only: this is the pre-existing browser flag rule. Flat
      // ps text is never used to infer generic argv or environment ownership.
      const profile = /(?:^|\s)--user-data-dir=(\S+)/.exec(match[6])?.[1];
      return [{ pid: Number(match[1]), ppid: Number(match[2]), start: `legacy:${match[5]}`, terminal: match[4].startsWith('Z'),
        args: profile ? [`--user-data-dir=${profile}`] : [], env: {}, ownershipComplete: Boolean(profile) }];
    });
  } catch { return null; }
}

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

// The Darwin reader uses the existing system Python, with no installation or
// cache. Missing capabilities fail closed; raw metadata never reaches a log.
export function readTestProcesses(pids = null, { platform = process.platform, exec } = {}) {
  try {
    const execute = exec ?? execFileSync;
    if (platform === 'darwin') {
      try {
        const reader = join(dirname(fileURLToPath(import.meta.url)), 'darwinTestProcesses.py');
        return JSON.parse(execute('/usr/bin/python3', ['-I', '-S', reader], {
          input: JSON.stringify(pids), encoding: 'utf8', timeout: 5000,
          maxBuffer: 16 * 1024 * 1024, stdio: ['pipe', 'pipe', 'ignore'],
        }));
      } catch { return legacyBrowserProcesses(pids, execute); }
    }
    if (platform !== 'linux') return null;
    const ids = pids ?? readdirSync('/proc').filter(name => /^\d+$/.test(name)).map(Number);
    return ids.map(linuxProcess).filter(Boolean);
  } catch { return null; }
}

function rootUnder(path, parent, prefix) {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) return null;
  const rel = relative(parent, path);
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) return null;
  const name = rel.split(sep)[0];
  return name.startsWith(prefix) ? join(parent, name) : null;
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
    const root = rootUnder(arg.startsWith('--user-data-dir=') ? arg.slice(16) : arg, parent, prefix);
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
  // A fallback reader uses a different identity encoding; that is not PID reuse.
  if (current.start.startsWith('legacy:') !== record.start.startsWith('legacy:')) return 'unknown';
  if (current.start !== record.start) return 'terminated';
  return 'running';
}
