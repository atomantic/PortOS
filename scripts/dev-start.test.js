import { beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawn } from 'child_process';
import { EventEmitter } from 'events';
import { basename, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { DEV_PM2_APPS, runDev } from './dev-start.js';
import { listPm2Processes } from './pm2-start.js';

vi.mock('child_process', () => ({ execFileSync: vi.fn(), spawn: vi.fn() }));
vi.mock('module', () => ({
  createRequire: () => ({
    resolve(specifier) {
      if (specifier === 'pm2/package.json') return pm2Manifest;
      throw new Error(`Unexpected package resolution: ${specifier}`);
    }
  })
}));
vi.mock('./pm2-start.js', async (importOriginal) => ({
  ...await importOriginal(),
  listPm2Processes: vi.fn()
}));

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pm2Manifest = join(root, 'fixture', 'pm2', 'package.json');
const pm2Path = join(dirname(pm2Manifest), 'bin', 'pm2');
const foreignRoot = join(root, 'data', 'cos', 'worktrees', 'fixture');
const cos = 'portos-cos';
const ui = 'portos-ui';
const services = DEV_PM2_APPS.filter(name => name !== cos);
const processEntry = (name, id, status = 'online', checkout = root) => ({
  name,
  pm_id: id,
  pm2_env: {
    status,
    pm_cwd: name === ui ? join(checkout, 'client') : checkout,
    pm_exec_path: name === ui
      ? join(root, 'client', 'node_modules', 'vite', 'bin', 'vite.js')
      : join(checkout, 'server', 'start.js'),
    env: { PORT: '5560' }
  }
});
const inventory = (base, names = DEV_PM2_APPS) => names.map((name, index) => processEntry(name, base + index));
const startupScripts = [['ensure-deps.js'], ['setup-db.js'], ['setup-cert.js']];
const commands = () => execFileSync.mock.calls.map(([, [script, ...args]]) => [basename(script), ...args]);
const ecosystemStart = (names) => ['pm2', 'start', 'ecosystem.config.cjs', '--only', names.join(',')];
const deletes = (entries) => entries.map(({ pm_id }) => ['pm2', 'delete', String(pm_id)]);

function beginDev(flags = []) {
  const signals = new EventEmitter();
  const child = new EventEmitter();
  child.kill = vi.fn();
  const { promise: spawned, resolve } = Promise.withResolvers();
  spawn.mockImplementation(() => {
    resolve();
    return child;
  });
  const done = runDev(flags, signals);
  const ready = Promise.race([spawned, done.then(() => {
    throw new Error('Dev startup finished before spawning PM2 logs');
  })]);
  return { ready, done, signals, child };
}

describe('development PM2 startup', () => {
  beforeEach(() => vi.resetAllMocks());

  it.each(['online', 'launching', 'waiting restart'])('refreshes dev services and preserves CoS while %s', async (status) => {
    const worker = processEntry(cos, 90, status);
    const registered = inventory(0, services);
    const oldDashboard = {
      ...processEntry('portos-autofixer-ui', 91),
      pm2_env: { pm_cwd: root, pm_exec_path: join(root, 'autofixer', 'ui.js') }
    };
    const foreignDashboard = { ...oldDashboard, pm_id: 92, pm2_env: { ...oldDashboard.pm2_env, pm_cwd: foreignRoot } };
    listPm2Processes.mockResolvedValueOnce([...registered, worker, oldDashboard, foreignDashboard])
      .mockResolvedValueOnce([...inventory(10, services), worker, foreignDashboard]);
    const { child, ready, done } = beginDev();
    await ready;
    child.emit('close', 0, null);
    await expect(done).resolves.toBe(0);
    expect(commands()).toEqual([...startupScripts, ...deletes([...registered, oldDashboard]), ecosystemStart(services)]);
    expect(execFileSync.mock.invocationCallOrder[2]).toBeLessThan(listPm2Processes.mock.invocationCallOrder[0]);
    expect(spawn).toHaveBeenCalledWith(process.execPath, [pm2Path, 'logs'],
      expect.objectContaining({ cwd: root, windowsHide: true }));
  });

  it('starts the complete development set when PM2 is empty', async () => {
    listPm2Processes.mockResolvedValueOnce([]).mockResolvedValueOnce(inventory(0));
    const { child, ready, done } = beginDev();
    await ready;
    child.emit('close', 0, null);
    await expect(done).resolves.toBe(0);
    expect(commands()).toEqual([...startupScripts, ecosystemStart(DEV_PM2_APPS)]);
  });

  it('recovers a stopped CoS by ID and leaves the config refresh scoped to the other services', async () => {
    const worker = processEntry(cos, 90, 'stopped');
    const registered = inventory(0, services);
    listPm2Processes.mockResolvedValueOnce([...registered, worker])
      .mockResolvedValueOnce([...inventory(10, services), processEntry(cos, 90)]);
    const { child, ready, done } = beginDev();
    await ready;
    child.emit('close', 0, null);
    await expect(done).resolves.toBe(0);
    expect(commands()).toEqual([
      ...startupScripts, ...deletes(registered), ['pm2', 'restart', '90'], ecosystemStart(services)
    ]);
  });

  it('recreates an online CoS worker when explicitly requested', async () => {
    const registered = inventory(0);
    listPm2Processes.mockResolvedValueOnce(registered).mockResolvedValueOnce(inventory(10));
    const { child, ready, done } = beginDev(['--restart-cos']);
    await ready;
    child.emit('close', 0, null);
    await expect(done).resolves.toBe(0);
    expect(commands()).toEqual([...startupScripts, ...deletes(registered), ecosystemStart(DEV_PM2_APPS)]);
  });

  it.each([cos, ui, 'portos-browser'])('refuses a foreign %s before changing any PM2 process', async (name) => {
    listPm2Processes.mockResolvedValueOnce([
      ...inventory(0, DEV_PM2_APPS.filter(app => app !== name)),
      processEntry(name, 90, 'stopped', foreignRoot)
    ]);
    await expect(runDev(['--restart-cos'])).rejects.toThrow(`${name} runs from a different checkout`);
    expect(commands()).toEqual(startupScripts);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('refuses a same-name collision before changing any PM2 process', async () => {
    listPm2Processes.mockResolvedValueOnce([...inventory(0), processEntry(ui, 90, 'online', foreignRoot)]);
    await expect(runDev([])).rejects.toThrow('Multiple PM2 entries for portos-ui');
    expect(commands()).toEqual(startupScripts);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('does not start PM2 if certificate setup fails', async () => {
    execFileSync.mockImplementation((_, [script]) => {
      if (basename(script) === 'setup-cert.js') throw new Error('certificate setup failed');
    });
    await expect(runDev([])).rejects.toThrow('certificate setup failed');
    expect(commands()).toEqual(startupScripts);
    expect(listPm2Processes).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('reports a startup failure before waiting for the log tail', async () => {
    listPm2Processes.mockRejectedValueOnce(new Error('inventory unavailable'));
    const { ready } = beginDev();
    await expect(ready).rejects.toThrow('could not inspect PM2 (inventory unavailable)');
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([['SIGINT', 130], ['SIGTERM', 143]])('forwards %s and waits for the log tail to close', async (signal, code) => {
    listPm2Processes.mockResolvedValueOnce([]).mockResolvedValueOnce(inventory(0));
    const { child, signals, ready, done } = beginDev();
    const exited = vi.fn();
    await ready;
    const finished = done.then(exited);
    signals.emit(signal);
    expect(child.kill).toHaveBeenCalledExactlyOnceWith(signal);
    await Promise.resolve();
    expect(exited).not.toHaveBeenCalled();
    child.emit('close', null, signal);
    await finished;
    expect(exited).toHaveBeenCalledExactlyOnceWith(code);
    expect(signals.eventNames()).toEqual([]);
  });

  it('releases signal listeners when the log tail cannot launch', async () => {
    listPm2Processes.mockResolvedValueOnce([]).mockResolvedValueOnce(inventory(0));
    const { child, signals, ready, done } = beginDev();
    await ready;
    child.emit('error', new Error('could not launch logs'));
    await expect(done).rejects.toThrow('could not launch logs');
    expect(signals.eventNames()).toEqual([]);
  });
});
