import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STALE_ROOT_AGE_MS, killTestProcessesUnder, sweepStaleRunRoots, writeOwnerFile } from './lib/vitestStaleRunRoots.js';
import { observeTestProcesses } from './lib/testProcessAttribution.js';
import { processAncestors, readTestProcesses, testProcessRoot } from './lib/testOwnedProcesses.js';
import { isProcessAlive } from '../server/test/processAlive.js';

afterEach(() => vi.useRealTimers());

describe('test process ownership boundaries', () => {
  it('keeps the known ancestor chain when a listing omits a parent, but rejects cycles', () => {
    const records = [{ pid: 900001, ppid: 900002 }, { pid: 900002, ppid: 900003 }];
    expect(processAncestors(records, 900004)).toBeNull();
    expect(processAncestors(records, 900001)).toEqual(new Set([1, 900001, process.ppid, 900002, 900003]));
    expect(processAncestors([...records, { pid: 900003, ownershipComplete: false }], 900001))
      .toEqual(new Set([1, 900001, process.ppid, 900002, 900003]));
    expect(processAncestors([...records, { pid: 900003, ppid: 900001 }], 900001)).toBeNull();
  });

  it.each(['complete ancestry', 'unavailable reader', 'cyclic ancestry'])('requires process inspection before reclaiming dead or aged roots with %s', mode => {
    const host = mkdtempSync(join(tmpdir(), 'recovery-snapshot-'));
    const dead = join(host, 'pvt-dead');
    const live = join(host, 'pvt-live');
    const unknown = join(host, 'pvt-unknown');
    const records = [{ pid: process.pid, ppid: process.ppid }];
    if (mode === 'cyclic ancestry') records.push({ pid: process.ppid, ppid: process.pid });
    const read = () => mode === 'unavailable reader' ? null : records;
    const aged = new Date(Date.now() - STALE_ROOT_AGE_MS - 60000);
    try {
      for (const [root, pid] of [[dead, 900001], [live, 900002], [unknown, 900003]]) {
        mkdirSync(root);
        writeFileSync(join(root, '.owner.pid'), `${pid} 0\n`);
        utimesSync(root, aged, aged);
      }
      sweepStaleRunRoots(host, { read, probe: ({ pid }) => pid === 900001 ? false : pid === 900002 ? true : null });
      expect(existsSync(dead)).toBe(process.platform !== 'win32' && mode !== 'complete ancestry');
      expect(existsSync(live)).toBe(true);
      expect(existsSync(unknown)).toBe(mode !== 'complete ancestry');
    } finally { rmSync(host, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform === 'win32')('retains only legacy browser ownership when the optional Darwin reader is unavailable', () => {
    const exec = vi.fn((command) => {
      if (command !== 'ps') throw Error('reader unavailable');
      return `900001 1 ${process.getuid()} S Fri Oct 16 12:00:00 2026 chrome --user-data-dir=/tmp/example/pvt-browser/profile\n`
        + `900002 1 ${process.getuid()} S Fri Oct 16 12:00:00 2026 node /tmp/example/pvt-script/file.js PORTOS_TEST_TEMP_ROOT=/tmp/example/pvt-env NODE_ENV=test\n`;
    });
    const records = readTestProcesses(null, { platform: 'darwin', exec });
    expect(records.map(record => testProcessRoot(record, '/tmp/example', 'pvt-'))).toEqual(['/tmp/example/pvt-browser', null]);
    expect(exec.mock.calls[1][1]).not.toContain('-E');
  });

  it('accepts exact structured fields and path arguments, never assignment-like script or environment text', () => {
    const parent = join(tmpdir(), 'synthetic-parent');
    const root = join(parent, 'pvt-owned');
    expect(testProcessRoot({ env: { NODE_ENV: 'test', PORTOS_TEST_TEMP_ROOT: root } }, parent, 'pvt-')).toBe(root);
    expect(testProcessRoot({ env: { NODE_ENV: 'test', PORTOS_TEST_TEMP_ROOT: `${root}/nested` } }, parent, 'pvt-')).toBeNull();
    expect(testProcessRoot({ args: ['sh', `${root}/fixture.sh`] }, parent, 'pvt-')).toBe(root);
    expect(testProcessRoot({ args: ['node', '-e', `--user-data-dir=${root}/profile`],
      env: { OTHER: `PORTOS_TEST_TEMP_ROOT=${root} NODE_ENV=test` } }, parent, 'pvt-')).toBeNull();
    expect(testProcessRoot({ args: ['node', '-e', root], env: { NODE_ENV: 'test', TMPDIR: `${parent}/unrelated` } }, parent, 'pvt-')).toBeNull();
    for (const option of ['-lc', '-xc', '-pe']) {
      expect(testProcessRoot({ args: ['sh', option, `${root}/script; echo text`] }, parent, 'pvt-')).toBeNull();
    }
    expect(testProcessRoot({ args: ['chrome', `--user-data-dir=${root}/profile`] }, parent, 'pvt-')).toBe(root);
  });

  it('waits for terminal birth identity after signaling and distinguishes unconfirmed or unknown settlement', () => {
    const host = mkdtempSync(join(tmpdir(), 'recovery-diagnostics-'));
    const root = join(host, 'pvt-owned');
    mkdirSync(root);
    writeFileSync(join(root, '.owner.pid'), '999999 0\n');
    const ancestors = [{ pid: process.pid, ppid: process.ppid }, { pid: process.ppid, ppid: 1 }];
    const child = { pid: 900001, ppid: process.pid, start: 'original',
      args: ['/example/node', '/example/vitest/dist/workers/forks.js', '--secret=fixture-secret'],
      env: { NODE_ENV: 'test', PORTOS_TEST_TEMP_ROOT: root } };
    try {
      for (const mode of ['terminal', 'reused', 'unconfirmed', 'unknown', 'signal-failed']) {
        let time = 0;
        let signaled = false;
        const onKilled = vi.fn();
        const onOutcome = vi.fn();
        const read = () => !signaled || time === 0 ? [...ancestors, child]
          : mode === 'unknown' ? null
            : [...ancestors, { ...child, terminal: mode === 'terminal', start: mode === 'reused' ? 'replacement' : child.start }];
        const kill = vi.fn(() => { signaled = true; if (mode === 'signal-failed') throw Error('denied'); });
        const result = killTestProcessesUnder(root, { read, probe: () => false, probePid: () => true, kill, onKilled, onOutcome,
          now: () => time, wait: ms => { expect(onKilled).not.toHaveBeenCalled(); time += ms; }, settlementMs: 50 });
        const terminated = ['terminal', 'reused'].includes(mode);
        expect(result).toBe(terminated ? 1 : 0);
        expect(kill).toHaveBeenCalledExactlyOnceWith(child.pid, 'SIGKILL');
        expect(onOutcome).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind: 'vitest', parent: 'runner',
          signal: mode === 'signal-failed' ? 'failed' : 'delivered',
          settlement: terminated ? 'terminated' : mode === 'unknown' ? 'unknown' : 'unconfirmed' }));
        expect(JSON.stringify(onOutcome.mock.calls)).not.toMatch(/fixture-secret|900001|original|example/);
      }
    } finally { rmSync(host, { recursive: true, force: true }); }
  });

  it('retains pending identities through partial inventories until terminal evidence permits root removal', () => {
    const host = mkdtempSync(join(tmpdir(), 'recovery-pending-'));
    const root = join(host, 'pvt-owned'); mkdirSync(root);
    writeFileSync(join(root, '.owner.pid'), '999999 0\n');
    const ancestors = [{ pid: process.pid, ppid: process.ppid }, { pid: process.ppid, ppid: 1 }];
    const child = { pid: 900001, ppid: 1, start: 'original', env: { NODE_ENV: 'test', PORTOS_TEST_TEMP_ROOT: root } };
    const terminate = vi.fn();
    const sweep = records => sweepStaleRunRoots(host, { read: () => [...ancestors, ...records], probe: () => false, probePid: () => true, terminate });
    try {
      sweep([child]);
      expect(terminate).toHaveBeenCalledTimes(1);
      sweep([{ pid: child.pid, ppid: 1, start: child.start }]);
      expect(existsSync(root)).toBe(true);
      sweep([]); // omitted rows plus a live PID remain unknown
      expect(existsSync(root)).toBe(true);
      sweep([{ pid: child.pid, ppid: 1, start: 'replacement', args: ['node'], env: {} }]);
      expect(existsSync(root)).toBe(false);
      expect(terminate).toHaveBeenCalledTimes(1); // no signal to a replacement identity
    } finally { rmSync(host, { recursive: true, force: true }); }
  });

  it('refuses reused identities, caller ancestors and ownership changes before delayed escalation', () => {
    vi.useFakeTimers();
    const host = mkdtempSync(join(tmpdir(), 'recovery-race-'));
    const root = join(host, 'pvt-owned'); mkdirSync(root);
    writeFileSync(join(root, '.owner.pid'), '999999 0\n');
    const target = { pid: 900001, ppid: 1, start: 'original', args: [], env: { NODE_ENV: 'test', PORTOS_TEST_TEMP_ROOT: root } };
    const ancestors = [{ ...target, pid: process.pid, ppid: process.ppid, start: 'caller' },
      { pid: process.ppid, ppid: 1, start: 'parent' }];
    const read = () => [...ancestors, target];
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    let ownerAlive = false;
    try {
      sweepStaleRunRoots(host, { read, probe: () => ownerAlive });
      expect(kill).toHaveBeenCalledExactlyOnceWith(target.pid, 'SIGTERM');
      sweepStaleRunRoots(host, { read: () => null, probe: () => false, probePid: () => true });
      expect(existsSync(root)).toBe(true); // unknown settlement cannot erase a prior pending stamp
      sweepStaleRunRoots(host, { read: () => [...ancestors, { pid: target.pid, ppid: 1, start: target.start }], probe: () => false, probePid: () => true });
      expect(existsSync(root)).toBe(true); // a partial inventory cannot erase the still-live identity
      target.start = 'reused';
      vi.advanceTimersByTime(2000);
      expect(kill).toHaveBeenCalledTimes(1);
      expect(existsSync(root)).toBe(true); writeFileSync(join(root, '.owner.pid'), '999999 0\n');
      target.start = 'next';
      sweepStaleRunRoots(host, { read, probe: () => ownerAlive });
      expect(kill).toHaveBeenCalledTimes(2);
      expect(existsSync(root)).toBe(true); writeOwnerFile(root); ownerAlive = true;
      vi.advanceTimersByTime(2000);
      expect(kill).toHaveBeenCalledTimes(2);
      expect(killTestProcessesUnder(root, { read: () => ancestors, probe: () => true, kill })).toBe(0);
      expect(killTestProcessesUnder(root, { read: () => [target], kill })).toBe(0);
      writeFileSync(join(root, '.owner.pid'), '900009 0\n');
      expect(killTestProcessesUnder(root, { read, probe: () => true, kill })).toBe(0);
      expect(killTestProcessesUnder(root, { read, probe: () => null, kill })).toBe(0);
      rmSync(join(root, '.owner.pid'));
      expect(killTestProcessesUnder(root, { read, kill })).toBe(0);
      writeFileSync(join(root, '.owner.pid'), 'malformed');
      expect(killTestProcessesUnder(root, { read, kill })).toBe(0);
      const link = join(host, 'pvt-linked');
      symlinkSync(root, link, process.platform === 'win32' ? 'junction' : 'dir');
      target.env.PORTOS_TEST_TEMP_ROOT = link;
      sweepStaleRunRoots(host, { read, probe: () => false });
      expect(kill).toHaveBeenCalledTimes(2);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
    } finally { kill.mockRestore(); rmSync(host, { recursive: true, force: true }); }
  });
});

describe.skipIf(process.platform === 'win32')('real interrupted-run recovery', () => {
  it('reaps environment-only and script-path children while preserving unrelated and live-owner processes', async () => {
    const host = mkdtempSync(join(tmpdir(), 'recovery-owned-'));
    const children = [];
    const launch = async (args, env = {}) => {
      const child = spawn(args[0], args.slice(1), { env: { PATH: process.env.PATH, ...env }, detached: true, stdio: ['pipe', 'pipe', 'ignore'] });
      children.push(child);
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(Error('synthetic child readiness timed out')), 5000);
        child.once('error', reject);
        child.stdout.once('data', () => { clearTimeout(timeout); resolve(); });
      });
      return child;
    };
    const code = "process.on('SIGTERM',()=>{}); process.stdout.write('ready'); setInterval(()=>{},1000)";
    try {
      const dead = join(host, 'pvt-dead'); const live = join(host, 'pvt-live');
      mkdirSync(dead); mkdirSync(live); writeOwnerFile(live);
      const owner = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' });
      writeFileSync(join(dead, '.owner.pid'), `${owner.pid} 0\n`);
      const environmentOnly = await launch([process.execPath, '-e', code], { NODE_ENV: 'test', PORTOS_TEST_TEMP_ROOT: dead });
      const script = join(dead, 'fixture.sh'); writeFileSync(script, 'echo ready\nread answer\n');
      const argumentOnly = await launch(['/bin/sh', script]);
      const unrelated = await launch([process.execPath, '-e', code], { OTHER: `PORTOS_TEST_TEMP_ROOT=${dead} NODE_ENV=test` });
      const dispose = observeTestProcesses(() => fileURLToPath(import.meta.url), { root: live });
      let ownedLive;
      try { ownedLive = await launch([process.execPath, '-e', code], { NODE_ENV: 'test', PORTOS_TEST_TEMP_ROOT: live }); }
      finally { dispose(); }
      const inspected = readTestProcesses([environmentOnly.pid, argumentOnly.pid, unrelated.pid]);
      expect(inspected?.map(record => testProcessRoot(record, host, 'pvt-'))).toEqual([dead, dead, null]);
      sweepStaleRunRoots(host);
      await vi.waitFor(() => {
        expect(isProcessAlive(environmentOnly.pid)).toBe(false);
        expect(isProcessAlive(argumentOnly.pid)).toBe(false);
      }, { timeout: 5000 });
      expect(isProcessAlive(unrelated.pid)).toBe(true);
      expect(isProcessAlive(ownedLive.pid)).toBe(true);
      const outcomes = [];
      expect(killTestProcessesUnder(live, { onOutcome: outcome => outcomes.push(outcome) })).toBe(1);
      expect(outcomes).toEqual([expect.objectContaining({ suite: 'scripts/testOwnedProcessRecovery.test.js', phase: 'suite-ended', lifecycle: 'spawned', settlement: 'terminated' })]);
      await vi.waitFor(() => expect(isProcessAlive(ownedLive.pid)).toBe(false));
    } finally {
      await Promise.all(children.map(child => new Promise(resolve => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve();
        child.once('close', resolve); child.kill('SIGKILL');
      })));
      rmSync(host, { recursive: true, force: true });
    }
  }, 15000);

  it('the run owner exit hook stops its non-browser child', async () => {
    const host = mkdtempSync(join(tmpdir(), 'recovery-exit-'));
    let childPid;
    try {
      const module = fileURLToPath(new URL('./lib/vitestTempRoot.js', import.meta.url));
      const env = { ...process.env, TMPDIR: host, TMP: host, TEMP: host };
      delete env.PORTOS_TEST_TEMP_ROOT; delete env.VITEST_POOL_ID; delete env.VITEST_WORKER_ID;
      const owner = spawnSync(process.execPath, ['--input-type=module', '-e', `
        import { bootstrapVitestTempRoot } from ${JSON.stringify(module)};
        import { spawn } from 'node:child_process';
        bootstrapVitestTempRoot();
        const child = spawn(process.execPath, ['-e', "process.send('ready'); setInterval(()=>{},1000)"], { env: { ...process.env, NODE_ENV: 'test' }, detached: true, stdio: ['ignore','ignore','ignore','ipc'] });
        child.once('message', () => { process.stdout.write(String(child.pid)); child.disconnect(); child.unref(); });
      `], { env, encoding: 'utf8', timeout: 15000 });
      childPid = Number(owner.stdout);
      expect(owner.status).toBe(0);
      expect(childPid).toBeGreaterThan(1);
      await vi.waitFor(() => expect(isProcessAlive(childPid)).toBe(false));
    } finally {
      if (childPid > 1 && isProcessAlive(childPid)) process.kill(childPid, 'SIGKILL');
      rmSync(host, { recursive: true, force: true });
    }
  }, 20000);
});
