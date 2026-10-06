import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import * as syncFs from 'node:fs';
import { existsSync } from 'node:fs';
import { tmpdir, type as hostOsType } from 'node:os';
import { pinPlatform } from './testHelper.js';
import { join } from 'node:path';
import { once } from 'node:events';
import { createBackupSharedAdmission } from './backupSharedAdmission.js';
import { DISPOSABLE_ROOT_MARKER } from './dataRoot.js';

const roots = [];
const children = [];
const boundaryUrl = new URL('./backupSnapshotBoundary.js', import.meta.url).href;
const childSource = `
  import { writeFile, mkdir } from 'node:fs/promises';
  import { join } from 'node:path';
  const { withBackupAssetPublication, acquireBackupSnapshotCut } = await import(${JSON.stringify(boundaryUrl)});
  let finish;
  const done = new Promise(resolve => { finish = resolve; });
  process.on('message', message => { if (message === 'finish') finish(); });
  const root = process.env.PORTOS_DATA_ROOT;
  const mode = process.env.ADMISSION_TEST_MODE;
  process.send({ type: 'starting' });
  try {
    if (mode === 'publication' || mode === 'unadmitted') {
      const publish = mode === 'unadmitted' ? work => work() : withBackupAssetPublication;
      await publish(async () => {
        await writeFile(join(root, 'data', 'output.txt'), process.env.ADMISSION_TEST_VALUE);
        process.send({ type: 'entered' });
        await done;
        await writeFile(join(root, 'data', 'metadata.json'), JSON.stringify({ output: process.env.ADMISSION_TEST_VALUE }));
      }, { timeoutMs: Number(process.env.ADMISSION_TEST_TIMEOUT || 5000) });
    } else {
      const release = await acquireBackupSnapshotCut({ timeoutMs: Number(process.env.ADMISSION_TEST_TIMEOUT || 5000) });
      process.send({ type: 'entered' });
      await done;
      release();
      release(); // stale duplicate releases must be harmless
    }
    process.send({ type: 'finished' });
  } catch (error) { process.send({ type: 'rejected', code: error.code, message: error.message, blockers: error.blockers, owner: error.owner, recoveryPath: error.recoveryPath }); }
`;
async function root() {
  const path = await mkdtemp(join(tmpdir(), 'backup-shared-race-'));
  roots.push(path);
  await mkdir(join(path, 'data'));
  // A checkout under data/cos/worktrees refuses a live PORTOS_DATA_ROOT pin; the
  // marker declares this throwaway root disposable so the child honors it there too.
  await writeFile(join(path, DISPOSABLE_ROOT_MARKER), '');
  return path;
}
function worker(path, mode, value = '', timeout = 5000) {
  const env = { ...process.env, PORTOS_DATA_ROOT: path, ADMISSION_TEST_MODE: mode,
    ADMISSION_TEST_VALUE: value, ADMISSION_TEST_TIMEOUT: String(timeout) };
  // These are real Node children, not Vitest workers; keep their filesystem
  // rooted at the private install above and do not inherit a runner identity.
  delete env.VITEST; delete env.VITEST_WORKER_ID; delete env.VITEST_POOL_ID;
  const proc = spawn(process.execPath, ['--input-type=module', '-e', childSource], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  children.push(proc);
  const messages = [];
  let stderr = '';
  proc.stderr.on('data', data => { stderr += data; });
  proc.on('message', message => messages.push(message));
  return { proc, messages,
    async next(type) {
      await vi.waitFor(() => {
        if (proc.exitCode !== null) throw new Error(`Child exited ${proc.exitCode}: ${stderr}`);
        expect(messages.some(message => message.type === type), stderr).toBe(true);
      }, { timeout: 10000, interval: 10 });
      return messages.find(message => message.type === type);
    },
    finish: () => proc.send('finish'),
    async crash() { const exited = once(proc, 'exit'); proc.kill('SIGKILL'); await exited; },
  };
}
afterEach(async () => {
  await Promise.all(children.splice(0).map(async proc => {
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    const exited = once(proc, 'exit'); proc.kill('SIGKILL'); await exited;
  }));
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('shared snapshot admission between real server and runner processes', () => {
  it('drains the file/metadata pair and excludes a later process through the cut', async () => {
    const path = await root();
    const first = worker(path, 'publication', 'first');
    await first.next('entered');
    const cut = worker(path, 'cut');
    await cut.next('starting');
    await vi.waitFor(() => expect(existsSync(join(path, 'data/backup-admission/cut/owner.json'))).toBe(true));
    expect(cut.messages.some(message => message.type === 'entered')).toBe(false);
    const later = worker(path, 'publication', 'later');
    await later.next('starting');
    first.finish();
    await first.next('finished');
    await cut.next('entered');
    expect(await readFile(join(path, 'data/output.txt'), 'utf8')).toBe('first');
    expect(JSON.parse(await readFile(join(path, 'data/metadata.json'), 'utf8'))).toEqual({ output: 'first' });
    expect(later.messages.some(message => message.type === 'entered')).toBe(false);
    cut.finish();
    await cut.next('finished');
    await later.next('entered');
    later.finish();
    await later.next('finished');
    expect(JSON.parse(await readFile(join(path, 'data/metadata.json'), 'utf8'))).toEqual({ output: 'later' });
  });

  it('negative control: a nonparticipating process can change the copied pair under a cut', async () => {
    const path = await root();
    const writer = worker(path, 'unadmitted', 'uncoordinated');
    await writer.next('entered');
    const cut = worker(path, 'cut');
    await cut.next('entered');
    expect(existsSync(join(path, 'data/metadata.json'))).toBe(false);
    writer.finish();
    await writer.next('finished');
    expect(JSON.parse(await readFile(join(path, 'data/metadata.json'), 'utf8'))).toEqual({ output: 'uncoordinated' });
    cut.finish();
    await cut.next('finished');
  });

  it('persists newly created control ancestors before admitting a first publication', async () => {
    const path = await root();
    const directory = join(path, 'data/backup-admission');
    const opened = new Map();
    const synced = [];
    const io = { ...syncFs,
      openSync(path, ...args) { const fd = syncFs.openSync(path, ...args); opened.set(fd, path); return fd; },
      fsyncSync(fd) { synced.push(opened.get(fd)); syncFs.fsyncSync(fd); },
    };
    const admission = createBackupSharedAdmission(directory, { io });
    const lease = admission.tryPublication();
    try {
      expect(synced).toContain(join(lease.path, 'owner.json'));
      if (process.platform !== 'win32') {
        expect(synced).toEqual(expect.arrayContaining([join(directory, 'publications'), directory, join(path, 'data')]));
        expect(synced.indexOf(join(path, 'data'))).toBeLessThan(synced.indexOf(join(lease.path, 'owner.json')));
      }
    } finally { lease.release(); }
  });

  it('keeps real filesystem durability when a caller pins the opposite platform', async () => {
    const path = await root();
    const directory = join(path, 'data/backup-admission');
    const nativeWindows = hostOsType() === 'Windows_NT';
    const opened = new Map();
    const synced = [];
    const io = { ...syncFs,
      openSync(path, ...args) { const fd = syncFs.openSync(path, ...args); opened.set(fd, path); return fd; },
      fsyncSync(fd) { synced.push(opened.get(fd)); syncFs.fsyncSync(fd); },
    };
    const restorePlatform = pinPlatform(nativeWindows ? 'darwin' : 'win32');
    try {
      const admission = createBackupSharedAdmission(directory, { io });
      const lease = admission.tryPublication();
      expect(synced).toContain(join(lease.path, 'owner.json'));
      expect(synced.includes(directory)).toBe(!nativeWindows);
      const cut = admission.reserveCut();
      expect(admission.status().publications).toHaveLength(1);
      lease.release();
      expect(admission.status().publications).toHaveLength(0);
      cut.release();
      expect(admission.status().cut).toBeNull();
    } finally { restorePlatform(); }
  });

  it('keeps a killed writer as a durable blocker across coordinator restarts', async () => {
    const path = await root();
    const writer = worker(path, 'publication', 'half pair');
    await writer.next('entered');
    await writer.crash();
    for (let attempt = 0; attempt < 2; attempt++) {
      const cut = worker(path, 'cut', '', 50);
      const rejected = await cut.next('rejected');
      expect(rejected).toMatchObject({ code: 'BACKUP_SNAPSHOT_BUSY', blockers: [expect.objectContaining({ kind: 'publication', pid: writer.proc.pid })] });
      expect(rejected.message).toContain('must not be removed by age or PID');
    }
    expect(existsSync(join(path, 'data/metadata.json'))).toBe(false);
    expect(existsSync(join(path, 'data/backup-admission/cut'))).toBe(false);
  });

  it('preserves a crashed cut instead of letting another process steal it', async () => {
    const path = await root();
    const owner = worker(path, 'cut');
    await owner.next('entered');
    await owner.crash();
    const contender = worker(path, 'cut');
    expect(await contender.next('rejected')).toMatchObject({ code: 'BACKUP_SNAPSHOT_BUSY', message: expect.stringContaining('reconcile the interrupted backup or restore') });
    const gate = JSON.parse(await readFile(join(path, 'data/backup-admission/cut/owner.json'), 'utf8'));
    expect(gate.pid).toBe(owner.proc.pid);
    const writer = worker(path, 'publication', 'must not write', 50);
    expect(await writer.next('rejected')).toMatchObject({ code: 'BACKUP_SNAPSHOT_BUSY',
      owner: { id: gate.id, pid: owner.proc.pid }, recoveryPath: join(path, 'data/backup-admission/cut') });
    expect(writer.messages.some(message => message.type === 'entered')).toBe(false);
    expect(existsSync(join(path, 'data/output.txt'))).toBe(false);
    expect(JSON.parse(await readFile(join(path, 'data/backup-admission/cut/owner.json'), 'utf8'))).toEqual(gate);
  });

  it('refuses a child publication after bounded wait on corrupt cut ownership without changing it', async () => {
    const path = await root();
    const cutPath = join(path, 'data/backup-admission/cut');
    await mkdir(cutPath, { recursive: true });
    await writeFile(join(cutPath, 'owner.json'), '{broken');
    const writer = worker(path, 'publication', 'must not write', 50);
    expect(await writer.next('rejected')).toMatchObject({ code: 'BACKUP_SNAPSHOT_BUSY',
      owner: { path: cutPath, unreadable: true }, recoveryPath: cutPath });
    expect(writer.messages.some(message => message.type === 'entered')).toBe(false);
    expect(existsSync(join(path, 'data/output.txt'))).toBe(false);
    expect(await readFile(join(cutPath, 'owner.json'), 'utf8')).toBe('{broken');
  });

  it('fails closed on unreadable ownership and refuses a stale release', async () => {
    const path = await root();
    const directory = join(path, 'data/backup-admission');
    const admission = createBackupSharedAdmission(directory);
    const cut = admission.reserveCut();
    await writeFile(join(directory, 'cut/owner.json'), '{broken');
    expect(() => cut.release()).toThrow('ownership changed');
    expect(() => admission.reserveCut()).toThrow('already owned');
    expect(admission.tryPublication()).toBe(null);
    expect(admission.status().cut).toMatchObject({ unreadable: true });
  });
});
