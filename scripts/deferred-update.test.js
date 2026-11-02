import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createMaintenanceAdmission } from '../server/lib/maintenanceAdmission.js';
import { processAbsent } from '../server/lib/maintenanceDeferredUpdate.js';
import { trackedRenderMap } from '../server/services/renderActivity.js';
import { runDeferredUpdate } from './deferred-update.mjs';
import { installUpdateTestSupervisor } from './lib/updateTestSupervisor.js';

const roots = [];
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'deferred-update-test-'));
  roots.push(root);
  return { root, admission: createMaintenanceAdmission(join(root, 'data')) };
};
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const completedLaunch = admission => (_command, _args, options) => {
  const child = new EventEmitter();
  child.pid = 4321;
  child.kill = vi.fn();
  const id = options.env.PORTOS_DEFERRED_UPDATE_ID;
  admission.deferredUpdate.enter(id, child.pid);
  admission.deferredUpdate.terminal(id, child.pid, true);
  setImmediate(() => child.emit('close', 0));
  return child;
};

describe('deferred update admission', () => {
  it('lets a release launch children while waiting, then atomically fences a late render through final saving', async () => {
    const { admission } = fixture();
    const release = admission.admit('agent', 'release-example');
    const renders = trackedRenderMap('deferred-test', { admission });
    const launch = vi.fn(completedLaunch(admission));
    let turn = 0;
    await expect(runDeferredUpdate({ admission, launch, absent: () => true, emit: vi.fn(), wait: async () => {
      turn++;
      expect(admission.held()).toBe(false);
      if (turn === 1) {
        const child = admission.admit('agent', 'release-child-example');
        await release.finish();
        renders.set('final-render', 'job-example');
        await child.finish();
      } else {
        expect(launch).not.toHaveBeenCalled();
        // Encoding ended, but the render owns the delayed final write too.
        expect(admission.deferredUpdate.acquire(admission.deferredUpdate.get().operation.id)).toBe(false);
        renders.delete('final-render');
      }
    } })).resolves.toBe(0);
    expect(turn).toBe(2);
    expect(launch).toHaveBeenCalledOnce();
    expect(admission.status().state).toBe('normal');
    expect(admission.deferredUpdate.get().result.success).toBe(true);
    const next = admission.deferredUpdate.request();
    expect(admission.deferredUpdate.acquire(next.id)).toBe(true);
    expect(() => renders.set('racing-render', 'job')).toThrow(/holding new work/);
    expect(() => admission.resume(admission.status().hold)).toThrow();
    admission.deferredUpdate.finish(next.id, false);
  });

  it('waits for legacy supervisor completion even when its recorded shell PID is gone', async () => {
    const { root, admission } = fixture();
    const control = join(root, 'data/update-detached');
    mkdirSync(control, { recursive: true });
    writeFileSync(join(control, 'pid'), '2147483647');
    const launch = vi.fn(completedLaunch(admission));
    const wait = vi.fn(async () => {
      expect(launch).not.toHaveBeenCalled();
      expect(admission.held()).toBe(false);
      writeFileSync(join(control, 'exit'), '1');
    });
    await expect(runDeferredUpdate({ admission, launch, wait, absent: () => true, emit: vi.fn() })).resolves.toBe(0);
    expect(wait).toHaveBeenCalledOnce();
  });

  it('releases an interrupted wait without taking a hold or launching an update', async () => {
    const { admission } = fixture();
    const release = admission.admit('agent', 'release-example');
    const controller = new AbortController();
    const launch = vi.fn();
    await expect(runDeferredUpdate({ admission, launch, emit: vi.fn(), signal: controller.signal,
      wait: async () => controller.abort(new Error('interrupted')) })).rejects.toThrow('interrupted');
    expect(admission.held()).toBe(false);
    expect(admission.deferredUpdate.get().operation).toBeNull();
    expect(launch).not.toHaveBeenCalled();
    await release.finish();
  });

  it.each([false, true])('lets maintenance supersede a waiting update without deadlocking its drain (legacy work: %s)', async legacyPending => {
    const { admission } = fixture();
    const release = admission.admit('agent', 'release-example');
    let hold;
    const launch = vi.fn();
    await expect(runDeferredUpdate({ admission, launch, emit: vi.fn(), legacyRunning: async () => legacyPending, wait: async () => {
      hold = admission.begin({ reason: 'Peer maintenance', owner: 'operator-example' }).hold;
      await release.finish();
    } })).rejects.toThrow('superseded');
    expect(launch).not.toHaveBeenCalled();
    expect(admission.status()).toMatchObject({ state: 'ready', hold, blockers: [] });
    expect(() => admission.observeIdle()).not.toThrow();
    admission.resume({ id: hold.id, revision: hold.revision });
  });

  it('retains unknown liveness and orphan descendants, and reconciles only after proved settlement', () => {
    const { admission } = fixture();
    const operation = admission.deferredUpdate.request();
    admission.deferredUpdate.acquire(operation.id);
    admission.deferredUpdate.enter(operation.id, 4321);
    expect(processAbsent(4321, () => { throw Object.assign(new Error('unknown'), { code: 'EPERM' }); })).toBe(false);
    admission.deferredUpdate.reconcile({ absent: () => false });
    expect(admission.held()).toBe(true);
    admission.deferredUpdate.reconcile({ absent: pid => pid > 0, platform: 'darwin' });
    expect(admission.held()).toBe(true);
    admission.deferredUpdate.reconcile({ absent: () => true, platform: 'darwin' });
    expect(admission.held()).toBe(false);
    expect(admission.deferredUpdate.get().result).toMatchObject({ success: false, interrupted: true });
  });

  it('requires exact Windows terminal evidence and recovers a crash after terminal publication', async () => {
    const { admission } = fixture();
    await expect(runDeferredUpdate({ admission, platform: 'win32', emit: vi.fn(), launch: (_command, _args, options) => {
      const child = new EventEmitter(); child.pid = 4321;
      admission.deferredUpdate.enter(options.env.PORTOS_DEFERRED_UPDATE_ID, child.pid);
      setImmediate(() => child.emit('close', 0));
      return child;
    } })).rejects.toThrow('settlement is unverified');
    const { operation } = admission.deferredUpdate.get();
    admission.deferredUpdate.reconcile({ absent: () => true, platform: 'win32' });
    expect(admission.held()).toBe(true);
    expect(() => admission.deferredUpdate.terminal(operation.id, 1234, true)).toThrow();
    expect(() => admission.deferredUpdate.terminal('stale-operation', 4321, true)).toThrow();
    admission.deferredUpdate.terminal(operation.id, 4321, false);
    admission.deferredUpdate.reconcile({ absent: () => true, platform: 'win32' });
    expect(admission.held()).toBe(false);
    expect(admission.deferredUpdate.get().result).toMatchObject({ id: operation.id, success: false, interrupted: false });
    await expect(runDeferredUpdate({ admission, platform: 'win32', emit: vi.fn(), launch: completedLaunch(admission) })).resolves.toBe(0);
  });
});

describe.skipIf(process.platform === 'win32')('direct update script offline boundary', () => {
  const start = root => {
    installUpdateTestSupervisor(root, { standalone: true });
    const source = readFileSync(new URL('../update.sh', import.meta.url), 'utf8');
    const header = source.slice(0, source.indexOf('mkdir -p "$ROOT_DIR/data"'));
    writeFileSync(join(root, 'update.sh'), `${header}\ntouch applied\nnode scripts/deferred-update.mjs --terminal "$PORTOS_DEFERRED_UPDATE_ID" "$$" 0\n`);
    // This is a standalone process in a copied disposable install, not a Vitest
    // worker writing the executing checkout's data tree (same as boot smoke).
    const env = { ...process.env, PORTOS_DATA_ROOT: root };
    delete env.VITEST;
    const child = spawn('bash', [join(root, 'update.sh')], { cwd: root, env, stdio: 'ignore' });
    return new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  };

  it('does not mutate before a release and its children finish, without requiring a running API', async () => {
    const { root, admission } = fixture();
    const release = admission.admit('agent', 'release-example');
    const done = start(root);
    expect(existsSync(join(root, 'node_modules'))).toBe(false);
    expect(existsSync(join(root, 'server/node_modules'))).toBe(false);
    await vi.waitFor(() => expect(admission.deferredUpdate.get().operation?.phase).toBe('waiting'), { timeout: 10000 });
    const child = admission.admit('agent', 'release-child-example');
    await release.finish();
    expect(existsSync(join(root, 'applied'))).toBe(false);
    await child.finish();
    expect(await done).toBe(0);
    expect(existsSync(join(root, 'applied'))).toBe(true);
    expect(admission.held()).toBe(false);
  });

  it.each(['images', 'corrupt'])('rechecks %s state at the acquired hold and refuses before mutation', async kind => {
    const { root, admission } = fixture();
    const release = admission.admit('agent', 'release-example');
    const done = start(root);
    expect(existsSync(join(root, 'node_modules'))).toBe(false);
    expect(existsSync(join(root, 'server/node_modules'))).toBe(false);
    await vi.waitFor(() => expect(admission.deferredUpdate.get().operation?.phase).toBe('waiting'), { timeout: 10000 });
    mkdirSync(join(root, 'data/cos'), { recursive: true });
    writeFileSync(join(root, 'data/cos/state.json'), kind === 'corrupt' ? '{' : JSON.stringify({ persistentMind: { queuedMessages: [{ images: ['example.png'] }] } }));
    await release.finish();
    expect(await done).toBe(1);
    expect(existsSync(join(root, 'applied'))).toBe(false);
    expect(admission.held()).toBe(false);
  });
});
