import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createMaintenanceAdmission } from './maintenanceAdmission.js';
import { createMaintenanceJournal } from './maintenanceJournal.js';

const roots = [];
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'harness-admission-'));
  roots.push(root);
  const gone = new Set();
  const absent = pid => gone.has(pid);
  const gate = () => createMaintenanceAdmission(root, { harnessAbsent: absent, harnessOwnerPresent: pid => !absent(pid), harnessParentPid: () => process.pid });
  return { root, gone, gate, admission: gate() };
};
const update = { runtime: 'opencode', action: 'update', exclusive: true };
const install = { runtime: 'codex', action: 'install' };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('harness action admission', () => {
  it('atomically holds new work and protects the owner from ordinary resume', () => {
    const { admission, gate } = fixture();
    const owned = admission.harnessActions.reserve(update);
    expect(gate().status()).toMatchObject({ hold: { id: owned.holdId, revision: owned.holdRevision } });
    expect(() => gate().admit('agent', 'new')).toThrow(/holding new work/);
    expect(() => gate().harnessActions.reserve(install)).toThrow(/active/);
    expect(() => gate().resume({ id: owned.holdId, revision: owned.holdRevision })).toThrow(/owns this hold/);
    expect(admission.harnessActions.finish(owned.id)).toMatchObject({ held: true, action: 'update' });
    expect(gate().status().state).toBe('normal');
    expect(gate().harnessActions.pendingWake()).toEqual([{ id: owned.id, action: 'update', runtime: 'opencode' }]);
    admission.harnessActions.markWakeProgress(owned.id, { reported: true, woken: true });
  });

  it('does not leave a waiting owner when admitted work or a self-update is present', async () => {
    const { admission } = fixture();
    const agent = admission.admit('agent', 'running');
    expect(() => admission.harnessActions.reserve(update)).toThrow(/active/);
    expect(admission.harnessActions.operation()).toBeNull();
    await agent.finish();
    const selfUpdate = admission.deferredUpdate.request();
    expect(() => admission.harnessActions.reserve(update)).toThrow(/active/);
    expect(() => admission.harnessActions.reserve(install)).toThrow(/active/);
    admission.deferredUpdate.finish(selfUpdate.id, false);
  });

  it('serializes legacy install actions across processes without holding unrelated work', async () => {
    const { admission, gate, root } = fixture();
    const owned = admission.harnessActions.reserve(install);
    const agent = gate().admit('agent', 'unrelated');
    expect(() => gate().harnessActions.reserve(update)).toThrow(/active/);
    expect(() => gate().harnessActions.reserve(install)).toThrow(/active/);
    // The dependency-free reader used by the self-update supervisor accepts it.
    expect(createMaintenanceJournal(root).read().operations).toContainEqual(expect.objectContaining({ id: owned.id, kind: 'harness-action' }));
    expect(admission.harnessActions.finish(owned.id)).toMatchObject({ held: false });
    await agent.finish();
  });

  it('does not clear a separately requested maintenance hold when a legacy action finishes', () => {
    const { admission } = fixture();
    const owned = admission.harnessActions.reserve(install);
    const hold = admission.begin({ reason: 'Manual maintenance', owner: 'Operator' }).hold;
    admission.harnessActions.finish(owned.id);
    expect(admission.status().hold).toEqual(hold);
    admission.resume({ id: hold.id, revision: hold.revision });
  });

  it('refuses entry if another operation is recovered and refuses a competing self-update', async () => {
    const { admission, gone } = fixture();
    const owned = admission.harnessActions.reserve(update);
    const recovered = admission.recoverOwned('agent', 'legacy-agent');
    expect(() => admission.harnessActions.enter(owned.id, 555555)).toThrow(/can no longer start/);
    await recovered.finish();
    expect(() => admission.harnessActions.enter(owned.id, 555555)).toThrow(/can no longer start/);
    expect(admission.harnessActions.finish(owned.id)).toMatchObject({ overlap: false });
    expect(admission.harnessActions.pendingWake()).toEqual([{ id: owned.id, action: 'update', runtime: 'opencode' }]);
    admission.harnessActions.markWakeProgress(owned.id, { reported: true, woken: true });
    const next = admission.harnessActions.reserve(update);
    expect(() => admission.deferredUpdate.request()).toThrow(/harness action/);
    admission.harnessActions.enter(next.id, 555555);
    expect(() => admission.deferredUpdate.request()).toThrow(/harness action/);
    gone.add(-555555);
    admission.harnessActions.finish(next.id, 555555);
    admission.harnessActions.markWakeProgress(next.id, { reported: true, woken: true });
  });

  it('refuses an entered but not yet authorized wrapper without creating an overlap alert', async () => {
    const { admission, gone } = fixture();
    const owned = admission.harnessActions.reserve(update);
    admission.harnessActions.enter(owned.id, 555555);
    const recovered = admission.recoverOwned('agent', 'legacy-agent');
    await recovered.finish();
    expect(() => admission.harnessActions.verify(owned.id, 555555)).toThrow(/can no longer start/);
    gone.add(-555555);
    expect(admission.harnessActions.finish(owned.id, 555555)).toMatchObject({ overlap: false });
    expect(admission.harnessActions.pendingWake()).toEqual([{ id: owned.id, action: 'update', runtime: 'opencode' }]);
  });

  it('lets a self-update proceed after the harness wake obligation is settled', () => {
    const { admission } = fixture();
    const next = admission.harnessActions.reserve(update);
    admission.harnessActions.finish(next.id);
    expect(() => admission.deferredUpdate.request()).toThrow(/harness action/);
    admission.harnessActions.markWakeProgress(next.id, { reported: true, woken: true });
    const pending = admission.deferredUpdate.request();
    expect(admission.deferredUpdate.acquire(pending.id)).toBe(true);
    admission.deferredUpdate.finish(pending.id, false);
  });

  it('cannot retire an entered action while its process group still exists', () => {
    const { admission, gone } = fixture();
    const owned = admission.harnessActions.reserve(update);
    admission.harnessActions.enter(owned.id, 555555);
    expect(() => admission.harnessActions.finish(owned.id, 555555)).toThrow(/not settled/);
    expect(admission.status().hold.id).toBe(owned.holdId);
    gone.add(-555555);
    expect(admission.harnessActions.finish(owned.id, 555555)).toMatchObject({ held: true });
  });

  it('recovers a dead owner only after an entered process group disappears', () => {
    const { admission, gate, gone } = fixture();
    const owned = admission.harnessActions.reserve(update);
    admission.harnessActions.enter(owned.id, 555555);
    gone.add(process.pid);
    expect(gate().harnessActions.reconcile()).toBeNull();
    expect(gate().status().hold.id).toBe(owned.holdId);
    gone.add(-555555);
    expect(gate().harnessActions.reconcile()).toMatchObject({ held: true, runtime: 'opencode' });
    expect(gate().status().state).toBe('normal');
  });

  it('recovers a crash before entry and rejects the now-orphaned wrapper', () => {
    const { admission, gate, gone } = fixture();
    const owned = admission.harnessActions.reserve(update);
    gone.add(process.pid);
    expect(gate().harnessActions.reconcile()).toMatchObject({ held: true });
    expect(() => admission.harnessActions.enter(owned.id, 555555)).toThrow(/ownership changed/);
    expect(gate().status().state).toBe('normal');
  });

  it('refuses wrapper entry when its parent identity or liveness cannot be proven', () => {
    const { root, admission } = fixture();
    const owned = admission.harnessActions.reserve(update);
    const wrongParent = createMaintenanceAdmission(root, { harnessParentPid: () => process.pid + 1, harnessOwnerPresent: () => true });
    expect(() => wrongParent.harnessActions.enter(owned.id, 555555)).toThrow(/can no longer start/);
    const unknownOwner = createMaintenanceAdmission(root, { harnessParentPid: () => process.pid, harnessOwnerPresent: () => false });
    expect(() => unknownOwner.harnessActions.enter(owned.id, 555555)).toThrow(/can no longer start/);
    expect(admission.status().hold.id).toBe(owned.holdId);
    admission.harnessActions.finish(owned.id);
    admission.harnessActions.markWakeProgress(owned.id, { reported: true, woken: true });
  });
});
