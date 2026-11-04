import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from '../lib/childProcess.js';
import { createMaintenanceAdmission } from '../lib/maintenanceAdmission.js';
import { processAbsent } from '../lib/maintenanceDeferredUpdate.js';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe.skipIf(!['darwin', 'linux'].includes(process.platform))('harness owner crash recovery', () => {
  it.each([true, false])('recovers a dead owner with pause-before-entry=%s', async beforeEntry => {
    const root = mkdtempSync(join(tmpdir(), 'harness-owner-crash-'));
    roots.push(root);
    const script = fileURLToPath(new URL('./__fixtures__/harnessOwner.test.fixture.mjs', import.meta.url));
    const ownerProcess = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env, PORTOS_TEST_HARNESS_ROOT: root, PORTOS_TEST_HARNESS_PAUSE: beforeEntry ? '1' : '0' } });
    const messages = [];
    let output = '';
    ownerProcess.on('message', message => messages.push(message));
    ownerProcess.stdout.on('data', chunk => { output += chunk.toString(); });
    ownerProcess.stderr.on('data', chunk => { output += chunk.toString(); });
    const closed = new Promise(resolve => ownerProcess.once('close', resolve));
    let wrapperPid;
    let groupGone = false;
    try {
      await vi.waitFor(() => expect(messages.some(message => message.type === 'owner-created')).toBe(true), { timeout: 5000 });
      const created = messages.find(message => message.type === 'owner-created');
      wrapperPid = created.wrapperPid;
      const admission = createMaintenanceAdmission(root);
      if (beforeEntry) {
        await vi.waitFor(() => expect(messages).toContainEqual({ type: 'wrapper', message: { type: 'fixture-before-entry' } }), { timeout: 5000 });
      } else {
        await vi.waitFor(() => expect(messages).toContainEqual({ type: 'wrapper', message: { type: 'harness-action-ready', ownerId: created.ownerId } }), { timeout: 5000 });
        ownerProcess.send({ type: 'harness-action-go', ownerId: created.ownerId });
        await vi.waitFor(() => expect(output).toMatch(/FIXTURE_VENDOR \d+/), { timeout: 5000 });
        await vi.waitFor(() => expect(messages).toContainEqual({ type: 'wrapper', message: { type: 'harness-action-draining', ownerId: created.ownerId } }), { timeout: 5000 });
      }
      expect(() => admission.resume({ id: admission.status().hold.id, revision: admission.status().hold.revision })).toThrow(/owns this hold/);
      ownerProcess.kill('SIGKILL');
      await closed;
      if (beforeEntry) {
        expect(admission.harnessActions.reconcile()).toMatchObject({ held: true });
        expect(output).not.toContain('FIXTURE_VENDOR');
      } else {
        expect(admission.harnessActions.reconcile()).toBeNull();
        expect(admission.status().hold).not.toBeNull();
      }
      await vi.waitFor(() => expect(processAbsent(-wrapperPid)).toBe(true), { timeout: 5000 });
      groupGone = true;
      if (!beforeEntry) expect(admission.harnessActions.reconcile()).toMatchObject({ held: true });
      admission.harnessActions.markWakeProgress(created.ownerId, { woken: true });
      expect(admission.status().state).toBe('normal');
    } finally {
      if (ownerProcess.exitCode == null && ownerProcess.signalCode == null) ownerProcess.kill('SIGKILL');
      if (!groupGone && wrapperPid && !processAbsent(-wrapperPid)) {
        try { process.kill(-wrapperPid, 'SIGKILL'); } catch { /* fixture group already exited */ }
      }
    }
  }, 15000);
});
