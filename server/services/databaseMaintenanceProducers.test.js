import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const mocks = vi.hoisted(() => ({ root: '/tmp/example-install', list: vi.fn(), stop: vi.fn() }));
vi.mock('../lib/paths.js', () => ({ PATHS: {
  get installRoot() { return mocks.root; }, get data() { return mocks.root + '/data'; },
} }));
vi.mock('./pm2.js', () => ({ listMaintenanceProcesses: mocks.list, stopApp: mocks.stop }));
import { createDatabaseMaintenanceJournal } from '../lib/databaseMaintenanceJournal.js';
import { stopOwnedDatabaseProducers } from './databaseMaintenanceProducers.js';

const source = { mode: 'native', host: 'localhost', port: 5432, database: 'example_test', user: 'example' };
const target = { ...source, mode: 'docker', port: 5561 };
let journal;
let operation;
let token;
let rows;

beforeEach(() => {
  mocks.root = mkdtempSync(join(tmpdir(), 'maintenance-producers-'));
  mkdirSync(join(mocks.root, 'server', 'cos-runner'), { recursive: true });
  writeFileSync(join(mocks.root, 'server', 'start.js'), '');
  writeFileSync(join(mocks.root, 'server', 'cos-runner', 'index.js'), '');
  writeFileSync(join(mocks.root, '.portos-disposable-root'), '');
  journal = createDatabaseMaintenanceJournal(join(mocks.root, 'data'));
  rows = [
    { name: 'portos-cos', pmId: 12, pid: 1012, status: 'online', cwd: mocks.root, script: 'server/cos-runner/index.js' },
    { name: 'portos-server', pmId: 13, pid: 1013, status: 'online', cwd: mocks.root, script: 'server/start.js' },
  ];
  mocks.list.mockReset().mockImplementation(async () => rows.map(row => ({ ...row })));
  mocks.stop.mockReset().mockImplementation(async id => {
    expect(journal.read().stage).toBe('quiescing');
    expect(journal.readProducerSnapshot(operation.id, token)).toHaveLength(2);
    expect(() => journal.assertAdmission()).toThrow();
    const row = rows.find(value => value.pmId === id);
    row.status = 'stopped'; row.pid = 0;
    return { success: true };
  });
});
afterEach(() => rmSync(mocks.root, { recursive: true, force: true }));

function begin(from = source, to = target) {
  operation = journal.begin({ source: from, target: to });
  token = journal.acquireCoordinator(operation.id);
  return journal.reserveCoordinatorWorker(operation.id, token);
}

function successor() {
  const oldToken = token;
  writeFileSync(join(mocks.root, 'data', 'database-maintenance', 'worker-' + oldToken, 'exit'), '17\n');
  token = journal.recoverCoordinator(operation.id, oldToken, randomUUID());
  journal.reserveCoordinatorWorker(operation.id, token);
  return oldToken;
}

describe('owned database producer shutdown', () => {
  it.each([[source, target], [target, source]])('stops CoS before server with retained original identities and closed admission', async (from, to) => {
    begin(from, to);
    const result = await stopOwnedDatabaseProducers(operation.id, token);
    expect(result).toEqual({ id: operation.id, stage: 'quiescing', producersStopped: true,
      quiescenceVerified: false, transferReady: false });
    expect(mocks.stop.mock.calls).toEqual([[12], [13]]);
    expect(mocks.list).toHaveBeenCalledTimes(6);
    expect(journal.read()).toEqual({ ...operation, stage: 'quiescing' });
    expect(journal.readProducerSnapshot(operation.id, token).map(row => row.pid)).toEqual([1012, 1013]);
    expect(() => journal.assertAdmission()).toThrow();
    await expect(stopOwnedDatabaseProducers(operation.id, token)).rejects.toThrow();
  });

  it.each(['unavailable', 'missing', 'duplicate', 'foreign-root', 'foreign-script', 'unknown-status', 'shared-id'])('refuses %s inventory before any stop', async fault => {
    begin();
    if (fault === 'unavailable') mocks.list.mockResolvedValue(null);
    if (fault === 'missing') rows.pop();
    if (fault === 'duplicate') rows.push({ ...rows[0] });
    if (fault === 'foreign-root') rows[0].cwd = tmpdir();
    if (fault === 'foreign-script') rows[0].script = 'server/start.js';
    if (fault === 'unknown-status') rows[0].status = 'launching';
    if (fault === 'shared-id') rows[1].pmId = rows[0].pmId;
    await expect(stopOwnedDatabaseProducers(operation.id, token)).rejects.toThrow();
    expect(mocks.stop).not.toHaveBeenCalled();
    expect(journal.read().stage).toBe('accepted');
    expect(() => journal.assertAdmission()).toThrow();
  });

  it.each(['throws', 'false-success', 'unchanged', 'read-failed'])('refuses stop failure %s without transfer', async fault => {
    begin();
    if (fault === 'throws') mocks.stop.mockRejectedValue(new Error('stop refused'));
    if (fault === 'false-success') mocks.stop.mockResolvedValue({ success: false });
    if (fault === 'unchanged') mocks.stop.mockResolvedValue({ success: true });
    if (fault === 'read-failed') mocks.stop.mockImplementation(async () => {
      mocks.list.mockRejectedValue(new Error('daemon unavailable')); return { success: true };
    });
    await expect(stopOwnedDatabaseProducers(operation.id, token)).rejects.toThrow();
    expect(mocks.stop).toHaveBeenCalledTimes(1);
    expect(journal.read().stage).toBe('quiescing');
    expect(() => journal.assertAdmission()).toThrow();
  });

  it('resumes only the original operation and retained producer identity after an interrupted stop', async () => {
    begin();
    const stop = mocks.stop.getMockImplementation();
    mocks.stop.mockImplementation(async id => {
      if (id === 13) throw new Error('interrupted');
      return stop(id);
    });
    await expect(stopOwnedDatabaseProducers(operation.id, token)).rejects.toThrow();
    const originalSnapshot = readFileSync(join(mocks.root, 'data', 'database-maintenance', 'producers.json'), 'utf8');
    const retired = successor();
    mocks.stop.mockImplementation(stop);
    await expect(stopOwnedDatabaseProducers(operation.id, retired)).rejects.toThrow();
    mocks.stop.mockClear();
    expect(await stopOwnedDatabaseProducers(operation.id, token)).toMatchObject({ producersStopped: true, transferReady: false });
    expect(mocks.stop.mock.calls).toEqual([[13]]);
    expect(readFileSync(join(mocks.root, 'data', 'database-maintenance', 'producers.json'), 'utf8')).toBe(originalSnapshot);
    expect(journal.read()).toEqual({ ...operation, stage: 'quiescing' });
  });

  it.each(['pid', 'pmId', 'corrupt-snapshot'])('refuses changed %s on same-operation recovery', async fault => {
    begin();
    mocks.stop.mockRejectedValue(new Error('interrupted'));
    await expect(stopOwnedDatabaseProducers(operation.id, token)).rejects.toThrow();
    successor();
    if (fault === 'corrupt-snapshot') writeFileSync(join(mocks.root, 'data', 'database-maintenance', 'producers.json'), '{}');
    else rows[0][fault] += 1;
    mocks.stop.mockClear();
    await expect(stopOwnedDatabaseProducers(operation.id, token)).rejects.toThrow();
    expect(mocks.stop).not.toHaveBeenCalled();
    expect(() => journal.assertAdmission()).toThrow();
  });

  it('rechecks coordinator authority after an in-flight daemon read', async () => {
    begin();
    mocks.list.mockImplementationOnce(async () => {
      successor();
      return rows.map(row => ({ ...row }));
    });
    const retired = token;
    await expect(stopOwnedDatabaseProducers(operation.id, retired)).rejects.toThrow();
    expect(mocks.stop).not.toHaveBeenCalled();
    expect(journal.read().stage).toBe('accepted');
  });
});
