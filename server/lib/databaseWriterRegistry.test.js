import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import * as childProcess from './childProcess.js';
import { spawn, spawnSync } from 'node:child_process';
import { classifyWriterQuiescence, createDatabaseWriterRegistry, retireQuiescentWriters } from './databaseWriterRegistry.js';
import { createDatabaseMaintenanceJournal } from './databaseMaintenanceJournal.js';
import { spawnDetached, sweepQuiescentWriters } from './detachedSpawn.js';

const context = vi.hoisted(() => ({ data: undefined, setupBarrier: null }));
vi.mock('./paths.js', async original => {
  const actual = await original();
  return { ...actual, PATHS: new Proxy(actual.PATHS, {
    get: (target, key) => key === 'data' ? (context.data ?? target[key]) : target[key],
  }) };
});
vi.mock('./fileUtils.js', async original => {
  const actual = await original();
  return { ...actual, ensureDir: async (...args) => {
    if (context.setupBarrier) await context.setupBarrier;
    return actual.ensureDir(...args);
  } };
});
const source = { mode: 'native', host: 'localhost', port: 5432, database: 'example_test', user: 'example' };
const target = { ...source, mode: 'docker', port: 5561 };
let root;
let registry;
let journal;
let handles;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'writer-inventory-'));
  writeFileSync(join(root, '.portos-disposable-root'), '');
  context.data = join(root, 'data');
  context.setupBarrier = null;
  registry = createDatabaseWriterRegistry(context.data);
  journal = createDatabaseMaintenanceJournal(context.data);
  handles = [];
});
afterEach(async () => {
  context.setupBarrier = null;
  vi.restoreAllMocks();
  for (const { handle, done } of handles) {
    if (handle.exitCode === null && handle.signalCode === null) handle.kill('SIGKILL');
    await done;
  }
  rmSync(root, { recursive: true, force: true });
});
function observe(handle) {
  const done = new Promise(resolve => {
    handle.once('close', (code, signal) => resolve({ code, signal }));
    handle.once('error', error => resolve({ error }));
  });
  handles.push({ handle, done });
  return done;
}

describe('durable detached launch admission', () => {
  it('lists a paused launch before the fence and refuses it when setup resumes', async () => {
    let release;
    context.setupBarrier = new Promise(resolve => { release = resolve; });
    const ran = join(root, 'ran');
    const pending = spawnDetached(process.execPath, ['-e', `require('fs').writeFileSync(${JSON.stringify(ran)},'bad')`], {
      controlDir: join(root, 'control'), pollMs: 10,
    });
    const [reserved] = registry.read();
    expect(reserved.state).toBe('unresolved');
    journal.begin({ source, target });
    release();
    const handle = await pending;
    const result = await observe(handle);
    expect(result.error?.code).toBe('DATABASE_MAINTENANCE');
    expect(() => readFileSync(ran)).toThrow();
    // A refusal before any launcher started is durable proof of no child.
    expect(registry.read()).toEqual([{ ...reserved, state: 'abandoned' }]);
    expect(() => journal.assertAdmission()).toThrow();
  });

  it.skipIf(process.platform === 'win32')('retires completed launches only once their process groups are proven empty', async () => {
    for (let index = 0; index < 3; index += 1) {
      const controlDir = join(root, `control-${index}`);
      const handle = await spawnDetached(process.execPath, ['-e', 'process.exit(7)'], {
        controlDir, cleanup: true, pollMs: 10,
      });
      expect(registry.read()).toContainEqual(expect.objectContaining({ state: 'launched', pid: handle.pid, controlDir,
        launcherPid: expect.any(Number), launchedAt: expect.any(String) }));
      expect(await observe(handle)).toEqual({ code: 7, signal: null });
      // Ordinary completed jobs leave no per-launch directory behind.
      await vi.waitFor(() => expect(registry.read()).toEqual([]), { timeout: 5000, interval: 20 });
    }
    expect(readdirSync(join(context.data, 'database-writers'))).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('records a launcher spawn refusal as abandoned', async () => {
    const error = Object.assign(new Error('spawn sh EAGAIN'), { code: 'EAGAIN' });
    vi.spyOn(childProcess, 'spawn').mockImplementationOnce(() => {
      const child = new EventEmitter();
      child.unref = () => {};
      process.nextTick(() => child.emit('error', error));
      return child;
    });
    const handle = await spawnDetached(process.execPath, ['-e', 'process.exit(0)'], {
      controlDir: join(root, 'failed-control'), pollMs: 1,
    });
    expect((await observe(handle)).error).toBe(error);
    expect(registry.read()).toEqual([expect.objectContaining({ state: 'abandoned' })]);
  });

  it('ignores only regular dotfiles and identifies unsafe inventory entries', () => {
    const directory = join(context.data, 'database-writers');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, '.DS_Store'), 'finder');
    expect(registry.read()).toEqual([]);
    writeFileSync(join(directory, 'unexpected.txt'), 'unknown');
    expect(() => registry.read()).toThrow(/unexpected.txt/);
    unlinkSync(join(directory, 'unexpected.txt'));
    mkdirSync(join(directory, '.hidden'));
    expect(() => registry.read()).toThrow(/\.hidden/);
  });

  it('fails closed on legacy compacted exit history and refuses to extend it when unreadable', () => {
    mkdirSync(join(context.data, 'database-writers'), { recursive: true });
    writeFileSync(join(context.data, 'database-writers', 'unreconciled-exits.json'), JSON.stringify({ version: 1 }));
    expect(registry.read()).toEqual([{ state: 'unresolved', kind: 'retired-exits' }]);
    unlinkSync(join(context.data, 'database-writers', 'unreconciled-exits.json'));
    mkdirSync(join(context.data, 'database-writers', 'unreconciled-exits.json'));
    expect(() => registry.read()).toThrow(/incomplete/);
    expect(() => registry.reserve(join(root, 'next-control'))).toThrow(/incomplete/);
  });

  it('rejects an already-fenced launch without touching its control directory', async () => {
    journal.begin({ source, target });
    const controlDir = join(root, 'control');
    mkdirSync(controlDir);
    writeFileSync(join(controlDir, 'pid'), '123');
    const handle = await spawnDetached(process.execPath, ['-e', 'process.exit(0)'], { controlDir });
    expect((await observe(handle)).error?.code).toBe('DATABASE_MAINTENANCE');
    expect(readFileSync(join(controlDir, 'pid'), 'utf8')).toBe('123');
    expect(registry.read()).toEqual([]);
  });

  it('reports bounded operator diagnostics without publishing local identities or claiming quiescence', () => {
    const writer = registry.reserve(join(root, 'private-control'));
    const cli = new URL('../../scripts/database-maintenance.mjs', import.meta.url);
    const result = spawnSync(process.execPath, [fileURLToPath(cli), 'writers'], {
      encoding: 'utf8', env: { ...process.env, PORTOS_DATA_ROOT: root }, timeout: 10000,
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ unresolved: 1, launching: 0, launched: 0, exited: 0, abandoned: 0, unresolvedIds: [writer.id], quiescenceVerified: false });
    expect(result.stdout).not.toContain(root);
  });

  it('fails inventory closed on interrupted publication instead of omitting an unknown writer', () => {
    registry.reserve(join(root, 'control'));
    const [record] = registry.read();
    writeFileSync(join(context.data, 'database-writers', record.id, 'launch.json'), '{');
    expect(() => registry.read()).toThrow(/incomplete/);
  });

  it.each([[source, target], [target, source]])('keeps another process inventoried across maintenance admission', async (from, to) => {
    const registryUrl = new URL('./databaseWriterRegistry.js', import.meta.url).href;
    const code = `import {createDatabaseWriterRegistry} from ${JSON.stringify(registryUrl)};
      const reservation=createDatabaseWriterRegistry(${JSON.stringify(context.data)}).reserve(${JSON.stringify(join(root, 'process-control'))});
      process.stdout.write('reserved\\n');
      process.stdin.once('data',()=>{try {reservation.assertLaunchAllowed();process.exit(2);} catch {process.exit(0);}});`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['pipe', 'pipe', 'pipe'] });
    const exited = new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
    try {
      await new Promise((resolve, reject) => {
        child.stdout.once('data', resolve);
        child.once('error', reject);
        child.once('exit', code => reject(new Error(`reservation process exited ${code}`)));
      });
      expect(registry.read()).toHaveLength(1);
      expect(registry.read()[0].state).toBe('unresolved');
      journal.begin({ source: from, target: to });
      child.stdin.end('continue');
      expect(await exited).toBe(0);
      expect(registry.read()[0].state).toBe('unresolved');
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
      await exited;
    }
  });
});

describe('classifyWriterQuiescence zombies', () => {
  const row = { kind: 'launch', state: 'exited', launcherPid: 4242, processGroup: false, createdAt: new Date().toISOString() };
  const member = state => ({ pid: 4243, pgid: 4242, state, startedAt: Date.now(), command: 'sh' });

  it('treats a zombie holding a recorded group as quiescent, but a live member as orphaned', () => {
    expect(classifyWriterQuiescence(row, [member('Z')]).verdict).toBe('quiescent');
    expect(classifyWriterQuiescence(row, [member('Z+')]).verdict).toBe('quiescent');
    expect(classifyWriterQuiescence(row, [member('S')]).verdict).toBe('orphaned');
  });
});

describe('retireQuiescentWriters boot sweep', () => {
  const noWait = () => Promise.resolve();
  const sweep = (snapshot, extra = {}) => retireQuiescentWriters({ snapshot, dataDir: context.data, wait: noWait, ...extra });
  const launchedWriter = (launcherPid, jobPid) => {
    const writer = registry.reserve(join(root, `control-${launcherPid}`));
    writer.launcher(launcherPid);
    writer.launched(jobPid);
    return writer;
  };
  const liveMember = (launcherPid, jobPid) => ({ pid: jobPid, pgid: launcherPid, state: 'S', startedAt: Date.now(), command: 'sh' });

  it('retires every quiescent record and keeps the running and pending ones', async () => {
    const quiescent = [launchedWriter(41001, 41002), launchedWriter(41003, 41004), launchedWriter(41005, 41006)];
    const abandoned = registry.reserve(join(root, 'control-abandoned'));
    abandoned.abandoned();
    const running = launchedWriter(42001, 42002);
    const pending = registry.reserve(join(root, 'control-pending'));

    const snapshot = vi.fn(async () => [liveMember(42001, 42002)]);
    const result = await sweep(snapshot);

    expect(result).toEqual({ retired: 4 });
    expect(snapshot).toHaveBeenCalledTimes(2);
    expect(registry.read().map(row => row.id).sort()).toEqual([running.id, pending.id].sort());
    expect(quiescent.every(writer => !registry.read().some(row => row.id === writer.id))).toBe(true);
  });

  it('keeps a record that stops looking quiescent between the two snapshots', async () => {
    const writer = launchedWriter(43001, 43002);
    const snapshot = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([liveMember(43001, 43003)]);
    expect(await sweep(snapshot)).toEqual({ retired: 0 });
    expect(registry.read().map(row => row.id)).toEqual([writer.id]);
  });

  it('does nothing under a maintenance fence', async () => {
    launchedWriter(44001, 44002);
    journal.begin({ source, target });
    const snapshot = vi.fn(async () => []);
    expect(await sweep(snapshot)).toEqual({ retired: 0, skipped: 'maintenance fence' });
    expect(snapshot).not.toHaveBeenCalled();
    expect(registry.read()).toHaveLength(1);
  });

  it('is a no-op on win32', async () => {
    launchedWriter(45001, 45002);
    const snapshot = vi.fn(async () => []);
    expect(await sweep(snapshot, { platform: 'win32' })).toEqual({ retired: 0, skipped: 'win32' });
    expect(snapshot).not.toHaveBeenCalled();
    expect(registry.read()).toHaveLength(1);
  });

  it.runIf(process.platform !== 'win32')('sweeps through the real process table via sweepQuiescentWriters', async () => {
    launchedWriter(2147483000, 2147483001);
    expect(await sweepQuiescentWriters({ dataDir: context.data, intervalMs: 0 })).toEqual({ retired: 1 });
    expect(registry.read()).toEqual([]);
  });

  it('leaves an unreadable inventory alone instead of retiring around it', async () => {
    launchedWriter(46001, 46002);
    writeFileSync(join(context.data, 'database-writers', 'unexpected.txt'), 'unknown');
    expect(await sweep(async () => [])).toEqual({ retired: 0, skipped: 'unreadable inventory' });
  });
});
