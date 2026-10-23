import { channel } from 'node:diagnostics_channel';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { observeTestProcesses, processAttribution, processIdentity } from './lib/testProcessAttribution.js';
import { killTestProcessesUnder } from './lib/vitestStaleRunRoots.js';
import { cleanupRunTempRoot } from './vitestTempRootSetup.js';

const originalExit = process.exitCode;
afterEach(() => { process.exitCode = originalExit; vi.restoreAllMocks(); });

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
