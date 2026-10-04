import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMaintenanceAdmission } from './maintenanceAdmission.js';

const roots = [];
const gate = () => {
  const root = mkdtempSync(join(tmpdir(), 'workflow-admission-'));
  roots.push(root);
  return { root, admission: createMaintenanceAdmission(root) };
};
afterEach(() => { vi.useRealTimers(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('durable graceful maintenance', () => {
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
