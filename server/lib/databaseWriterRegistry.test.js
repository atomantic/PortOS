import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createDatabaseWriterRegistry } from './databaseWriterRegistry.js';
import { createDatabaseMaintenanceJournal } from './databaseMaintenanceJournal.js';
import { spawnDetached } from './detachedSpawn.js';

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
    expect(registry.read()).toEqual([reserved]);
    expect(() => journal.assertAdmission()).toThrow();
  });

  it('retains launched and completion evidence after caller-requested control cleanup', async () => {
    const controlDir = join(root, 'control');
    const handle = await spawnDetached(process.execPath, ['-e', 'process.exit(7)'], {
      controlDir, cleanup: true, pollMs: 10,
    });
    expect(registry.read()[0]).toMatchObject({ state: 'launched', pid: handle.pid, controlDir });
    expect(await observe(handle)).toEqual({ code: 7, signal: null });
    expect(registry.read()[0]).toMatchObject({ state: 'exited', pid: handle.pid,
      completion: { code: 7, signal: null } });
    expect(Object.keys(registry.read()[0]).sort()).toEqual([
      'completion', 'controlDir', 'createdAt', 'id', 'pid', 'processGroup', 'state', 'version',
    ]);
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
    registry.reserve(join(root, 'private-control'));
    const cli = new URL('../../scripts/database-maintenance.mjs', import.meta.url);
    const result = spawnSync(process.execPath, [fileURLToPath(cli), 'writers'], {
      encoding: 'utf8', env: { ...process.env, PORTOS_DATA_ROOT: root }, timeout: 10000,
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ unresolved: 1, launched: 0, exited: 0, quiescenceVerified: false });
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
