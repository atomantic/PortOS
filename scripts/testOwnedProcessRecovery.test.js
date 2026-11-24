import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STALE_ROOT_AGE_MS, killTestProcessesUnder, sweepOrphanedTestProcesses, sweepStaleRunRoots, waitForVitestWatchdog, writeOwnerFile } from './lib/vitestStaleRunRoots.js';
import { processAncestors, readTestProcesses, testProcessRoot, testProcessSettlement } from './lib/testOwnedProcesses.js';
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

  it('reuses a seeded post-close inventory so clean containment crawls the process table at most once', async () => {
    const host = mkdtempSync(join(tmpdir(), 'recovery-seed-'));
    const root = join(host, 'pvt-run');
    mkdirSync(root);
    try {
      const records = [{ pid: process.pid, ppid: process.ppid, start: 'now' }];
      const read = vi.fn(() => records);
      expect(await waitForVitestWatchdog(root, { read })).toBe(records);
      expect(read).toHaveBeenCalledTimes(1);
      writeOwnerFile(root);
      expect(killTestProcessesUnder(root, { read, records })).toBe(0);
      expect(read).toHaveBeenCalledTimes(1);
    } finally { rmSync(host, { recursive: true, force: true }); }
  });

  it('skips process inspection when every root is live, fresh or foreign', () => {
    const host = mkdtempSync(join(tmpdir(), 'recovery-clean-'));
    const read = vi.fn(() => null);
    const aged = new Date(Date.now() - STALE_ROOT_AGE_MS - 60000);
    const sweep = () => sweepStaleRunRoots(host, { read, probe: ({ pid }) => pid === 900002 });
    try {
      for (const [name, pid] of [['pvt-live', 900002], ['pvt-fresh'], ['unrelated', 900001]]) {
        mkdirSync(join(host, name));
        if (pid) writeFileSync(join(host, name, '.owner.pid'), `${pid} 0\n`);
      }
      utimesSync(join(host, 'pvt-live'), aged, aged);
      utimesSync(join(host, 'unrelated'), aged, aged);
      writeFileSync(join(host, 'pvt-file'), '');
      sweep();
      expect(read).not.toHaveBeenCalled();
      writeFileSync(join(host, 'pvt-fresh', '.owner.pid'), '900001 0\n');
      sweep();
      expect(read).toHaveBeenCalledTimes(1);
      expect(existsSync(join(host, 'pvt-live'))).toBe(true);
    } finally { rmSync(host, { recursive: true, force: true }); }
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
    expect(testProcessRoot({ args: ['handler', `--database=${root}/crashpad`] }, parent, 'pvt-')).toBe(root);
    expect(testProcessRoot({ args: ['handler', `--database=${parent}/unrelated/crashpad`] }, parent, 'pvt-')).toBeNull();
  });

  it('owns a detached crash handler by the resolved database path Chrome reports', () => {
    const host = mkdtempSync(join(tmpdir(), 'recovery-database-'));
    const parent = join(host, 'alias');
    const resolved = join(realpathSync(host), 'resolved');
    mkdirSync(resolved);
    symlinkSync(resolved, parent, 'dir');
    try {
      const owner = path => testProcessRoot({ args: ['handler', `--database=${path}/crashpad`], env: {} }, parent, 'pvt-');
      expect(owner(join(resolved, 'pvt-owned', 'fixture'))).toBe(join(parent, 'pvt-owned'));
      expect(owner(join(resolved, 'other', 'fixture'))).toBeNull();
      expect(owner(join(host, 'pvt-owned'))).toBeNull();
    } finally { rmSync(host, { recursive: true, force: true }); }
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

  it.each(['disconnects', 'hangs'])('gives the pool watchdog time to exit before containment when it %s', async mode => {
    const host = mkdtempSync(join(tmpdir(), 'recovery-watchdog-'));
    const root = join(host, 'pvt-owned');
    mkdirSync(root);
    writeFileSync(join(root, '.owner.pid'), '999999 0\n');
    const runner = { pid: process.pid, ppid: process.ppid };
    const watchdog = { pid: 900001, ppid: process.pid, start: 'original', args: ['vitest-watchdog'],
      env: { NODE_ENV: 'test', PORTOS_TEST_TEMP_ROOT: root } };
    let elapsed = 0;
    let killed = false;
    const read = () => [runner, { ...watchdog, terminal: killed || (mode === 'disconnects' && elapsed >= 25) }];
    const kill = vi.fn(() => {
      expect(elapsed).toBe(50);
      killed = true;
    });
    const onOutcome = vi.fn();
    try {
      await waitForVitestWatchdog(root, { read, graceMs: 50, now: () => elapsed, wait: async ms => { elapsed += ms; } });
      const result = killTestProcessesUnder(root, { read, probe: () => false, kill, onOutcome });
      if (mode === 'disconnects') {
        expect(elapsed).toBe(25);
        expect(result).toBe(0);
        expect(kill).not.toHaveBeenCalled();
        expect(onOutcome).not.toHaveBeenCalled();
      } else {
        expect(result).toBe(1);
        expect(kill).toHaveBeenCalledExactlyOnceWith(watchdog.pid, 'SIGKILL');
        expect(onOutcome).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
          kind: 'vitest-watchdog', signal: 'delivered', settlement: 'terminated',
        }));
      }
    } finally { rmSync(host, { recursive: true, force: true }); }
  });

  it.each(['recovered', 'changed-root', 'reused', 'unreadable'])(
    'rechecks withheld cleanup after a transient inspection without signaling changed ownership: %s', mode => {
      const host = mkdtempSync(join(tmpdir(), 'recovery-transient-'));
      const root = join(host, 'pvt-owned'); mkdirSync(root);
      writeFileSync(join(root, '.owner.pid'), '999999 0\n');
      const ancestors = [{ pid: process.pid, ppid: process.ppid }, { pid: process.ppid, ppid: 1 }];
      const child = { pid: 900001, ppid: 1, start: 'original', args: ['node'],
        env: { NODE_ENV: 'test', PORTOS_TEST_TEMP_ROOT: root } };
      let reads = 0;
      let time = 0;
      let signaled = false;
      const read = () => {
        reads++;
        if (reads === 1) return [...ancestors, child];
        if (reads === 2) return [...ancestors, { ...child, env: {} }];
        if (mode === 'unreadable') return null;
        if (signaled) return ancestors;
        return [...ancestors, { ...child,
          start: mode === 'reused' ? 'replacement' : child.start,
          env: mode === 'changed-root' ? { ...child.env, PORTOS_TEST_TEMP_ROOT: join(host, 'pvt-other') } : child.env }];
      };
      const kill = vi.fn(() => { signaled = true; });
      try {
        const result = killTestProcessesUnder(root, { read, probe: () => false, probePid: () => !signaled,
          kill, now: () => time, wait: ms => { time += ms; }, settlementMs: 50 });
        expect(result).toBe(mode === 'recovered' ? 1 : 0);
        if (mode === 'recovered') expect(kill).toHaveBeenCalledExactlyOnceWith(child.pid, 'SIGKILL');
        else expect(kill).not.toHaveBeenCalled();
      } finally { rmSync(host, { recursive: true, force: true }); }
    });

  it.each(['live', 'gone'])('requires terminal proof before ignoring an incomplete %s process row', mode => {
    const host = mkdtempSync(join(tmpdir(), 'recovery-unrelated-'));
    const dead = join(host, 'pvt-dead');
    const aged = join(host, 'pvt-aged');
    const old = new Date(Date.now() - STALE_ROOT_AGE_MS - 60000);
    try {
      mkdirSync(dead);
      writeFileSync(join(dead, '.owner.pid'), '2147483646 0\n');
      mkdirSync(aged);
      utimesSync(aged, old, old);
      sweepStaleRunRoots(host, {
        read: () => [
          { pid: process.pid, ppid: process.ppid, args: [], env: {} },
          { pid: process.ppid, ppid: 1, args: [], env: {} },
          { pid: 900003, ownershipComplete: false },
        ],
        probe: () => false,
        probePid: () => mode === 'live',
      });
      expect(existsSync(dead)).toBe(mode === 'live');
      expect(existsSync(aged)).toBe(mode === 'live');
    } finally { rmSync(host, { recursive: true, force: true }); }
  });

  it('keeps a root while its signalled child is still in the snapshot and removes it once gone', () => {
    const host = mkdtempSync(join(tmpdir(), 'recovery-pending-'));
    const root = join(host, 'pvt-owned'); mkdirSync(root);
    writeFileSync(join(root, '.owner.pid'), '999999 0\n');
    const ancestors = [{ pid: process.pid, ppid: process.ppid }, { pid: process.ppid, ppid: 1 }];
    const child = { pid: 900001, ppid: 1, start: 'original', args: ['node'], env: { NODE_ENV: 'test', PORTOS_TEST_TEMP_ROOT: root } };
    const terminate = vi.fn();
    const sweep = (records, probePid = () => true) => sweepStaleRunRoots(host, { read: () => [...ancestors, ...records], probe: () => false, probePid, terminate });
    try {
      sweep([child]);
      expect(terminate).toHaveBeenCalledTimes(1);
      sweep([child]);
      expect(existsSync(root)).toBe(true);
      sweep([{ pid: child.pid, ppid: 1, start: child.start }]); // partial inventory with a live PID stays unknown
      expect(existsSync(root)).toBe(true);
      sweep([]);
      expect(existsSync(root)).toBe(false);
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
      expect(existsSync(root)).toBe(true); // no snapshot cannot prove the child gone
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

  it.skipIf(process.platform === 'win32')('darwin reader skips foreign-euid setuid rows on EPERM via PROC_PIDT_SHORTBSDINFO while keeping SZOMB terminal and failing closed on unreadable same-euid rows', () => {
    const reader = fileURLToPath(new URL('./lib/darwinTestProcesses.py', import.meta.url));
    const python = process.platform === 'darwin' ? '/usr/bin/python3' : 'python3';
    const harness = `
import ctypes, errno, importlib.util, json, struct, sys

spec = importlib.util.spec_from_file_location('darwinTestProcesses', sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

# Test rows:
# 1001: normal live same-uid process (readable args/env)
# 1002: setuid-root /usr/bin/login (EPERM on BSDINFO, SHORTBSDINFO pbsi_uid=0 != 501, kill succeeds)
# 1003: SZOMB same-uid zombie (BSDINFO with arg=1 returns pbi_status=5, KERN_PROCARGS2 fails)
# 1004: genuinely unreadable live same-euid process (EPERM on BSDINFO, SHORTBSDINFO pbsi_uid=501)
# 1005: EPERM on BSDINFO, SHORTBSDINFO fails (0) while kill succeeds
# 1006: EPERM on BSDINFO, SHORTBSDINFO returns mismatched pbsi_pid while kill succeeds
# 1007: non-EPERM failure (EIO) on BSDINFO while kill succeeds (must not fall back to SHORTBSDINFO)
# 1008: exited process (ESRCH on BSDINFO and ESRCH on kill)
state = {'errno': 0}

def pack_bsd(pid, ppid, uid, status, sec=100, usec=200):
    return mod.BSDINFO_LAYOUT.pack(
        0, status, 0, pid, ppid, uid, 20, uid, 20, uid, 20, 0,
        b'node'.ljust(16, b'\\0'), b'node'.ljust(32, b'\\0'),
        0, pid, 0, 0, 0, 0, sec, usec,
    )

def pack_short(pid, ppid, uid, ruid, status=2):
    return mod.SHORT_BSDINFO_LAYOUT.pack(
        pid, ppid, pid, status, b'login'.ljust(16, b'\\0'), 0,
        uid, 0, ruid, 20, uid, 0, 0,
    )

class FakeLibProc:
    def proc_pidinfo(self, pid, flavor, arg, buf, size):
        arg_val = arg.value if hasattr(arg, 'value') else arg
        if flavor == mod.PROC_PIDTBSDINFO:
            if pid == 1001:
                raw = pack_bsd(1001, 1, 501, 2)
                ctypes.memmove(buf, raw, len(raw))
                return len(raw)
            if pid == 1003:
                if arg_val != 1:
                    state['errno'] = errno.ESRCH
                    return 0
                raw = pack_bsd(1003, 1001, 501, 5, sec=101, usec=300)
                ctypes.memmove(buf, raw, len(raw))
                return len(raw)
            if pid in (1002, 1004, 1005, 1006):
                state['errno'] = errno.EPERM
                return 0
            if pid == 1007:
                state['errno'] = errno.EIO
                return 0
            state['errno'] = errno.ESRCH
            return 0
        if flavor == mod.PROC_PIDT_SHORTBSDINFO:
            if pid == 1002:
                raw = pack_short(1002, 1, 0, 501)
                ctypes.memmove(buf, raw, len(raw))
                return len(raw)
            if pid == 1004:
                raw = pack_short(1004, 1, 501, 501)
                ctypes.memmove(buf, raw, len(raw))
                return len(raw)
            if pid == 1006:
                raw = pack_short(9999, 1, 0, 501)
                ctypes.memmove(buf, raw, len(raw))
                return len(raw)
            if pid == 1007:
                raw = pack_short(1007, 1, 0, 501)
                ctypes.memmove(buf, raw, len(raw))
                return len(raw)
            state['errno'] = errno.EPERM
            return 0
        return 0

class FakeLibC:
    def sysctl(self, mib, namelen, oldp, oldlenp, newp, newlen):
        pid = mib[2]
        if pid != 1001:
            return -1
        payload = struct.pack('i', 1) + b'/bin/node\\0/bin/node\\0NODE_ENV=test\\0'
        length_obj = oldlenp._obj
        if oldp is None:
            length_obj.value = len(payload)
            return 0
        ctypes.memmove(oldp, payload, len(payload))
        length_obj.value = len(payload)
        return 0

def fake_kill(pid, sig):
    if pid == 1008:
        raise OSError(errno.ESRCH, 'No such process')

def set_err(value):
    state['errno'] = value

rows = mod.snapshot(
    [1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008],
    libc=FakeLibC(),
    libproc=FakeLibProc(),
    get_errno=lambda: state['errno'],
    set_errno=set_err,
    getuid=lambda: 501,
    kill=fake_kill,
)
print(json.dumps(rows))
`;
    const run = spawnSync(python, ['-I', '-S', '-c', harness, reader], { encoding: 'utf8' });
    expect(run.error).toBeUndefined();
    expect(run.status, run.stderr).toBe(0);
    const rows = JSON.parse(run.stdout);
    expect(rows).toEqual([
      { pid: 1001, ppid: 1, start: '100:200', terminal: false, args: ['/bin/node'], env: { NODE_ENV: 'test' } },
      { pid: 1003, ppid: 1001, start: '101:300', terminal: true },
      { pid: 1004, ownershipComplete: false },
      { pid: 1005, ownershipComplete: false },
      { pid: 1006, ownershipComplete: false },
      { pid: 1007, ownershipComplete: false },
    ]);

    const host = mkdtempSync(join(tmpdir(), 'recovery-darwin-inspect-'));
    try {
      const ancestors = [
        { pid: process.pid, ppid: process.ppid, start: 'self', terminal: false, args: ['node'], env: {} },
        { pid: process.ppid, ppid: 1, start: 'parent', terminal: false, args: ['node'], env: {} },
      ];
      const completeRows = rows.filter(row => row.ownershipComplete !== false);
      expect(sweepOrphanedTestProcesses(host, {
        read: () => [...ancestors, ...completeRows],
        probePid: () => true,
      }).inspected).toBe(true);
      expect(sweepOrphanedTestProcesses(host, {
        read: () => [...ancestors, ...rows],
        probePid: () => true,
      }).inspected).toBe(false);
    } finally { rmSync(host, { recursive: true, force: true }); }
  });
});

describe.skipIf(process.platform === 'win32')('real interrupted-run recovery', () => {
  // The caller blocks its event loop while settling, so Node cannot reap the
  // child: only a zombie's birth identity can prove that the signal landed.
  it('settles a killed direct child that its blocked parent has not reaped', async () => {
    const child = spawn(process.execPath, ['-e', "process.stdout.write('ready'); setInterval(()=>{},1000)"], { stdio: ['ignore', 'pipe', 'ignore'] });
    const closed = new Promise(resolve => child.once('close', resolve));
    try {
      await new Promise((resolve, reject) => { child.once('error', reject); child.stdout.once('data', resolve); });
      const [record] = readTestProcesses([child.pid]);
      expect(record).toMatchObject({ pid: child.pid, terminal: false });
      process.kill(child.pid, 'SIGKILL');
      const deadline = Date.now() + 5000;
      let current;
      do {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
        current = readTestProcesses([child.pid]);
      } while (!current?.[0]?.terminal && Date.now() < deadline);
      expect(current).toEqual([expect.objectContaining({ pid: child.pid, start: record.start, terminal: true })]);
      expect(testProcessSettlement(record, current, () => true)).toBe('terminated');
      if (process.platform === 'darwin') {
        const host = mkdtempSync(join(tmpdir(), 'recovery-darwin-full-'));
        try {
          const result = sweepOrphanedTestProcesses(host);
          expect(result.inspected).toBe(true);
          expect(result.records).toContainEqual(expect.objectContaining({ pid: child.pid, start: record.start, terminal: true }));
          expect(result.records.filter(item => item.ownershipComplete === false)).toEqual([]);
        } finally { rmSync(host, { recursive: true, force: true }); }
      }
    } finally {
      child.kill('SIGKILL');
      await closed;
    }
  });

  it('retains files used by a live orphan whose ownership is unreadable in the first snapshot', async () => {
    const host = mkdtempSync(join(tmpdir(), 'recovery-unreadable-child-'));
    const root = join(host, 'pvt-owned');
    mkdirSync(root);
    writeFileSync(join(root, '.owner.pid'), '2147483646 0\n');
    writeFileSync(join(root, 'active-evidence'), 'still in use');
    const child = spawn(process.execPath, ['-e', "process.stdout.write('ready'); setInterval(()=>{},1000)"], {
      env: { PATH: process.env.PATH, NODE_ENV: 'test', PORTOS_TEST_TEMP_ROOT: root }, stdio: ['ignore', 'pipe', 'ignore'],
    });
    try {
      await new Promise((resolve, reject) => { child.once('error', reject); child.stdout.once('data', resolve); });
      sweepStaleRunRoots(host, { probe: () => false, read: () => [
        { pid: process.pid, ppid: process.ppid, args: [], env: {} },
        { pid: process.ppid, ppid: 1, args: [], env: {} },
        { pid: child.pid, ppid: 1, start: 'orphan', ownershipComplete: false },
      ] });
      expect(isProcessAlive(child.pid)).toBe(true);
      expect(existsSync(join(root, 'active-evidence'))).toBe(true);
    } finally {
      await new Promise(resolve => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve();
        child.once('close', resolve);
        child.kill('SIGKILL');
      });
      rmSync(host, { recursive: true, force: true });
    }
  });

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
      const owner = spawnSync(process.execPath, ['--input-type=module', '-e', `
        import { writeOwnerFile } from ${JSON.stringify(new URL('./lib/vitestStaleRunRoots.js', import.meta.url).href)};
        writeOwnerFile(${JSON.stringify(dead)});
      `], { stdio: 'ignore' });
      expect(owner.status).toBe(0);
      const environmentOnly = await launch([process.execPath, '-e', code], { NODE_ENV: 'test', PORTOS_TEST_TEMP_ROOT: dead });
      const script = join(dead, 'fixture.sh'); writeFileSync(script, 'echo ready\nread answer\n');
      const argumentOnly = await launch(['/bin/sh', script]);
      const unrelated = await launch([process.execPath, '-e', code], { OTHER: `PORTOS_TEST_TEMP_ROOT=${dead} NODE_ENV=test` });
      const ownedLive = await launch([process.execPath, '-e', code], { NODE_ENV: 'test', PORTOS_TEST_TEMP_ROOT: live });
      // Inspect every process launched by this fixture plus caller ancestry,
      // using real OS metadata. Ambient unreadable host rows correctly retain
      // roots; that separate refusal contract is covered above.
      const fixturePids = [process.pid, process.ppid, ...children.map(child => child.pid)];
      const read = pids => readTestProcesses(pids ?? fixturePids);
      const inspected = read([environmentOnly.pid, argumentOnly.pid, unrelated.pid]);
      expect(inspected?.map(record => testProcessRoot(record, host, 'pvt-'))).toEqual([dead, dead, null]);
      sweepStaleRunRoots(host, { read });
      expect(existsSync(dead)).toBe(true); // signal scheduling is not settlement
      await vi.waitFor(() => {
        expect(isProcessAlive(environmentOnly.pid)).toBe(false);
        expect(isProcessAlive(argumentOnly.pid)).toBe(false);
      }, { timeout: 5000 });
      sweepStaleRunRoots(host, { read }); // both individually verified descendants have settled
      expect(existsSync(dead)).toBe(false);
      expect(existsSync(live)).toBe(true);
      expect(isProcessAlive(unrelated.pid)).toBe(true);
      expect(isProcessAlive(ownedLive.pid)).toBe(true);
      const outcomes = [];
      expect(killTestProcessesUnder(live, { read, onOutcome: outcome => outcomes.push(outcome) })).toBe(1);
      expect(outcomes).toEqual([expect.objectContaining({ settlement: 'terminated' })]);
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
