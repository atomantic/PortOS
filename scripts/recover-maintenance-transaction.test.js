import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { recoverMaintenanceTransaction } from './recover-maintenance-transaction.mjs';
import { createMaintenanceAdmission } from '../server/lib/maintenanceAdmission.js';

const roots = [];
const reason = 'Inspected interrupted transaction evidence';
const stopped = async () => ['portos-server', 'portos-cos'].map(name => ({ name, status: 'stopped', pid: 0 }));
function fixture() {
  const data = fs.mkdtempSync(join(tmpdir(), 'maintenance-recovery-'));
  roots.push(data);
  const admission = createMaintenanceAdmission(data);
  fs.mkdirSync(admission.directory, { recursive: true });
  return { data, admission, directory: admission.directory };
}
const interrupt = directory => {
  fs.mkdirSync(join(directory, 'transaction'));
  fs.writeFileSync(join(directory, 'transaction', 'evidence'), 'retained lock evidence');
  fs.writeFileSync(join(directory, 'pending-fixture.json'), '');
  fs.writeFileSync(join(directory, 'pending-other.json'), '{"partial":true}');
};
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe('offline maintenance transaction recovery', () => {
  it('serializes separate recovery processes and never archives a replacement runtime transaction', async () => {
    const { data, directory } = fixture();
    fs.mkdirSync(join(directory, 'transaction'));
    fs.writeFileSync(join(directory, 'transaction', 'evidence'), 'original transaction');
    const barrier = join(data, 'barrier');
    fs.mkdirSync(barrier);
    const module = new URL('./recover-maintenance-transaction.mjs', import.meta.url).href;
    const source = `
      import * as fs from 'node:fs';
      import { join, basename } from 'node:path';
      import { recoverMaintenanceTransaction } from ${JSON.stringify(module)};
      const [id, data, barrier] = process.argv.slice(1);
      const io = { ...fs, mkdirSync(path, options) {
        if (basename(path).startsWith('recovered-')) {
          fs.writeFileSync(join(barrier, id + '-ready'), '');
          const until = Date.now() + 10000;
          while (!fs.existsSync(join(barrier, id + '-release'))) {
            if (Date.now() >= until) throw new Error('Recovery fixture barrier timed out');
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
          }
        }
        return fs.mkdirSync(path, options);
      } };
      try {
        const result = await recoverMaintenanceTransaction('Concurrent recovery fixture', {
          data, io, processes: async () => ['portos-server', 'portos-cos'].map(name => ({ name, status: 'stopped', pid: 0 })),
        });
        process.stdout.write(JSON.stringify(result));
      } catch (error) { process.stdout.write(JSON.stringify({ error: error.message })); }
    `;
    const children = [];
    const launch = id => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', source, id, data, barrier], { stdio: ['ignore', 'pipe', 'pipe'] });
      children.push(child);
      let output = '';
      let errors = '';
      const entry = { finished: false, result: null };
      child.stdout.on('data', bytes => { output += bytes; });
      child.stderr.on('data', bytes => { errors += bytes; });
      entry.done = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', code => {
          entry.finished = true;
          try { entry.result = JSON.parse(output); resolve(entry.result); }
          catch { reject(new Error(`Recovery fixture exited ${code}: ${errors}`)); }
        });
      });
      return entry;
    };
    try {
      const first = launch('first');
      await vi.waitFor(() => expect(fs.existsSync(join(barrier, 'first-ready'))).toBe(true), { timeout: 5000 });
      const second = launch('second');
      await vi.waitFor(() => expect(second.finished || fs.existsSync(join(barrier, 'second-ready'))).toBe(true), { timeout: 5000 });
      fs.writeFileSync(join(barrier, 'first-release'), '');
      const recovered = await first.done;
      expect(recovered.error).toBeUndefined();
      fs.mkdirSync(join(directory, 'transaction'));
      fs.writeFileSync(join(directory, 'transaction', 'runtime'), 'new runtime evidence');
      fs.writeFileSync(join(barrier, 'second-release'), '');
      expect((await second.done).error).toMatch(/recovery.*(?:owned|progress)/i);
      expect(JSON.parse(fs.readFileSync(join(directory, 'state.json'), 'utf8')).hold).toEqual(recovered.hold);
      expect(fs.readFileSync(join(directory, 'transaction', 'runtime'), 'utf8')).toBe('new runtime evidence');
    } finally {
      for (const id of ['first', 'second']) fs.writeFileSync(join(barrier, `${id}-release`), '');
      await Promise.all(children.map(child => new Promise(resolve => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve();
        child.once('close', resolve);
        child.kill('SIGKILL');
      })));
    }
  });

  it('reclaims only a proven dead recovery owner and preserves its fence evidence', async () => {
    const { data, directory } = fixture();
    fs.mkdirSync(join(directory, 'transaction'));
    fs.writeFileSync(join(directory, 'transaction', 'original'), 'interrupted runtime evidence');
    const module = new URL('./recover-maintenance-transaction.mjs', import.meta.url).href;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import * as fs from 'node:fs';
      import { basename } from 'node:path';
      import { recoverMaintenanceTransaction } from ${JSON.stringify(module)};
      const io = { ...fs, mkdirSync(path, options) {
        if (basename(path).startsWith('recovered-')) process.kill(process.pid, 'SIGKILL');
        return fs.mkdirSync(path, options);
      } };
      await recoverMaintenanceTransaction('Interrupted recovery fixture', {
        data: process.argv[1], io, processes: async () => [],
      });
    `, data], { encoding: 'utf8', timeout: 5000 });
    expect(child.error).toBeUndefined();
    const owner = fs.readFileSync(join(directory, 'recovery', 'owner.json'));
    const recovered = await recoverMaintenanceTransaction(reason, { data, processes: stopped });
    const preserved = fs.readdirSync(directory).find(name => name.startsWith('recovery-interrupted-'));
    expect(fs.readFileSync(join(directory, preserved, 'owner.json'))).toEqual(owner);
    expect(fs.readFileSync(join(recovered.archiveDir, 'transaction', 'original'), 'utf8')).toBe('interrupted runtime evidence');
    expect(createMaintenanceAdmission(data).status()).toMatchObject({ state: 'ready', hold: recovered.hold });
  });

  it('lets the winning recovery release while a stale contender inspects its takeover marker', async () => {
    const { data, directory } = fixture();
    const dead = spawnSync(process.execPath, ['-e', ''], { timeout: 5000 });
    expect(dead.status).toBe(0);
    const fence = join(directory, 'recovery');
    fs.mkdirSync(fence);
    const originalOwner = JSON.stringify({ version: 1, pid: dead.pid, token: randomUUID() });
    fs.writeFileSync(join(fence, 'owner.json'), originalOwner);
    const barrier = join(data, 'barrier');
    fs.mkdirSync(barrier);
    const module = new URL('./recover-maintenance-transaction.mjs', import.meta.url).href;
    const source = `
      import * as fs from 'node:fs';
      import { join, basename } from 'node:path';
      import { recoverMaintenanceTransaction } from ${JSON.stringify(module)};
      const [data, barrier] = process.argv.slice(1);
      const wait = name => {
        const until = Date.now() + 10000;
        while (!fs.existsSync(join(barrier, name))) {
          if (Date.now() >= until) throw new Error('Recovery fixture barrier timed out');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
      };
      const io = { ...fs, mkdirSync(path, options) {
        if (basename(path).startsWith('recovered-')) {
          fs.writeFileSync(join(barrier, 'ready'), '');
          wait('release');
        }
        return fs.mkdirSync(path, options);
      } };
      try {
        wait('start');
        const result = await recoverMaintenanceTransaction('Winning recovery fixture', { data, io, processes: async () => [] });
        process.stdout.write(JSON.stringify(result));
      } catch (error) { process.stdout.write(JSON.stringify({ error: error.message })); }
      finally { fs.writeFileSync(join(barrier, 'finished'), ''); }
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', source, data, barrier], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let errors = '';
    child.stdout.on('data', bytes => { output += bytes; });
    child.stderr.on('data', bytes => { errors += bytes; });
    const done = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', code => {
        try { resolve(JSON.parse(output)); }
        catch { reject(new Error(`Recovery fixture exited ${code}: ${errors}`)); }
      });
    });
    let replacementOwner;
    let transitionFd;
    const io = { ...fs, openSync(path, ...args) {
      const transition = path === join(directory, 'recovery-transition');
      if (transition) {
        // The other process takes ownership after our inspection, immediately
        // before our takeover marker is created.
        fs.writeFileSync(join(barrier, 'start'), '');
        const until = Date.now() + 10000;
        while (!fs.existsSync(join(barrier, 'ready'))) {
          if (Date.now() >= until) throw new Error('Winning recovery did not take ownership');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
        replacementOwner = fs.readFileSync(join(fence, 'owner.json'));
      }
      const fd = fs.openSync(path, ...args);
      if (transition) transitionFd = fd;
      return fd;
    }, fstatSync(fd) {
      if (fd === transitionFd) {
        // Let the winner release after our marker is created but before our
        // descriptor inspection and cleanup. Its fence must remain removable.
        fs.writeFileSync(join(barrier, 'release'), '');
        const until = Date.now() + 10000;
        while (!fs.existsSync(join(barrier, 'finished'))) {
          if (Date.now() >= until) throw new Error('Winning recovery did not finish');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
      }
      return fs.fstatSync(fd);
    } };
    try {
      await expect(recoverMaintenanceTransaction(reason, { data, io, processes: stopped }))
        .rejects.toThrow('Maintenance recovery ownership changed during inspection.');
      expect(JSON.parse(replacementOwner).pid).toBe(child.pid);
      fs.writeFileSync(join(barrier, 'release'), '');
      const result = await done;
      expect(result.error).toBeUndefined();
      expect(fs.existsSync(fence)).toBe(false);
      expect(fs.existsSync(join(directory, 'recovery-transition'))).toBe(false);
      expect(createMaintenanceAdmission(data).status()).toMatchObject({ state: 'ready', hold: result.hold });
      const retired = fs.readdirSync(directory).find(name => name.startsWith('recovery-interrupted-'));
      expect(fs.readFileSync(join(directory, retired, 'owner.json'), 'utf8')).toBe(originalOwner);
    } finally {
      fs.writeFileSync(join(barrier, 'start'), '');
      fs.writeFileSync(join(barrier, 'release'), '');
      await done;
    }
  });

  it.each(['foreign transition evidence', ''])('preserves a replacement transition despite aliased file identity, bytes=%j', async foreign => {
    const { data, directory } = fixture();
    const dead = spawnSync(process.execPath, ['-e', ''], { timeout: 5000 });
    expect(dead.status).toBe(0);
    const fence = join(directory, 'recovery');
    fs.mkdirSync(fence);
    fs.writeFileSync(join(fence, 'owner.json'), JSON.stringify({ version: 1, pid: dead.pid, token: randomUUID() }));
    const transition = join(directory, 'recovery-transition');
    const displaced = join(data, 'displaced-transition');
    const replacement = JSON.stringify({ version: 1, pid: process.pid, token: randomUUID() });
    const io = { ...fs, openSync(path, ...args) {
      const fd = fs.openSync(path, ...args);
      if (path === transition) {
        fs.renameSync(transition, displaced);
        fs.writeFileSync(transition, foreign);
        fs.writeFileSync(join(fence, 'owner.json'), replacement);
      }
      return fd;
    }, fstatSync(fd) {
      // Pin the Windows failure: descriptor/path numeric identities can alias
      // even though the descriptor still owns the renamed original marker.
      fs.fstatSync(fd);
      return fs.lstatSync(transition);
    } };
    await expect(recoverMaintenanceTransaction(reason, { data, io, processes: stopped }))
      .rejects.toThrow('Maintenance recovery ownership changed during inspection.');
    expect(fs.readFileSync(transition, 'utf8')).toBe(foreign);
    expect(fs.readFileSync(join(fence, 'owner.json'), 'utf8')).toBe(replacement);
    expect(JSON.parse(fs.readFileSync(displaced, 'utf8'))).toMatchObject({ version: 1, pid: process.pid, token: expect.any(String) });
    expect(fs.existsSync(join(directory, 'state.json'))).toBe(false);
  });

  it('keeps legacy and standalone unfinished transitions closed without changing their evidence', async () => {
    const dead = spawnSync(process.execPath, ['-e', ''], { timeout: 5000 });
    expect(dead.status).toBe(0);
    for (const kind of ['legacy-directory', 'legacy-file', 'standalone-file']) {
      const { data, directory } = fixture();
      const fence = join(directory, 'recovery');
      const legacy = kind.startsWith('legacy-');
      if (legacy) {
        fs.mkdirSync(fence);
        fs.writeFileSync(join(fence, 'owner.json'), JSON.stringify({ version: 1, pid: dead.pid, token: randomUUID() }));
      }
      const marker = legacy ? join(fence, '.transition') : join(directory, 'recovery-transition');
      if (kind === 'legacy-directory') fs.mkdirSync(marker);
      else fs.writeFileSync(marker, 'interrupted transition evidence');
      await expect(recoverMaintenanceTransaction(reason, { data, processes: stopped })).rejects.toThrow(/unfinished transition/);
      if (kind === 'legacy-directory') expect(fs.lstatSync(marker).isDirectory()).toBe(true);
      else expect(fs.readFileSync(marker, 'utf8')).toBe('interrupted transition evidence');
      expect(fs.existsSync(join(directory, 'state.json'))).toBe(false);
    }
  });

  it('preserves unknown recovery ownership and refuses journal symlinks before any mutation', async () => {
    const { data, directory } = fixture();
    fs.mkdirSync(join(directory, 'recovery'));
    await expect(recoverMaintenanceTransaction(reason, { data, processes: stopped })).rejects.toThrow(/ownership is unverified/);
    expect(fs.readdirSync(directory)).toEqual(['recovery']);
    fs.rmdirSync(join(directory, 'recovery'));
    fs.rmdirSync(directory);
    const target = join(data, 'outside');
    fs.mkdirSync(target);
    fs.writeFileSync(join(target, 'evidence'), 'untouched');
    fs.symlinkSync(target, directory, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(recoverMaintenanceTransaction(reason, { data, processes: stopped })).rejects.toThrow(/real directory/);
    expect(fs.readdirSync(target)).toEqual(['evidence']);
    expect(fs.readFileSync(join(target, 'evidence'), 'utf8')).toBe('untouched');
  });

  it('preserves interrupted bytes and the original state, then holds admission until deliberate resume', async () => {
    const { data, directory, admission } = fixture();
    // A previously published journal must be preserved byte-for-byte as evidence.
    const work = admission.admit('agent', 'fixture');
    await work.finish();
    const before = fs.readFileSync(join(directory, 'state.json'));
    interrupt(directory);
    const since = fs.lstatSync(join(directory, 'transaction')).mtime.toISOString();
    const result = await recoverMaintenanceTransaction(reason, { data, processes: stopped });
    expect(fs.readFileSync(join(result.archiveDir, 'state.json'))).toEqual(before);
    expect(fs.readFileSync(join(result.archiveDir, 'transaction', 'evidence'), 'utf8')).toBe('retained lock evidence');
    expect(fs.readFileSync(join(result.archiveDir, 'pending-fixture.json'))).toHaveLength(0);
    expect(fs.readFileSync(join(result.archiveDir, 'pending-other.json'), 'utf8')).toBe('{"partial":true}');
    expect(JSON.parse(fs.readFileSync(join(result.archiveDir, 'receipt.json'), 'utf8'))).toMatchObject({
      reason, lockMtime: since, pending: [{ name: 'pending-fixture.json', size: 0 }, { name: 'pending-other.json', size: 16 }],
      hold: { owner: 'Transaction recovery' },
    });
    expect(fs.readdirSync(directory).sort()).toEqual([result.archiveDir.split(/[\\/]/).at(-1), 'state.json'].sort());
    const restarted = createMaintenanceAdmission(data);
    expect(restarted.status()).toMatchObject({ state: 'ready', hold: result.hold });
    expect(restarted.tryAdmit('agent', 'new')).toBeNull();
    expect(restarted.resume({ id: result.hold.id, revision: result.hold.revision }).state).toBe('normal');
  });

  it('retains a transaction replaced after recovery publishes its hold', async () => {
    const { data, directory } = fixture();
    fs.mkdirSync(join(directory, 'transaction'));
    fs.writeFileSync(join(directory, 'transaction', 'original'), 'original transaction evidence');
    const io = { ...fs, renameSync(source, destination) {
      fs.renameSync(source, destination);
      if (destination === join(directory, 'state.json')) {
        fs.renameSync(join(directory, 'transaction'), join(data, 'original-transaction'));
        fs.mkdirSync(join(directory, 'transaction'));
        fs.writeFileSync(join(directory, 'transaction', 'replacement'), 'new runtime evidence');
      }
    } };
    await expect(recoverMaintenanceTransaction(reason, { data, io, processes: stopped })).rejects.toThrow(/transaction changed/);
    expect(fs.readFileSync(join(directory, 'transaction', 'replacement'), 'utf8')).toBe('new runtime evidence');
    expect(fs.readFileSync(join(data, 'original-transaction', 'original'), 'utf8')).toBe('original transaction evidence');
    expect(createMaintenanceAdmission(data).status()).toMatchObject({ state: 'unavailable', cause: 'interrupted-transaction' });
  });

  it('recovers an absent state conservatively and preserves existing holds and unresolved operations', async () => {
    const absent = fixture();
    interrupt(absent.directory);
    await recoverMaintenanceTransaction(reason, { data: absent.data, processes: stopped });
    expect(createMaintenanceAdmission(absent.data).status()).toMatchObject({ state: 'ready', hold: { owner: 'Transaction recovery' } });

    const { data, directory, admission } = fixture();
    const work = admission.admit('settlement', 'Unfinished save');
    work.markUnsettled();
    const hold = admission.begin({ reason: 'Existing hold', owner: 'Operator' }).hold;
    const before = JSON.parse(fs.readFileSync(join(directory, 'state.json'), 'utf8'));
    interrupt(directory);
    await recoverMaintenanceTransaction(reason, { data, processes: stopped });
    expect(JSON.parse(fs.readFileSync(join(directory, 'state.json'), 'utf8'))).toEqual(before);
    expect(createMaintenanceAdmission(data).status()).toMatchObject({ state: 'draining', hold, blockers: [{ unsettled: true }] });
  });

  it('refuses live, transitioning or unreadable PM2 ownership and invalid journals without changing evidence', async () => {
    const { data, directory } = fixture();
    interrupt(directory);
    for (const inventory of [null, [{}], [{ name: 'portos-server', status: 'online', pid: 123 }],
      [{ name: 'portos-cos', status: 'launching', pid: 0 }], [{ name: 'portos-cos', status: 'stopped', pid: 123 }]]) {
      await expect(recoverMaintenanceTransaction(reason, { data, processes: async () => inventory })).rejects.toThrow(/PM2/);
    }
    for (const text of ['', '{bad json', '{"version":999}']) {
      fs.writeFileSync(join(directory, 'state.json'), text);
      await expect(recoverMaintenanceTransaction(reason, { data, processes: stopped })).rejects.toThrow();
      expect(fs.readFileSync(join(directory, 'state.json'), 'utf8')).toBe(text);
    }
    expect(fs.readdirSync(directory).sort()).toEqual(['pending-fixture.json', 'pending-other.json', 'state.json', 'transaction']);
    expect(fs.readFileSync(join(directory, 'transaction', 'evidence'), 'utf8')).toBe('retained lock evidence');
  });

  it('preserves an exclusive owner and its resume fence', async () => {
    const { data, directory, admission } = fixture();
    const hold = admission.begin({ reason: 'Exclusive work', owner: 'Operator' }).hold;
    admission.claimReady({ id: hold.id, revision: hold.revision, operation: {
      operationId: randomUUID(), requestId: randomUUID(), peerInstanceId: randomUUID(),
      hostInstanceId: randomUUID(), grantId: randomUUID(), grantGeneration: 1, scope: 'execution-v1',
      pairBinding: 'a'.repeat(64), intent: { action: 'portos.update' }, receiverVersion: '1.2.3', evidenceDigest: 'b'.repeat(64),
    } }, admission.observeIdle());
    const before = JSON.parse(fs.readFileSync(join(directory, 'state.json'), 'utf8'));
    interrupt(directory);
    await recoverMaintenanceTransaction(reason, { data, processes: stopped });
    expect(JSON.parse(fs.readFileSync(join(directory, 'state.json'), 'utf8'))).toEqual(before);
    const restarted = createMaintenanceAdmission(data);
    expect(restarted.status()).toMatchObject({ state: 'draining', hold });
    expect(() => restarted.resume({ id: hold.id, revision: hold.revision })).toThrow(/exclusive maintenance/);
  });

  it('keeps admission closed if recovery publication fails, and a confirmed retry preserves partial recovery', async () => {
    const { data, directory, admission } = fixture();
    interrupt(directory);
    const io = { ...fs, renameSync: (source, destination) => {
      if (destination === join(directory, 'state.json')) throw Object.assign(new Error('fixture disk full'), { code: 'ENOSPC' });
      return fs.renameSync(source, destination);
    } };
    await expect(recoverMaintenanceTransaction(reason, { data, processes: stopped, io })).rejects.toThrow('fixture disk full');
    expect(admission.status()).toMatchObject({ state: 'unavailable', cause: 'interrupted-transaction' });
    const partial = fs.readdirSync(directory).find(name => name.startsWith('recovered-'));
    expect(fs.readFileSync(join(directory, partial, 'pending-fixture.json'))).toHaveLength(0);
    await recoverMaintenanceTransaction(reason, { data, processes: stopped });
    expect(createMaintenanceAdmission(data).status()).toMatchObject({ state: 'ready', hold: { owner: 'Transaction recovery' } });
    expect(fs.existsSync(join(directory, partial, 'receipt.json'))).toBe(true);
  });

  it('refuses to release the original fence when interrupted pending evidence cannot be flushed', async () => {
    const { data, directory, admission } = fixture();
    interrupt(directory);
    const descriptors = new Map();
    const io = { ...fs,
      openSync: (path, ...args) => {
        const fd = fs.openSync(path, ...args);
        descriptors.set(fd, path);
        return fd;
      },
      closeSync: fd => { descriptors.delete(fd); fs.closeSync(fd); },
      fsyncSync: fd => {
        if (descriptors.get(fd) === join(directory, 'pending-fixture.json')) throw new Error('fixture evidence flush failed');
        fs.fsyncSync(fd);
      },
    };
    await expect(recoverMaintenanceTransaction(reason, { data, processes: stopped, io })).rejects.toThrow('fixture evidence flush failed');
    expect(admission.status()).toMatchObject({ state: 'unavailable', cause: 'interrupted-transaction' });
    expect(fs.readFileSync(join(directory, 'pending-fixture.json'))).toHaveLength(0);
    expect(fs.readFileSync(join(directory, 'pending-other.json'), 'utf8')).toBe('{"partial":true}');
    expect(descriptors.size).toBe(0);
    await recoverMaintenanceTransaction(reason, { data, processes: stopped });
    expect(createMaintenanceAdmission(data).status()).toMatchObject({ state: 'ready', hold: { owner: 'Transaction recovery' } });
  });
});
