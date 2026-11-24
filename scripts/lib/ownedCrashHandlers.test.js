import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ownedCrashHandlers } from './ownedCrashHandlers.js';
import { probeTestPid } from './testOwnedProcesses.js';

const roots = [];
const root = () => {
  const path = mkdtempSync(join(tmpdir(), 'owned-crash-handlers-'));
  roots.push(path);
  return path;
};
afterEach(() => {
  vi.restoreAllMocks();
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

const HANDLER = '/Applications/Example.app/Helpers/chrome_crashpad_handler';
/** A synthetic process table: rows leave it through `exit` or a delivered signal. */
const table = (...rows) => {
  const live = new Map(rows.map(row => [row.pid, row]));
  return {
    live,
    exit: pid => live.delete(pid),
    read: vi.fn(async pids => [...live.values()].filter(row => !pids || pids.includes(row.pid))),
    probe: pid => live.has(pid),
    kill: vi.fn(pid => { live.delete(pid); }),
  };
};
const harness = (processes, overrides = {}) => {
  const path = root();
  let clock = 0;
  const wait = vi.fn(async ms => { clock += ms; });
  const handlers = ownedCrashHandlers(path, { platform: 'darwin', graceMs: 100, now: () => clock, wait,
    read: processes.read, probe: processes.probe, kill: processes.kill, ...overrides });
  const database = handlers.env.BREAKPAD_DUMP_LOCATION;
  const handler = (pid, extra = {}) => ({ pid, ppid: 1, start: `${pid}:0`, terminal: false,
    args: [HANDLER, '--monitor-self', `--database=${database}`, '--handshake-fd=7'], ...extra });
  return { handlers, database, handler, wait };
};
const add = (processes, ...rows) => rows.forEach(row => processes.live.set(row.pid, row));

describe('owned Chrome crash handlers', () => {
  it('gives the launch a private canonical database, and nothing where Chrome does not detach its handler', async () => {
    const path = root();
    const alias = `${path}-alias`;
    symlinkSync(path, alias, 'dir');
    roots.push(alias);
    // Chrome reports the resolved path in the handler's arguments, never the alias.
    expect(ownedCrashHandlers(alias, { platform: 'darwin' }).env)
      .toEqual({ BREAKPAD_DUMP_LOCATION: join(realpathSync(path), 'crashpad') });
    const read = vi.fn();
    const inert = ownedCrashHandlers(path, { platform: 'linux', read });
    expect(inert.env).toEqual({});
    inert.identify(100);
    expect(await inert.settle(100)).toBe('unsupported');
    expect(read).not.toHaveBeenCalled();
  });

  it('never signals handlers that exit with their browser, using the identities recorded while it was alive', async () => {
    const processes = table();
    const { handlers, handler, wait } = harness(processes);
    add(processes, handler(900001), handler(900002));
    handlers.identify(100);
    wait.mockImplementation(async () => { processes.exit(900001); processes.exit(900002); });
    expect(await handlers.settle(1000)).toBe('found=2 signalled=0 settled=2');
    expect(processes.kill).not.toHaveBeenCalled();
    // The launch-time inventory is the only process-table crawl.
    expect(processes.read).toHaveBeenCalledExactlyOnceWith(null, { timeoutMs: 100 });
  });

  it('stops only the handlers of its own database when they outlive the browser', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const processes = table();
    const { handlers, handler, database } = harness(processes);
    const args = value => [HANDLER, ...value];
    const unrelated = [
      handler(900010, { args: args(['--database=/private/example/Google Chrome/Crashpad']) }),
      handler(900011, { args: args([`--database=${database}-sibling`]) }),
      handler(900012, { args: args([`--database=${database}`, '--database=/private/example']) }),
      handler(900013, { args: args(['--annotation', `${database}`]) }),
      handler(900014, { args: ['/usr/bin/example', `--database=${database}`] }),
      handler(900015, { start: '' }),
      { pid: 900016, ownershipComplete: false },
    ];
    add(processes, handler(900001), handler(900002), ...unrelated);
    handlers.identify(100);
    expect(await handlers.settle(1000)).toBe('found=2 signalled=2 settled=2');
    expect(processes.kill.mock.calls).toEqual([[900001, 'SIGKILL'], [900002, 'SIGKILL']]);
    expect([...processes.live.keys()]).toEqual(unrelated.map(row => row.pid));
    expect(log).toHaveBeenCalledExactlyOnceWith(
      '🧹 Owned browser crash handlers outlived their browser: found=2 signalled=2 settled=2');
  });

  it.each(['reused', 'replaced-database', 'unreadable'])('withholds the signal from a %s identity', async mode => {
    const processes = table();
    const { handlers, handler } = harness(processes);
    add(processes, handler(900001));
    handlers.identify(100);
    await processes.read.mock.results[0].value;
    if (mode === 'reused') add(processes, handler(900001, { start: 'later:0' }));
    if (mode === 'replaced-database') add(processes, handler(900001, { args: [HANDLER, '--database=/private/example'] }));
    if (mode === 'unreadable') processes.read.mockResolvedValue(null);
    const settled = handlers.settle(1000);
    if (mode === 'reused') expect(await settled).toBe('found=1 signalled=0 settled=1');
    else await expect(settled).rejects.toThrow('Owned browser crash handler exit unconfirmed: found=1 signalled=0 settled=0');
    expect(processes.kill).not.toHaveBeenCalled();
    expect(processes.live.has(900001)).toBe(true);
  });

  it.each(['refused', 'ignored'])('fails with redacted evidence when the signal is %s', async mode => {
    const processes = table();
    const { handlers, handler, database } = harness(processes);
    add(processes, handler(900001));
    handlers.identify(100);
    processes.kill.mockImplementation(() => { if (mode === 'refused') throw new Error('private signal error'); });
    const error = await handlers.settle(1000).catch(reason => reason);
    expect(error.message).toBe(`Owned browser crash handler exit unconfirmed: found=1 signalled=${mode === 'refused' ? 0 : 1} settled=0`);
    expect(error.message).not.toContain(database);
    expect(error.message).not.toContain('900001');
    expect(processes.kill).toHaveBeenCalledTimes(1);
  });

  it.each(['never identified', 'unavailable at launch'])('inventories at teardown when the handlers were %s', async mode => {
    const processes = table();
    const { handlers, handler } = harness(processes);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    add(processes, handler(900001));
    if (mode === 'unavailable at launch') {
      processes.read.mockResolvedValueOnce(null);
      handlers.identify(100);
    }
    expect(await handlers.settle(1000)).toBe('found=1 signalled=1 settled=1');
    expect(processes.live.size).toBe(0);
  });

  it('never reports an unavailable inventory as settled', async () => {
    const processes = table();
    processes.read.mockResolvedValue(null);
    const { handlers } = harness(processes);
    await expect(handlers.settle(1000)).rejects.toThrow('Owned browser crash handler inventory unavailable');
  });

  // The diagnosed lifecycle with real detached processes and the real reader.
  it.skipIf(process.platform === 'win32')('settles a real detached handler and leaves unrelated ones running', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const own = ownedCrashHandlers(root(), { platform: 'darwin', graceMs: 50 });
    const other = ownedCrashHandlers(root(), { platform: 'darwin' });
    const start = (argv0, { env }) => spawn(process.execPath,
      ['-e', 'setInterval(() => {}, 1000)', '--', `--database=${env.BREAKPAD_DUMP_LOCATION}`],
      { argv0, stdio: 'ignore', detached: true });
    const children = [start('chrome_crashpad_handler', own), start('chrome_crashpad_handler', other), start('example', own)];
    const exits = children.map(child => once(child, 'exit'));
    try {
      await Promise.all(children.map(child => once(child, 'spawn')));
      own.identify(5000);
      expect(await own.settle(5000)).toBe('found=1 signalled=1 settled=1');
      expect((await exits[0])[1]).toBe('SIGKILL');
      for (const child of children.slice(1)) expect(probeTestPid(child.pid)).toBe(true);
    } finally {
      for (const child of children) child.kill('SIGKILL');
      await Promise.all(exits);
    }
  });
});
