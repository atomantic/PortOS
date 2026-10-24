import { channel } from 'node:diagnostics_channel';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTestProcesses } from './testOwnedProcesses.js';

export const PROCESS_OWNERS_DIR = '.process-owners';
// Vitest can load this module from a fixture whose import.meta.url is not a
// file URL. Suite identity is optional; a missing root must not throw at import.
const repo = (() => {
  try {
    const url = new URL('../../', import.meta.url);
    return url.protocol === 'file:' ? fileURLToPath(url) : null;
  } catch { return null; }
})();
const spawned = channel('child_process');
const limit = 64;
const safeSuite = value => typeof value === 'string' && value.length <= 240
  && /^(?:server|client|scripts|lib|autofixer)\/(?:[\w.-]+\/)*[\w.-]+\.(?:test|spec)\.[cm]?[jt]sx?$/.test(value)
  && !value.split('/').includes('..');
const suiteIdentity = value => {
  if (!repo || typeof value !== 'string') return 'unavailable';
  const path = relative(repo, value).split(sep).join('/');
  return safeSuite(path) ? path : 'unavailable';
};
const workerIdentity = value => /^\d{1,6}$/.test(value ?? '') ? String(value) : 'unavailable';
export const processIdentity = ({ pid, start }) => createHash('sha256').update(`${pid}:${start}`).digest('hex');

/** Capture the suite at child construction, never the suite active at cleanup. */
export function observeTestProcesses(getSuite, { root = process.env.PORTOS_TEST_TEMP_ROOT, read = readTestProcesses } = {}) {
  if (!root) return () => {};
  const directory = join(root, PROCESS_OWNERS_DIR);
  const path = join(directory, `${randomUUID()}.json`);
  const children = new Map();
  const pending = new Set();
  let inspectionTimer;
  const worker = workerIdentity(process.env.VITEST_WORKER_ID);
  let phase = 'suite-active';
  let capped = false;
  const persist = () => {
    try {
      if (!children.size && !capped) { rmSync(path, { force: true }); return; }
      mkdirSync(directory, { recursive: true });
      writeFileSync(`${path}.tmp`, JSON.stringify({ capped, children: [...children.values()].map(item => item.row) }));
      renameSync(`${path}.tmp`, path);
    } catch { /* missing evidence is explicitly unavailable at containment */ }
  };
  const inspectPending = () => {
    clearTimeout(inspectionTimer);
    inspectionTimer = undefined;
    const candidates = [...pending];
    pending.clear();
    if (!candidates.length) return;
    try {
      const records = read(candidates.map(child => child.pid));
      for (const child of candidates) {
        const item = children.get(child);
        const record = records?.find(record => record.pid === child.pid);
        if (item && record?.start && !record.terminal && record.ppid === process.pid) item.row.identity = processIdentity(record);
      }
    } catch { /* attribution remains unavailable, never guess by PID */ }
    persist();
  };
  const listener = ({ process: child }) => {
    if (children.size >= limit) { capped = true; persist(); return; }
    let suite = 'unavailable';
    try { suite = suiteIdentity(getSuite()); } catch { /* diagnostic context is optional */ }
    const row = { identity: null, suite, worker, phase, lifecycle: 'constructed' };
    const onSpawn = () => {
      row.lifecycle = 'spawned';
      pending.add(child);
      // Most Git children close within milliseconds. Inspect survivors together
      // rather than starting a synchronous OS reader for every short command.
      inspectionTimer ??= setTimeout(inspectPending, 250).unref();
    };
    const onExit = () => {
      pending.delete(child);
      row.lifecycle = 'exit-observed';
      if (row.identity) persist();
    };
    const onClose = () => {
      pending.delete(child);
      children.delete(child);
      if (row.identity) persist();
      if (!pending.size) { clearTimeout(inspectionTimer); inspectionTimer = undefined; }
    };
    children.set(child, { row, onSpawn, onExit, onClose });
    child.once('spawn', onSpawn);
    child.once('exit', onExit);
    child.once('close', onClose);
  };
  spawned.subscribe(listener);
  return () => {
    spawned.unsubscribe(listener);
    // Teardown cannot leave a timer or lose a live child born just before it.
    if (pending.size) inspectPending();
    clearTimeout(inspectionTimer);
    phase = 'suite-ended';
    for (const [child, item] of children) {
      item.row.phase = phase;
      child.removeListener('spawn', item.onSpawn);
      child.removeListener('exit', item.onExit);
      child.removeListener('close', item.onClose);
    }
    persist();
  };
}

/** All on-disk input is reprojected; no raw process data enters the report. */
export function processAttribution(root, identity) {
  const unavailable = state => ({ suite: 'unavailable', worker: 'unavailable', phase: 'unavailable', lifecycle: 'unavailable', attribution: state });
  try {
    const directory = join(root, PROCESS_OWNERS_DIR);
    const names = readdirSync(directory);
    if (names.length > 256) return unavailable('capped');
    let capped = false;
    let match;
    for (const name of names) {
      if (!/^[\da-f-]{36}\.json$/.test(name)) continue;
      const path = join(directory, name);
      if (statSync(path).size > 48_000) return unavailable('capped');
      const data = JSON.parse(readFileSync(path, 'utf8'));
      if (!Array.isArray(data.children) || data.children.length > limit) return unavailable('unavailable');
      capped ||= data.capped === true;
      for (const item of data.children) {
        if (item.identity !== identity) continue;
        if (match) return unavailable('ambiguous');
        match = { suite: safeSuite(item.suite) ? item.suite : 'unavailable', worker: workerIdentity(item.worker),
          phase: ['suite-active', 'suite-ended'].includes(item.phase) ? item.phase : 'unavailable',
          lifecycle: ['constructed', 'spawned', 'exit-observed'].includes(item.lifecycle) ? item.lifecycle : 'unavailable',
          attribution: 'observed' };
      }
    }
    return match ?? unavailable(capped ? 'capped' : 'unavailable');
  } catch { return unavailable('unavailable'); }
}
