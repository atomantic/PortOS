import { afterEach, describe, expect, it } from 'vitest';
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
