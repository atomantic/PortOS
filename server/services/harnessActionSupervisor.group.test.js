import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from '../lib/childProcess.js';
import { createMaintenanceAdmission } from '../lib/maintenanceAdmission.js';
import { processAbsent } from '../lib/maintenanceDeferredUpdate.js';
import { isSupervisorOnly } from './harnessProcessGroup.js';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe.skipIf(!['darwin', 'linux'].includes(process.platform))('harness supervisor process group', () => {
  it('releases a completed group only after the supervisor is the sole member', async () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-supervisor-finished-'));
    roots.push(root);
    const admission = createMaintenanceAdmission(root);
    const owner = admission.harnessActions.reserve({ runtime: 'opencode', action: 'update', exclusive: true });
    const script = fileURLToPath(new URL('./__fixtures__/harnessActionSupervisor.test.fixture.mjs', import.meta.url));
    const child = spawn(process.execPath, [script], { detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env, PORTOS_TEST_HARNESS_ROOT: root, PORTOS_TEST_HARNESS_OWNER: owner.id, PORTOS_TEST_HARNESS_SHORT: '1' } });
    const messages = [];
    child.on('message', message => messages.push(message));
    child.stdout.resume(); child.stderr.resume();
    const closed = new Promise(resolve => child.once('close', resolve));
    let groupGone = false;
    try {
      await vi.waitFor(() => expect(messages).toContainEqual({ type: 'harness-action-ready', ownerId: owner.id }), { timeout: 5000 });
      child.send({ type: 'harness-action-go', ownerId: owner.id });
      await vi.waitFor(() => expect(messages).toContainEqual({ type: 'harness-action-draining', ownerId: owner.id }), { timeout: 5000 });
      await vi.waitFor(async () => expect(await isSupervisorOnly(child.pid)).toBe(true), { timeout: 5000 });
      expect(() => admission.harnessActions.finish(owner.id, child.pid)).toThrow(/not settled/);
      child.send({ type: 'harness-action-finish', ownerId: owner.id });
      expect(await closed).toBe(0);
      await vi.waitFor(() => expect(processAbsent(-child.pid)).toBe(true), { timeout: 5000 });
      groupGone = true;
      expect(admission.harnessActions.finish(owner.id, child.pid)).toMatchObject({ held: true });
    } finally {
      if (!groupGone && child.pid && !processAbsent(-child.pid)) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* fixture group already exited */ }
      }
    }
  }, 15000);

  it('keeps a TERM-resistant fixture in its group and retains admission until it exits', async () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-supervisor-group-'));
    roots.push(root);
    const admission = createMaintenanceAdmission(root);
    const owner = admission.harnessActions.reserve({ runtime: 'opencode', action: 'update', exclusive: true });
    const script = fileURLToPath(new URL('./__fixtures__/harnessActionSupervisor.test.fixture.mjs', import.meta.url));
    const child = spawn(process.execPath, [script], { detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env, PORTOS_TEST_HARNESS_ROOT: root, PORTOS_TEST_HARNESS_OWNER: owner.id } });
    let groupGone = false;
    let output = '';
    const messages = [];
    child.stdout.on('data', chunk => { output += chunk.toString(); });
    child.stderr.on('data', chunk => { output += chunk.toString(); });
    child.on('message', message => messages.push(message));
    const closed = new Promise(resolve => child.once('close', resolve));
    try {
      await vi.waitFor(() => expect(messages).toContainEqual({ type: 'harness-action-ready', ownerId: owner.id }), { timeout: 5000 });
      child.send({ type: 'harness-action-go', ownerId: owner.id });
      await vi.waitFor(() => expect(output).toMatch(/FIXTURE_VENDOR \d+/), { timeout: 5000 });
      const vendorPid = Number(output.match(/FIXTURE_VENDOR (\d+)/)[1]);
      await vi.waitFor(() => expect(messages).toContainEqual({ type: 'harness-action-draining', ownerId: owner.id }), { timeout: 5000 });
      const groupOf = pid => {
        const ps = spawnSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' });
        expect(ps.status).toBe(0);
        return Number(ps.stdout.trim());
      };
      expect(groupOf(child.pid)).toBe(child.pid);
      expect(groupOf(vendorPid)).toBe(child.pid);
      expect(await isSupervisorOnly(child.pid)).toBe(false);
      process.kill(-child.pid, 'SIGTERM');
      expect(processAbsent(-child.pid)).toBe(false);
      expect(() => admission.harnessActions.finish(owner.id, child.pid)).toThrow(/not settled/);
      expect(admission.status().hold.id).toBe(owner.holdId);
      await closed;
      await vi.waitFor(() => expect(processAbsent(-child.pid)).toBe(true), { timeout: 5000 });
      groupGone = true;
      expect(admission.harnessActions.finish(owner.id, child.pid)).toMatchObject({ held: true });
    } finally {
      if (!groupGone && child.pid && !processAbsent(-child.pid)) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* the fixture already exited */ }
      }
    }
  }, 15000);
});
