import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createDatabaseMaintenanceJournal } from '../lib/databaseMaintenanceJournal.js';
import { createDatabaseWriterRegistry } from '../lib/databaseWriterRegistry.js';
import { spawnDetached } from '../lib/detachedSpawn.js';
import { reconcileDetachedWriters } from './databaseMaintenanceQuiescence.js';

const context = vi.hoisted(() => ({ data: undefined, setupBarrier: null }));
vi.mock('../lib/paths.js', async original => {
  const actual = await original();
  return { ...actual, PATHS: new Proxy(actual.PATHS, {
    get: (target, key) => key === 'data' ? (context.data ?? target[key]) : target[key],
  }) };
});
vi.mock('../lib/fileUtils.js', async original => {
  const actual = await original();
  return { ...actual, ensureDir: async (...args) => {
    if (context.setupBarrier) await context.setupBarrier;
    return actual.ensureDir(...args);
  } };
});

const source = { mode: 'native', host: 'localhost', port: 5432, database: 'example_test', user: 'example' };
const target = { ...source, mode: 'docker', port: 5561 };
const producers = ['portos-cos', 'portos-server'].map((name, pmId) => ({
  name, pmId, pid: 100 + pmId, cwd: '/example/portos', script: `${name}.js`, status: 'online',
}));
const fast = { graceMs: 1500, pollMs: 20 };
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
let root;
let journal;
let registry;
let strays;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'writer-quiescence-'));
  writeFileSync(join(root, '.portos-disposable-root'), '');
  context.data = join(root, 'data');
  context.setupBarrier = null;
  journal = createDatabaseMaintenanceJournal(context.data);
  registry = createDatabaseWriterRegistry(context.data);
  strays = [];
});
afterEach(() => {
  context.setupBarrier = null;
  for (const group of strays) { try { process.kill(-group, 'SIGKILL'); } catch { /* already gone */ } }
  rmSync(root, { recursive: true, force: true });
});

// A coordinator worker that has recorded producer shutdown for this operation.
function quiescingOperation(from = source, to = target) {
  const operation = journal.begin({ source: from, target: to });
  const token = journal.acquireCoordinator(operation.id);
  journal.reserveCoordinatorWorker(operation.id, token);
  journal.recordProducerSnapshot(operation.id, token, producers);
  journal.transition(operation.id, token, 'accepted', 'quiescing');
  return { id: operation.id, token };
}

const closed = handle => new Promise(resolve => {
  handle.once('close', (code, signal) => resolve({ code, signal }));
  handle.once('error', error => resolve({ error }));
});
const firstLine = handle => new Promise(resolve => {
  let text = '';
  handle.stdout.on('data', chunk => {
    text += chunk;
    if (text.includes('\n')) resolve(Number(text.split('\n')[0]));
  });
});

// The job starts a grandchild in its own (inherited) process group and prints
// its PID. With `exit`, the job then exits and leaves that descendant behind.
const jobWithDescendant = exit => ['-e', `const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
c.unref();console.log(c.pid);${exit ? 'setTimeout(()=>process.exit(0),50);' : 'setInterval(()=>{},1000);'}`];

describe.skipIf(process.platform === 'win32')('detached writer quiescence reconciliation', () => {
  it.each([[source, target], [target, source]])('terminates a verified running writer tree, then archives its evidence', async (from, to) => {
    const handle = await spawnDetached(process.execPath, jobWithDescendant(false), { controlDir: join(root, 'control'), pollMs: 10 });
    const grandchild = await firstLine(handle);
    const [record] = registry.read();
    strays.push(record.launcherPid);
    const { id, token } = quiescingOperation(from, to);

    const result = await reconcileDetachedWriters(id, token, fast);
    expect(result).toEqual({ id, stage: 'quiescing', writersReconciled: 1, writersTerminated: 1,
      quiescenceVerified: true, transferReady: false });
    expect(alive(handle.pid)).toBe(false);
    expect(alive(grandchild)).toBe(false);
    expect(registry.read()).toEqual([]);
    const archive = join(context.data, 'database-maintenance', 'reconciled-writers');
    expect(readdirSync(archive)).toEqual([record.id]);
    expect(JSON.parse(readFileSync(join(archive, record.id, 'launch.json'), 'utf8')).pid).toBe(handle.pid);
    expect(() => journal.assertAdmission()).toThrow();
    // Re-establishing quiescence after coordinator recovery is repeatable.
    expect((await reconcileDetachedWriters(id, token, fast)).writersReconciled).toBe(0);
  });

  it('refuses an exited writer whose descendant survives, without signalling it', async () => {
    const handle = await spawnDetached(process.execPath, jobWithDescendant(true), { controlDir: join(root, 'control'), pollMs: 10 });
    const grandchild = await firstLine(handle);
    expect(await closed(handle)).toEqual({ code: 0, signal: null });
    const [record] = registry.read();
    strays.push(record.launcherPid);
    expect(record.state).toBe('exited');
    const { id, token } = quiescingOperation();

    await expect(reconcileDetachedWriters(id, token, fast)).rejects.toThrow(/surviving descendants/);
    expect(alive(grandchild)).toBe(true);
    expect(registry.read()).toEqual([record]);
  });

  it('refuses an admitted pre-fence launch until the fence refuses it durably', async () => {
    let release;
    context.setupBarrier = new Promise(resolve => { release = resolve; });
    const ran = join(root, 'ran');
    const pending = spawnDetached(process.execPath, ['-e', `require('fs').writeFileSync(${JSON.stringify(ran)},'bad')`], {
      controlDir: join(root, 'control'), pollMs: 10,
    });
    const { id, token } = quiescingOperation();
    await expect(reconcileDetachedWriters(id, token, fast)).rejects.toThrow(/admitted launch/);

    release();
    expect((await closed(await pending)).error?.code).toBe('DATABASE_MAINTENANCE');
    const result = await reconcileDetachedWriters(id, token, fast);
    expect(result).toMatchObject({ writersReconciled: 1, writersTerminated: 0, quiescenceVerified: true });
    expect(() => readFileSync(ran)).toThrow();
  });

  it('refuses legacy compacted history, identity-free launches and unregistered supervisors', async () => {
    // A launch recorded before launcher groups existed carries only a PID.
    const legacyLaunch = registry.reserve(join(root, 'old-control'));
    const writers = join(context.data, 'database-writers');
    writeFileSync(join(writers, legacyLaunch.id, 'launch.json'), JSON.stringify({ pid: 999999 }) + '\n');
    const { id, token } = quiescingOperation();
    await expect(reconcileDetachedWriters(id, token, fast)).rejects.toThrow(/legacy, compacted/);
    rmSync(join(writers, legacyLaunch.id), { recursive: true });

    writeFileSync(join(writers, 'unreconciled-exits.json'), JSON.stringify({ version: 1 }) + '\n');
    await expect(reconcileDetachedWriters(id, token, fast)).rejects.toThrow(/legacy, compacted/);
    rmSync(writers, { recursive: true });

    // A supervisor started by code that predates the registry has no record.
    const controlDir = join(context.data, 'legacy-control');
    mkdirSync(controlDir, { recursive: true });
    const legacy = spawn('sh', ['-c', 'd="$1"; shift\n{\n  "$@" > /dev/null 2>&1 &\n  child=$!\n  printf \'%s\' "$child" > "$d/pid"\n  wait "$child"\n} &\n',
      'sh', controlDir, process.execPath, '-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
    strays.push(legacy.pid);
    await vi.waitFor(() => readFileSync(join(controlDir, 'pid'), 'utf8'), { timeout: 5000, interval: 20 });
    await expect(reconcileDetachedWriters(id, token, fast)).rejects.toThrow(/unregistered detached supervisor/);
  });

  it('requires recorded producer shutdown and live coordinator ownership', async () => {
    const operation = journal.begin({ source, target });
    const token = journal.acquireCoordinator(operation.id);
    journal.reserveCoordinatorWorker(operation.id, token);
    await expect(reconcileDetachedWriters(operation.id, token, fast)).rejects.toThrow(/producer shutdown/);
    await expect(reconcileDetachedWriters(operation.id, '00000000-0000-4000-8000-000000000000', fast)).rejects.toThrow();
  });
});
