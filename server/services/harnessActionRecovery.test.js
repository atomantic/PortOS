import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createMaintenanceAdmission } from '../lib/maintenanceAdmission.js';
import { __testing } from './harnessActionRecovery.js';
const { createHarnessActionRecovery } = __testing;

const roots = [];
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('harness action recovery', () => {
  it('retries a dead owner until its group is absent, then wakes deferred work', async () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-recovery-'));
    roots.push(root);
    const gone = new Set();
    const gate = () => createMaintenanceAdmission(root, { harnessAbsent: pid => gone.has(pid),
      harnessOwnerPresent: pid => !gone.has(pid), harnessParentPid: () => process.pid });
    const admission = gate();
    const owner = admission.harnessActions.reserve({ action: 'update', runtime: 'opencode', exclusive: true });
    admission.harnessActions.enter(owner.id, 555555);
    gone.add(process.pid);
    const resume = vi.fn(async () => {});
    const notify = vi.fn();
    const recovery = createHarnessActionRecovery({ admission: gate(), resume, notify });
    await recovery.check();
    expect(admission.status().hold.id).toBe(owner.holdId);
    expect(resume).not.toHaveBeenCalled();
    gone.add(-555555);
    await recovery.check();
    expect(admission.status().state).toBe('normal');
    expect(admission.harnessActions.pendingWake()).toEqual([]);
    expect(resume).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledOnce();
    await recovery.check();
    expect(resume).toHaveBeenCalledOnce();
  });

  it('retries a wake failure without pretending a second owner was released', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const reconcile = vi.fn().mockReturnValueOnce({ held: true }).mockReturnValue(null);
    let pending = [{ id: 'fixture', action: 'update', runtime: 'opencode' }];
    const pendingWake = () => pending;
    const markWakeProgress = (_id, progress) => { if (progress.woken) pending = []; };
    const resume = vi.fn().mockRejectedValueOnce(new Error('not ready')).mockResolvedValue(undefined);
    const notify = vi.fn();
    const recovery = createHarnessActionRecovery({ admission: { harnessActions: { reconcile, pendingWake, markWakeProgress } }, resume, notify });
    await recovery.check();
    await recovery.check();
    expect(resume).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
  });

  it('preserves a wake obligation across a failed wake and a new recovery instance', async () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-wake-'));
    roots.push(root);
    const admission = createMaintenanceAdmission(root);
    const owner = admission.harnessActions.reserve({ action: 'update', runtime: 'opencode', exclusive: true });
    admission.harnessActions.finish(owner.id);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const first = createHarnessActionRecovery({ admission, resume: async () => { throw new Error('not ready'); }, notify: vi.fn() });
    await first.check();
    expect(admission.harnessActions.pendingWake()).toEqual([{ id: owner.id, action: 'update', runtime: 'opencode' }]);
    const resume = vi.fn(async () => {});
    const second = createHarnessActionRecovery({ admission: createMaintenanceAdmission(root), resume, notify: vi.fn() });
    await second.check();
    expect(resume).toHaveBeenCalledOnce();
    expect(admission.harnessActions.pendingWake()).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('reports recovered overlap after the owner dies, before clearing its wake record', async () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-overlap-'));
    roots.push(root);
    const gone = new Set();
    const gate = () => createMaintenanceAdmission(root, { harnessAbsent: pid => gone.has(pid),
      harnessOwnerPresent: pid => !gone.has(pid), harnessParentPid: () => process.pid });
    const admission = gate();
    const owner = admission.harnessActions.reserve({ action: 'update', runtime: 'opencode', exclusive: true });
    admission.harnessActions.enter(owner.id, 555555);
    admission.harnessActions.verify(owner.id, 555555);
    const legacy = admission.recoverOwned('agent', 'legacy');
    await legacy.finish();
    gone.add(process.pid); gone.add(-555555);
    const report = vi.fn(async () => {});
    const recovery = createHarnessActionRecovery({ admission: gate(), resume: vi.fn(async () => {}), notify: vi.fn(), report });
    await recovery.check();
    expect(report).toHaveBeenCalledWith({ id: owner.id, action: 'update', runtime: 'opencode', overlap: true });
    expect(admission.harnessActions.pendingWake()).toEqual([]);
  });

  it('wakes work even if overlap reporting stalls without starting a duplicate report', async () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-independent-wake-'));
    roots.push(root);
    const admission = createMaintenanceAdmission(root, { harnessAbsent: pid => pid < 0,
      harnessOwnerPresent: () => true, harnessParentPid: () => process.pid });
    const owner = admission.harnessActions.reserve({ action: 'update', runtime: 'opencode', exclusive: true });
    admission.harnessActions.enter(owner.id, 555555);
    admission.harnessActions.verify(owner.id, 555555);
    const legacy = admission.recoverOwned('agent', 'legacy');
    await legacy.finish();
    admission.harnessActions.finish(owner.id, 555555);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let finishReport;
    const report = vi.fn(() => new Promise(resolve => { finishReport = resolve; }));
    const resume = vi.fn(async () => {});
    const recovery = createHarnessActionRecovery({ admission, resume, report, notify: vi.fn(), timeoutMs: 30 });
    await recovery.check();
    expect(resume).toHaveBeenCalledOnce();
    expect(admission.harnessActions.pendingWake()).toMatchObject([{ id: owner.id, overlap: true, woken: true }]);
    await recovery.check();
    expect(resume).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledOnce();
    finishReport();
    await vi.waitFor(() => expect(admission.harnessActions.pendingWake()).toEqual([]));
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('retries a failed report while preserving the completed wake', async () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-report-retry-'));
    roots.push(root);
    const admission = createMaintenanceAdmission(root, { harnessAbsent: pid => pid < 0,
      harnessOwnerPresent: () => true, harnessParentPid: () => process.pid });
    const owner = admission.harnessActions.reserve({ action: 'update', runtime: 'opencode', exclusive: true });
    admission.harnessActions.enter(owner.id, 555555);
    admission.harnessActions.verify(owner.id, 555555);
    const legacy = admission.recoverOwned('agent', 'legacy');
    await legacy.finish();
    admission.harnessActions.finish(owner.id, 555555);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const report = vi.fn().mockRejectedValueOnce(new Error('unavailable')).mockResolvedValue(undefined);
    const resume = vi.fn(async () => {});
    const recovery = createHarnessActionRecovery({ admission, resume, report, notify: vi.fn() });
    await recovery.check();
    expect(admission.harnessActions.pendingWake()).toMatchObject([{ id: owner.id, overlap: true, woken: true }]);
    await recovery.check();
    expect(report).toHaveBeenCalledTimes(2);
    expect(resume).toHaveBeenCalledOnce();
    expect(admission.harnessActions.pendingWake()).toEqual([]);
  });

  it('arms one unreferenced retry timer and stops it', async () => {
    vi.useFakeTimers();
    const reconcile = vi.fn(() => null);
    const recovery = createHarnessActionRecovery({ admission: { harnessActions: { reconcile, pendingWake: () => [] } }, intervalMs: 5000 });
    recovery.start(); recovery.start();
    await vi.advanceTimersByTimeAsync(5000);
    expect(reconcile).toHaveBeenCalledOnce();
    recovery.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(reconcile).toHaveBeenCalledOnce();
  });
});
