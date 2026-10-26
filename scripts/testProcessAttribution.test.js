import { channel } from 'node:diagnostics_channel';
import { EventEmitter } from 'node:events';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { observeTestProcesses, processAttribution, processIdentity } from './lib/testProcessAttribution.js';
import { killTestProcessesUnder, sweepStaleRunRoots, verifyPendingTestProcesses } from './lib/vitestStaleRunRoots.js';
import { readTestProcesses } from './lib/testOwnedProcesses.js';
import { cleanupRunTempRoot } from './vitestTempRootSetup.js';

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, appendFileSync: vi.fn(actual.appendFileSync) };
});

const originalExit = process.exitCode;
afterEach(() => { process.exitCode = originalExit; vi.useRealTimers(); vi.restoreAllMocks(); });

// Regression: a suite-ended child must be attributed before the root disappears,
// while a successful signal cannot remove that root until terminal identity exists.
it.each(['terminated', 'unconfirmed', 'unknown'])('retains sanitized spawn ownership and %s settlement through run cleanup', settlement => {
  const host = mkdtempSync(join(tmpdir(), 'process-evidence-'));
  const root = mkdtempSync(join(host, 'pvt-'));
  const reportPath = join(host, 'processes.json');
  const records = [{ pid: process.pid, ppid: process.ppid }, { pid: process.ppid, ppid: 1 }];
  const record = { pid: 900001, ppid: process.pid, start: 'birth-private-sentinel', args: ['/example/node', 'private-argument'],
    env: { NODE_ENV: 'test', PORTOS_TEST_TEMP_ROOT: root } };
  writeFileSync(join(root, '.owner.pid'), '999999 0\n');
  let suite = fileURLToPath(import.meta.url);
  const dispose = observeTestProcesses(() => suite, { root, read: () => [record] });
  const child = Object.assign(new EventEmitter(), { pid: record.pid });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    channel('child_process').publish({ process: child });
    child.emit('spawn');
    suite = '/private/not-the-spawning-suite.test.js';
    dispose();
    expect(processAttribution(root, processIdentity(record))).toMatchObject({ suite: 'scripts/testProcessAttribution.test.js', phase: 'suite-ended', lifecycle: 'spawned' });
    expect(processAttribution(root, processIdentity({ ...record, start: 'reused' })).attribution).toBe('unavailable');
    let time = 0;
    const contain = (path, callbacks) => killTestProcessesUnder(path, { ...callbacks,
      read: () => time > 0 && settlement === 'unknown' ? null : [...records, { ...record, terminal: time > 0 && settlement === 'terminated' }],
      probe: () => false, probePid: () => true, kill: () => {}, now: () => time, wait: ms => { time += ms; }, settlementMs: 50 });
    cleanupRunTempRoot(root, { contain, reportPath, platform: 'linux' });
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    expect(report.processes).toEqual([expect.objectContaining({ suite: 'scripts/testProcessAttribution.test.js', phase: 'suite-ended', lifecycle: 'spawned', signal: 'delivered', settlement })]);
    expect(existsSync(root)).toBe(settlement !== 'terminated');
    if (settlement !== 'terminated') expect(process.exitCode).toBe(1);
    expect(JSON.stringify(report)).not.toMatch(/private|900001|999999|birth-|argument|\/tmp\/|\/Users\//);
  } finally { dispose(); rmSync(host, { recursive: true, force: true }); }
});

it('retains the root and an explicit diagnostic gap when process inspection fails', () => {
  const host = mkdtempSync(join(tmpdir(), 'process-inspection-'));
  const root = mkdtempSync(join(host, 'pvt-'));
  const reportPath = join(host, 'processes.json');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    cleanupRunTempRoot(root, { reportPath, platform: 'linux',
      contain: (path, callbacks) => killTestProcessesUnder(path, { ...callbacks, read: () => null }) });
    expect(JSON.parse(readFileSync(reportPath, 'utf8'))).toMatchObject({ inspected: false, total: 0, terminated: 0, unsettled: 1 });
    expect(process.exitCode).toBe(1);
    expect(existsSync(root)).toBe(true);
  } finally { rmSync(host, { recursive: true, force: true }); }
});

it.each(['persisted', 'write-failed'])('pool-close preserves a %s pending identity omitted from current ownership metadata', persistence => {
  const host = mkdtempSync(join(tmpdir(), 'process-pending-close-'));
  const root = mkdtempSync(join(host, 'pvt-'));
  const reportPath = join(host, 'processes.json');
  const ancestors = [{ pid: process.pid, ppid: process.ppid }, { pid: process.ppid, ppid: 1 }];
  const child = { pid: 900001, ppid: process.pid, start: 'original', args: ['node'], env: { NODE_ENV: 'test', PORTOS_TEST_TEMP_ROOT: root } };
  writeFileSync(join(root, '.owner.pid'), '999999 0\n');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    if (persistence === 'write-failed') appendFileSync.mockImplementationOnce(() => { throw Object.assign(Error('synthetic full disk'), { code: 'ENOSPC' }); });
    sweepStaleRunRoots(host, { read: () => [...ancestors, child], probe: () => false, terminate: () => {} });
    const partial = () => [...ancestors, { pid: child.pid, ppid: process.pid, start: child.start }];
    sweepStaleRunRoots(host, { read: partial, probe: () => false, probePid: () => true });
    expect(existsSync(root)).toBe(true);
    cleanupRunTempRoot(root, { reportPath, platform: 'linux',
      contain: (path, callbacks) => killTestProcessesUnder(path, { ...callbacks, read: partial, probe: () => false, probePid: () => true }),
      verifyPending: path => verifyPendingTestProcesses(path, { read: partial, probePid: () => true }) });
    expect(existsSync(root)).toBe(true);
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(readFileSync(reportPath, 'utf8'))).toMatchObject({ pendingVerified: false, unsettled: 1 });
    expect(verifyPendingTestProcesses(root, { read: () => [], probePid: () => false })).toBe(true);
  } finally { rmSync(host, { recursive: true, force: true }); }
});

// Regression: short Git commands must not each start an OS reader, while a
// surviving child still retains its original suite and terminal lifecycle.
it('batches surviving children and flushes recent spawns at teardown without inspecting closed commands', () => {
  vi.useFakeTimers();
  const root = mkdtempSync(join(tmpdir(), 'process-batched-'));
  const records = [900001, 900002, 900003].map(pid => ({ pid, ppid: process.pid, start: `birth-${pid}` }));
  const read = vi.fn(pids => records.filter(record => pids.includes(record.pid)));
  let suite = fileURLToPath(import.meta.url);
  const dispose = observeTestProcesses(() => suite, { root, read });
  const launch = pid => {
    const child = Object.assign(new EventEmitter(), { pid });
    channel('child_process').publish({ process: child });
    child.emit('spawn');
    return child;
  };
  try {
    for (let i = 0; i < 100; i++) {
      const child = launch(910000 + i);
      child.emit('exit');
      child.emit('close');
    }
    vi.advanceTimersByTime(250);
    expect(read).not.toHaveBeenCalled();
    const first = launch(records[0].pid);
    launch(records[1].pid);
    suite = '/example/another.test.js';
    vi.advanceTimersByTime(249);
    expect(read).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(read.mock.calls).toEqual([[[records[0].pid, records[1].pid]]]);
    expect(processAttribution(root, processIdentity(records[0]))).toMatchObject({ suite: 'scripts/testProcessAttribution.test.js', phase: 'suite-active', lifecycle: 'spawned' });
    first.emit('exit');
    expect(processAttribution(root, processIdentity(records[0])).lifecycle).toBe('exit-observed');
    first.emit('close');
    expect(processAttribution(root, processIdentity(records[0])).attribution).toBe('unavailable');
    launch(records[2].pid);
    dispose();
    expect(read.mock.calls).toEqual([[[records[0].pid, records[1].pid]], [[records[2].pid]]]);
    expect(processAttribution(root, processIdentity(records[1]))).toMatchObject({ suite: 'scripts/testProcessAttribution.test.js', phase: 'suite-ended', lifecycle: 'spawned' });
    expect(processAttribution(root, processIdentity(records[2]))).toMatchObject({ phase: 'suite-ended', lifecycle: 'spawned' });
    vi.advanceTimersByTime(1000);
    expect(read).toHaveBeenCalledTimes(2);
  } finally { dispose(); rmSync(root, { recursive: true, force: true }); }
});

it.each(['missing', 'terminal', 'different-parent', 'unreadable'])('does not attribute a deferred %s process identity', state => {
  const root = mkdtempSync(join(tmpdir(), 'process-identity-gap-'));
  const record = { pid: 900001, ppid: process.pid, start: 'original' };
  const read = () => {
    if (state === 'unreadable') throw Error('synthetic unavailable reader');
    return state === 'missing' ? [] : [{ ...record, terminal: state === 'terminal', ppid: state === 'different-parent' ? 1 : process.pid }];
  };
  const dispose = observeTestProcesses(() => fileURLToPath(import.meta.url), { root, read });
  try {
    const child = Object.assign(new EventEmitter(), { pid: record.pid });
    channel('child_process').publish({ process: child });
    child.emit('spawn');
    dispose();
    expect(processAttribution(root, processIdentity(record)).attribution).toBe('unavailable');
  } finally { dispose(); rmSync(root, { recursive: true, force: true }); }
});

// Regression: pool-close evidence must explain inspection failures without
// exporting OS error payloads or converting unknown ownership into permission.
it.skipIf(process.platform === 'win32').each([
  ['timeouts', 'timeout', 'timeout', 'reader-unavailable'],
  ['permissions', 'permission-denied', 'spawn-failed', 'reader-unavailable'],
  ['malformed', 'invalid-output', 'invalid-output', 'reader-unavailable'],
  ['wrong-shape', 'invalid-output', 'invalid-output', 'reader-unavailable'],
  ['reader-exit', 'reader-failed', 'reader-failed', 'reader-unavailable'],
  ['ancestry', 'success', null, 'ancestry-unavailable'],
  ['fallback', 'timeout', 'success', 'available'],
])('retains bounded %s inspection evidence at pool close', (mode, primary, fallback, reason) => {
  const host = mkdtempSync(join(tmpdir(), 'inspection-evidence-'));
  const root = mkdtempSync(join(host, 'pvt-'));
  const reportPath = join(host, 'report.json');
  const kill = vi.fn();
  let time = 0;
  const exec = vi.fn(command => {
    time += command === 'ps' ? 11 : 7;
    if (mode === 'malformed') return 'private-argv /private/path secret-env=hidden 900001';
    if (mode === 'wrong-shape') return command === 'ps' ? 'private-invalid-row' : '{"pid":900001}';
    if (mode === 'ancestry') return JSON.stringify([{ pid: 900001, ppid: 1, start: 'private-birth' }]);
    if (mode === 'fallback' && command === 'ps') {
      return `${process.pid} 1 ${process.getuid()} S Fri Oct 16 12:00:00 2026 node private-argv\n`;
    }
    throw Object.assign(new Error('private-argv /private/path secret-env=hidden 900001'), {
      code: mode === 'permissions' ? (command === 'ps' ? 'ENOENT' : 'EPERM') : mode === 'reader-exit' ? 'PRIVATE_CODE' : 'ETIMEDOUT',
      stdout: 'private-output', stderr: 'private-error', pid: 900001,
    });
  });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    cleanupRunTempRoot(root, { reportPath, platform: 'darwin',
      contain: (path, callbacks) => killTestProcessesUnder(path, { ...callbacks, kill,
        read: (pids, options) => readTestProcesses(pids, { ...options, platform: 'darwin', exec, now: () => time }) }) });
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    const attempts = [{ reader: 'darwin-python', outcome: primary, elapsedMs: 7 },
      ...(fallback ? [{ reader: 'legacy-ps', outcome: fallback, elapsedMs: 11 }] : [])];
    expect(report).toMatchObject({ version: 1, boundary: 'pool-closed', inspected: reason === 'available',
      pendingVerified: true, total: 0, terminated: 0, unsettled: reason === 'available' ? 0 : 1,
      inspection: { reason, attempts }, processes: [] });
    expect(exec).toHaveBeenCalledTimes(attempts.length);
    expect(kill).not.toHaveBeenCalled();
    expect(existsSync(root)).toBe(reason !== 'available');
    expect(process.exitCode).toBe(reason === 'available' ? originalExit : 1);
    expect(JSON.stringify(report)).not.toMatch(/private|secret|900001|PRIVATE_CODE|stdout|stderr/);
    expect(JSON.stringify([console.warn.mock.calls, console.error.mock.calls])).not.toMatch(/private|secret|900001/);
  } finally { rmSync(host, { recursive: true, force: true }); }
});
