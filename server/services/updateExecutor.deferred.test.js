import { afterAll, describe, expect, it, vi } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';
import { installUpdateTestSupervisor } from '../../scripts/lib/updateTestSupervisor.js';

vi.mock('../lib/paths.js', async original => makePathsProxy(await original(), {
  dataRoot: () => join(lazyTempDataRoot('update-service-'), 'data'),
  extraOverrides: data => ({ root: dirname(data), installRoot: dirname(data) }),
}));
vi.mock('./updateChecker.js', () => ({ recordUpdateResult: vi.fn(async () => {}), getCurrentVersion: vi.fn(async () => '0.0.0') }));
const { PATHS } = await import('../lib/paths.js');
const { createMaintenanceAdmission } = await import('../lib/maintenanceAdmission.js');
const { launchUpdate } = await import('./updateExecutor.js');
afterAll(cleanupTempDataRoots);

describe.skipIf(process.platform === 'win32')('service launch through the real detached supervisor', () => {
  it('keeps a late manual-consent refusal typed through detached completion and allows explicit continuation', async () => {
    installUpdateTestSupervisor(PATHS.root);
    const source = await readFile(new URL('../../update.sh', import.meta.url), 'utf8');
    const header = source.slice(0, source.indexOf('mkdir -p "$ROOT_DIR/data"'));
    await writeFile(join(PATHS.root, 'update.sh'), `${header}\ntouch consent-applied\nnode scripts/deferred-update.mjs --terminal "$PORTOS_DEFERRED_UPDATE_ID" "$$" 0\n`);
    const admission = createMaintenanceAdmission(PATHS.data);
    const render = admission.admit('render:example', 'project-example');
    try {
      const initial = await launchUpdate('v0.0.0', vi.fn(), { admission, monitorIntervalMs: 50 });
      expect(initial.started).toBe(true);
      await expect(initial.completion).resolves.toMatchObject({ success: false, errorCode: 'UPDATE_INTERRUPTION_REQUIRED' });
      expect(existsSync(join(PATHS.root, 'consent-applied'))).toBe(false);
      expect(Object.keys(admission.deferredUpdate.get().result)).toHaveLength(4);
      const continued = await launchUpdate('v0.0.0', vi.fn(), { admission, acknowledgeInterruption: true, monitorIntervalMs: 50 });
      await expect(continued.completion).resolves.toMatchObject({ success: true });
      expect(existsSync(join(PATHS.root, 'consent-applied'))).toBe(true);
    } finally { await render.finish(); }
  });
  it('replaces a prior waiting owner, refuses duplicate reuse, and waits for a racing render to save', async () => {
    installUpdateTestSupervisor(PATHS.root);
    const source = await readFile(new URL('../../update.sh', import.meta.url), 'utf8');
    const header = source.slice(0, source.indexOf('mkdir -p "$ROOT_DIR/data"'));
    await writeFile(join(PATHS.root, 'update.sh'), `${header}\ntouch applied\nnode scripts/deferred-update.mjs --terminal "$PORTOS_DEFERRED_UPDATE_ID" "$$" 0\n`);
    const admission = createMaintenanceAdmission(PATHS.data);
    const render = admission.admit('render:example', 'project-example');
    const previous = admission.deferredUpdate.request();
    const launch = await launchUpdate('v0.0.0', vi.fn(), { admission, automatic: true });
    expect(launch.started).toBe(true);
    try {
    await vi.waitFor(() => expect(admission.deferredUpdate.operation()?.phase).toBe('waiting'), { timeout: 10000 });
    expect(admission.deferredUpdate.operation().id).not.toBe(previous.id);
    expect(() => admission.deferredUpdate.acquire(previous.id)).toThrow(/ownership changed/);
    expect(() => admission.deferredUpdate.finish(previous.id, false)).toThrow(/ownership changed/);
    const duplicate = await launchUpdate('v0.0.0', vi.fn(), { admission, automatic: true });
    expect(duplicate.started).toBe(false);
    expect(existsSync(join(PATHS.root, 'applied'))).toBe(false);
    await render.finish();
    expect(await launch.completion).toMatchObject({ success: true });
    expect(existsSync(join(PATHS.root, 'applied'))).toBe(true);
    expect(admission.held()).toBe(false);
    } finally {
      await render.finish();
      await launch.completion;
    }
  });

  it('replaces an observed automatic waiter without broadcasting its interruption as the manual update failure', async () => {
    installUpdateTestSupervisor(PATHS.root);
    const source = await readFile(new URL('../../update.sh', import.meta.url), 'utf8');
    const header = source.slice(0, source.indexOf('mkdir -p "$ROOT_DIR/data"'));
    await writeFile(join(PATHS.root, 'update.sh'), `${header}\ntouch manual-applied\nnode scripts/deferred-update.mjs --terminal "$PORTOS_DEFERRED_UPDATE_ID" "$$" 0\n`);
    const admission = createMaintenanceAdmission(PATHS.data);
    const render = admission.admit('render:example', 'project-example');
    const report = vi.fn();
    const automatic = await launchUpdate('v0.0.0', report, { admission, automatic: true, monitorIntervalMs: 50 });
    try {
      await vi.waitFor(() => expect(admission.deferredUpdate.operation()?.phase).toBe('waiting'), { timeout: 10000 });
      const manual = await launchUpdate('v0.0.0', vi.fn(), { admission, acknowledgeInterruption: true, monitorIntervalMs: 50 });
      expect(manual.started).toBe(true);
      const outcome = await automatic.completion;
      expect(outcome, JSON.stringify({ outcome, steps: report.mock.calls })).toMatchObject({ success: false, superseded: true });
      await expect(manual.completion).resolves.toMatchObject({ success: true });
      expect(report.mock.calls.some(([, status]) => status === 'error')).toBe(false);
      expect(existsSync(join(PATHS.root, 'manual-applied'))).toBe(true);
    } finally { await render.finish(); await automatic.completion; }
  });
});
