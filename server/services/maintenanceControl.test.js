import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { rmSync, watch } from 'node:fs';

const gate = vi.hoisted(() => ({ root: null, admission: null, notify: null }));
const resumeWork = vi.hoisted(() => ({ recover: vi.fn(async () => ({ checked: 0 })), queue: vi.fn(async () => {}), mind: vi.fn(async () => {}) }));
vi.mock('./cos.js', () => ({ resumeDeferredCompletions: (...args) => resumeWork.recover(...args), dequeueNextTask: (...args) => resumeWork.queue(...args) }));
vi.mock('./persistentMindSupervisor.js', () => ({ recheckPersistentMindSchedule: (...args) => resumeWork.mind(...args) }));
// The contract is the service's response to journal invalidations, not native
// filesystem delivery timing. Keep the real journal and inject only its watcher.
vi.mock('node:fs', async original => {
  const actual = await original();
  const { EventEmitter } = await import('node:events');
  return { ...actual, watch: vi.fn((_path, notify) => {
    gate.notify = notify;
    const watcher = new EventEmitter();
    watcher.close = vi.fn();
    watcher.unref = vi.fn();
    return watcher;
  }) };
});
vi.mock('../lib/maintenanceAdmission.js', async () => {
  const actual = await vi.importActual('../lib/maintenanceAdmission.js');
  const { mkdtempSync: mk } = await import('node:fs');
  const { tmpdir: tmp } = await import('node:os');
  const { join: j } = await import('node:path');
  gate.root = mk(j(tmp(), 'maintenance-control-'));
  gate.admission = actual.createMaintenanceAdmission(gate.root);
  return { ...actual, maintenance: gate.admission };
});
import { bindMaintenanceIo, _getMaintenanceWatcher, resumeMaintenance } from './maintenanceControl.js';

afterAll(() => {
  _getMaintenanceWatcher()?.close();
  rmSync(gate.root, { recursive: true, force: true });
});

const sent = [];
const io = { emit: (name, payload) => sent.push({ name, payload }) };
const count = name => sent.filter(e => e.name === name).length;
afterEach(() => {
  vi.useRealTimers();
  resumeWork.recover.mockReset().mockResolvedValue({ checked: 0 });
  resumeWork.queue.mockClear(); resumeWork.mind.mockClear();
});
const notifyJournalChange = async () => {
  const previousCount = sent.length;
  gate.notify('rename', 'state.json');
  await vi.advanceTimersByTimeAsync(99);
  expect(sent).toHaveLength(previousCount);
  await vi.advanceTimersByTimeAsync(1);
};

describe('maintenance notifications', () => {
  it('keeps detailed invalidations but only pushes the coarse readiness projection when it changes', async () => {
    vi.useFakeTimers();
    bindMaintenanceIo(io);
    const maintenance = gate.admission;
    expect(watch).toHaveBeenCalledWith(maintenance.directory, expect.any(Function));

    // Normal admit/settle churn rewrites the journal but not the banner projection.
    const op = maintenance.admit('agent', 'resource-that-must-not-leak');
    await notifyJournalChange();
    expect(count('maintenance:changed')).toBeGreaterThanOrEqual(1);
    expect(await op.finish()).toBe(true);
    expect(maintenance.status().blockers).toEqual([]);
    await notifyJournalChange();
    expect(count('maintenance:changed')).toBeGreaterThanOrEqual(2);
    expect(count('maintenance:readiness')).toBe(0);

    // Hold with a running operation: draining with a blocker count.
    const running = maintenance.admit('agent', 'resource-that-must-not-leak');
    maintenance.begin({ reason: 'Service work', owner: 'Operator' });
    await notifyJournalChange();
    expect(count('maintenance:readiness')).toBe(1);
    expect(sent.find(e => e.name === 'maintenance:readiness').payload).toEqual({ state: 'draining', blockerCount: 1 });

    // Settling the blocker moves to ready (count no longer displayed).
    expect(await running.finish()).toBe(true);
    await notifyJournalChange();
    expect(count('maintenance:readiness')).toBe(2);
    expect(sent.filter(e => e.name === 'maintenance:readiness')[1].payload).toEqual({ state: 'ready', blockerCount: 0 });

    // Leaving the hold returns to normal.
    const { hold } = maintenance.status();
    maintenance.resume({ id: hold.id, revision: hold.revision });
    await notifyJournalChange();
    expect(count('maintenance:readiness')).toBe(3);

    // Nothing private is broadcast.
    expect(JSON.stringify(sent)).not.toMatch(/resource-that-must-not-leak|pid|owner|hold/i);
  });

  it('handles watcher error without throwing and recovers watching on next emit', async () => {
    const watcher = _getMaintenanceWatcher();
    expect(watcher).toBeDefined();
    expect(watcher.listenerCount('error')).toBe(1);

    // Emitting error should close watcher and not throw
    expect(() => {
      watcher.emit('error', new Error('EPERM: operation not permitted'));
    }).not.toThrow();

    expect(_getMaintenanceWatcher()).toBeNull();
    expect(watcher.close).toHaveBeenCalledOnce();

    // Re-arming through bindMaintenanceIo or emitChanges restores the watcher
    bindMaintenanceIo(io);
    expect(_getMaintenanceWatcher()).not.toBeNull();
  });
});


describe('maintenance completion recovery wake-up', () => {
  it('returns normal immediately, repairs before dequeue, and refuses duplicate stale resume without another attempt', async () => {
    const operation = gate.admission.admit('runner', 'historical-fixture');
    const { hold } = gate.admission.begin({ reason: 'fixture deployment', owner: 'fixture' });
    let finish;
    resumeWork.recover.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const status = await resumeMaintenance({ id: hold.id, revision: hold.revision });
    expect(status.state).toBe('normal');
    expect(status.blockers).toHaveLength(1);
    expect(resumeWork.recover).toHaveBeenCalledOnce();
    expect(resumeWork.queue).not.toHaveBeenCalled();
    await expect(resumeMaintenance({ id: hold.id, revision: hold.revision })).rejects.toMatchObject({ code: 'MAINTENANCE_STALE' });
    expect(resumeWork.recover).toHaveBeenCalledOnce();
    finish({ checked: 3 });
    await vi.waitFor(() => expect(resumeWork.queue).toHaveBeenCalledOnce());
    expect(resumeWork.mind).toHaveBeenCalledOnce();
    expect(gate.admission.status().blockers).toHaveLength(1);
    await operation.finish();
  });

  it('reports a repair failure without holding maintenance or hiding the queue forever', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { hold } = gate.admission.begin({ reason: 'fixture deployment', owner: 'fixture' });
    resumeWork.recover.mockRejectedValue(new Error('fixture replay failure'));
    expect((await resumeMaintenance({ id: hold.id, revision: hold.revision })).state).toBe('normal');
    await vi.waitFor(() => expect(resumeWork.queue).toHaveBeenCalledOnce());
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('fixture replay failure'));
    warn.mockRestore();
  });
});
