import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMaintenanceAdmission } from './maintenanceAdmission.js';

const roots = [];
// Frozen pre-stamp v1 operation-reader fixture: unknown fields were rejected.
const legacyOperation = z.object({ id: z.string().uuid(), kind: z.string().min(1), resource: z.string().max(256),
  pid: z.number().int().positive(), startedAt: z.string().datetime(), unsettled: z.boolean().optional() }).strict();
const gate = () => {
  const root = mkdtempSync(join(tmpdir(), 'workflow-admission-'));
  roots.push(root);
  return { root, admission: createMaintenanceAdmission(root) };
};
afterEach(() => { vi.useRealTimers(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('durable graceful maintenance', () => {
  it('binds operator publication reconciliation to the exact hold and owner and publishes before retirement', async () => {
    const { root, admission } = gate();
    const owner = admission.admit('settlement', 'Output publication');
    owner.markUnsettled();
    const other = admission.admit('agent', 'unrelated');
    const hold = admission.begin({ reason: 'Inspect refused publication', owner: 'Operator' }).hold;
    const expected = JSON.parse(fs.readFileSync(join(root, 'workflow-maintenance', 'state.json'))).operations.find(op => op.id === owner.id);
    let receipt;
    const publish = vi.fn(() => {
      expect(JSON.parse(fs.readFileSync(join(root, 'workflow-maintenance', 'state.json'))).operations)
        .toContainEqual(expect.objectContaining({ id: owner.id, kind: 'settlement' }));
      receipt ??= { operation: expected, disposition: 'operator-reconciled' };
      return receipt;
    });
    const replay = vi.fn(() => receipt);
    expect(() => admission.reconcilePublicationRefusal({ hold: { ...hold, revision: hold.revision + 1 }, expected, publish, replay })).toThrow('hold changed');
    expect(() => admission.reconcilePublicationRefusal({ hold, expected: { ...expected, uncertaintyStamp: 'changed' }, publish, replay })).toThrow('reservation changed');
    expect(publish).not.toHaveBeenCalled();
    expect(admission.reconcilePublicationRefusal({ hold, expected, publish, replay })).toBe(receipt);
    expect(admission.status()).toMatchObject({ hold, blockers: [{ resource: 'unrelated' }] });
    expect(admission.reconcilePublicationRefusal({ hold, expected, publish, replay })).toBe(receipt);
    expect(publish).toHaveBeenCalledOnce();
    expect(replay).toHaveBeenCalledOnce();
    await other.finish();
  });

  it('mints completion only when trusted recovery reuses an existing operation', () => {
    const { admission } = gate();
    expect(admission.admit('media', 'new')).not.toHaveProperty('completeRecovery');
    expect(admission.recoverOwned('media', 'observed-new')).not.toHaveProperty('completeRecovery');
    expect(admission.admit('media', 'reconnect-new', { reconnect: true })).not.toHaveProperty('completeRecovery');
    expect(admission.recoverOwned('media', 'new')).toHaveProperty('completeRecovery');
  });

  it('completes only the captured recovered operation and preserves the hold and failed settlement child', async () => {
    const { admission } = gate();
    const original = admission.admit('media', 'peer-render');
    await original.run(async () => admission.markCurrentUnsettled());
    const other = admission.admit('provider', 'unrelated');
    const hold = admission.begin({ reason: 'Drain', owner: 'Operator' }).hold;
    await expect(original.run(() => admission.continueSettlement(async () => { throw new Error('save failed'); }))).rejects.toThrow('save failed');
    await original.finish();
    const recovered = admission.recoverOwned('media', 'peer-render');
    other.markUnsettled();
    const blockers = admission.status().blockers.filter(entry => entry.resource !== 'peer-render');
    expect(recovered.completeRecovery()).toBe(true);
    expect(admission.status()).toMatchObject({ state: 'draining', hold, blockers });
    expect(blockers).toContainEqual(expect.objectContaining({ kind: 'settlement', unsettled: true }));
    expect(blockers).toContainEqual(expect.objectContaining({ resource: 'unrelated' }));
    expect(recovered.completeRecovery()).toBe(false);
    await other.finish();
    expect(admission.status().state).toBe('draining');
  });

  it('rotates every uncertainty stamp and refuses a captured capability after another mark', async () => {
    const { admission } = gate();
    const work = admission.admit('media', 'peer-render');
    const readOperation = () => JSON.parse(fs.readFileSync(join(admission.directory, 'state.json'), 'utf8')).operations[0];
    await work.run(async () => admission.markCurrentUnsettled());
    const first = readOperation().uncertaintyStamp;
    const recovered = admission.recoverOwned('media', 'peer-render');
    await recovered.run(async () => admission.markCurrentUnsettled());
    expect(readOperation().uncertaintyStamp).not.toBe(first);
    expect(recovered.completeRecovery()).toBe(false);
    await recovered.finish();
    expect(admission.status().blockers).toContainEqual(expect.objectContaining({ resource: 'peer-render', unsettled: true }));
  });

  it('refuses a replacement operation with the same resource or a changed bound resource', async () => {
    const { admission } = gate();
    const work = admission.admit('media', 'peer-render');
    work.markUnsettled();
    const recovered = admission.recoverOwned('media', 'peer-render');
    const file = join(admission.directory, 'state.json');
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    state.operations[0].id = randomUUID();
    fs.writeFileSync(file, JSON.stringify(state));
    expect(recovered.completeRecovery()).toBe(false);
    const replacement = admission.recoverOwned('media', 'peer-render');
    replacement.identify('changed-resource');
    expect(replacement.completeRecovery()).toBe(false);
    expect(admission.status().blockers).toContainEqual(expect.objectContaining({ resource: 'changed-resource', unsettled: true }));
  });

  it('requires fresh recovery after restart and never infers completion from old owner PID or age', async () => {
    const { root, admission } = gate();
    const original = admission.admit('media', 'peer-render');
    original.markUnsettled();
    const hold = admission.begin({ reason: 'Drain', owner: 'Operator' }).hold;
    const restarted = createMaintenanceAdmission(root);
    expect(restarted.status()).toMatchObject({ state: 'draining', hold, blockers: [{ unsettled: true }] });
    const recovered = restarted.recoverOwned('media', 'peer-render');
    expect(recovered.id).toBe(original.id);
    await recovered.finish();
    expect(restarted.status().state).toBe('draining');
    expect(recovered.completeRecovery()).toBe(true);
    expect(restarted.status()).toMatchObject({ state: 'ready', hold, blockers: [] });
  });

  it('reads legacy records but refuses to complete legacy uncertainty without a stamp', async () => {
    const { root, admission } = gate();
    const work = admission.admit('media', 'legacy');
    work.markUnsettled();
    const file = join(admission.directory, 'state.json');
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    delete state.operations[0].uncertaintyStamp;
    fs.writeFileSync(file, JSON.stringify(state));
    const restarted = createMaintenanceAdmission(root);
    const recovered = restarted.recoverOwned('media', 'legacy');
    expect(recovered.completeRecovery()).toBe(false);
    await recovered.finish();
    expect(restarted.status().blockers).toContainEqual(expect.objectContaining({ resource: 'legacy', unsettled: true }));
  });

  it('accounts for strict old-reader rejection instead of treating stamped v1 journals as rollback compatible', () => {
    const { admission } = gate();
    const work = admission.admit('media', 'peer-render');
    const file = join(admission.directory, 'state.json');
    const readOperation = () => JSON.parse(fs.readFileSync(file, 'utf8')).operations[0];
    expect(legacyOperation.safeParse(readOperation()).success).toBe(true);
    work.markUnsettled();
    expect(legacyOperation.safeParse(readOperation()).success).toBe(false);
    expect(admission.status().blockers).toContainEqual(expect.objectContaining({ resource: 'peer-render', unsettled: true }));
  });

  it('preserves an old writer transaction lock and refuses admission or completion after a compatible restart', () => {
    const { root, admission } = gate();
    const work = admission.admit('media', 'peer-render');
    work.markUnsettled();
    const recovered = admission.recoverOwned('media', 'peer-render');
    const file = join(admission.directory, 'state.json');
    const before = fs.readFileSync(file, 'utf8');
    // The older writer acquired its lock before parsing. A parse failure kept
    // the lock, just as an uncertain publication did; do not repair it by age.
    fs.mkdirSync(join(admission.directory, 'transaction'));
    expect(() => legacyOperation.parse(JSON.parse(before).operations[0])).toThrow();
    const restarted = createMaintenanceAdmission(root);
    expect(restarted.status().state).toBe('unavailable');
    expect(restarted.tryAdmit('media', 'new')).toBeNull();
    expect(() => recovered.completeRecovery()).toThrow(/needs recovery/);
    expect(fs.existsSync(join(admission.directory, 'transaction'))).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it('keeps journal write failure unavailable without claiming recovered completion', () => {
    const { root } = gate();
    let fail = false;
    const io = { ...fs, renameSync: (...args) => {
      if (fail) throw Object.assign(new Error('fixture disk failure'), { code: 'EIO' });
      return fs.renameSync(...args);
    } };
    const admission = createMaintenanceAdmission(root, { io });
    const work = admission.admit('media', 'peer-render');
    work.markUnsettled();
    const recovered = admission.recoverOwned('media', 'peer-render');
    fail = true;
    expect(() => recovered.completeRecovery()).toThrow(/needs recovery/);
    expect(admission.status().state).toBe('unavailable');
    const persisted = JSON.parse(fs.readFileSync(join(admission.directory, 'state.json'), 'utf8'));
    expect(persisted.operations.map(op => op.id)).toContain(work.id);
  });

  it('reuses remote reconciliation ownership without bypassing a hold', async () => {
    const { admission } = gate();
    const existing = admission.admit('media', 'peer-render');
    const hold = admission.begin({ reason: 'Drain', owner: 'Operator' }).hold;
    expect(admission.tryAdmit('media', 'peer-render', { reconnect: true })).toBeNull();
    admission.resume({ id: hold.id, revision: hold.revision });
    const reconnected = admission.admit('media', 'peer-render', { reconnect: true });
    expect(reconnected.id).toBe(existing.id);
    expect(admission.status().blockers).toHaveLength(1);
    await reconnected.finish();
    expect(admission.status().blockers).toEqual([]);
  });

  it('fences every new admission while an admitted thought can finish its next provider call and saving', async () => {
    const { admission } = gate();
    const turn = admission.admit('mind-turn', 'thought');
    const hold = admission.begin({ reason: 'Update renderer', owner: 'Local operator' });
    expect(hold.state).toBe('draining');
    for (const kind of ['agent', 'media', 'mind-turn', 'runner', 'shell-job']) {
      expect(() => admission.admit(kind, 'new')).toThrowError(/holding new work/);
    }
    let releaseSave;
    const saving = new Promise(resolve => { releaseSave = resolve; });
    const completion = turn.run(() => admission.run('provider', 'next call', () => saving, { continuation: true }));
    await turn.finish();
    expect(admission.status().state).toBe('draining');
    releaseSave();
    await completion;
    expect(admission.status().state).toBe('ready');
    expect(admission.status().hold.id).toBe(hold.hold.id);
    expect(admission.status().blockers).toEqual([]);
  });

  it('runs required completion callbacks after a failed save while retaining the original blocker', async () => {
    const { admission } = gate();
    const provider = admission.admit('provider', 'example');
    admission.begin({ reason: 'Work', owner: 'Operator' });
    provider.markUnsettled();
    const callback = vi.fn(async () => 'completed');
    expect(await provider.run(() => admission.continueSettlement(callback))).toBe('completed');
    await provider.finish();
    expect(callback).toHaveBeenCalledTimes(1);
    expect(admission.status()).toMatchObject({ state: 'draining', blockers: [{ unsettled: true }] });
  });

  it('reconnects observed existing work under its original durable identity during a hold', async () => {
    const { root, admission } = gate();
    const original = admission.admit('media', 'training');
    admission.begin({ reason: 'Work', owner: 'Operator' });
    const restarted = createMaintenanceAdmission(root);
    const recovered = restarted.recoverOwned('media', 'training');
    expect(recovered.id).toBe(original.id);
    expect(restarted.status().blockers).toHaveLength(1);
    await recovered.finish();
    expect(admission.status().state).toBe('ready');
  });

  it('a second process sees the same fence and restart never discards old ownership', async () => {
    const { root, admission } = gate();
    const owner = admission.admit('agent', 'agent-fixture');
    const restarted = createMaintenanceAdmission(root);
    const held = restarted.begin({ reason: 'Service work', owner: 'Operator session' });
    expect(admission.tryAdmit('runner', 'new')).toBeNull();
    expect(createMaintenanceAdmission(root).status()).toMatchObject({ state: 'draining', hold: held.hold });
    await owner.finish();
    expect(restarted.status().state).toBe('ready');
  });

  it('rejects stale resume without clearing the current owner hold', () => {
    const { admission } = gate();
    const first = admission.begin({ reason: 'First', owner: 'Operator' }).hold;
    admission.resume({ id: first.id, revision: first.revision });
    const second = admission.begin({ reason: 'Second', owner: 'Operator' }).hold;
    expect(() => admission.resume({ id: first.id, revision: first.revision })).toThrowError(/changed/);
    expect(admission.status().hold).toEqual(second);
    expect(admission.resume({ id: second.id, revision: second.revision }).state).toBe('normal');
  });

  it('does not let a detached callback reuse a settled parent capability', async () => {
    const { admission } = gate();
    const parent = admission.admit('media', 'old');
    await parent.finish();
    admission.begin({ reason: 'Drain', owner: 'Operator' });
    expect(() => parent.run(() => admission.admit('provider', 'late', { continuation: true }))).toThrow();
    expect(admission.status().state).toBe('ready');
  });

  it('retries completion lock contention and keeps readiness closed until the write succeeds', async () => {
    vi.useFakeTimers();
    const { admission } = gate();
    const work = admission.admit('media', 'render');
    admission.begin({ reason: 'Drain', owner: 'Operator' });
    mkdirSync(join(admission.directory, 'transaction'));
    const finishing = work.finish();
    expect(admission.status().state).toBe('unavailable');
    rmSync(join(admission.directory, 'transaction'), { recursive: true });
    expect(admission.status().state).toBe('draining');
    await vi.advanceTimersByTimeAsync(50);
    expect(await finishing).toBe(true);
    expect(admission.status().state).toBe('ready');
  });

  it('keeps corrupt/future journals and failed terminal persistence fail-closed', async () => {
    const { root, admission } = gate();
    const render = admission.admit('media', 'render');
    render.markUnsettled();
    await render.finish();
    admission.begin({ reason: 'Drain', owner: 'Operator' });
    expect(admission.status()).toMatchObject({ state: 'draining', blockers: [{ unsettled: true }] });
    writeFileSync(join(admission.directory, 'state.json'), '{"version":999}');
    const restarted = createMaintenanceAdmission(root);
    expect(restarted.status().state).toBe('unavailable');
    expect(restarted.tryAdmit('agent', 'new')).toBeNull();
    expect(() => restarted.resume({ id: '00000000-0000-4000-8000-000000000000', revision: 1 })).toThrow();
  });
});
