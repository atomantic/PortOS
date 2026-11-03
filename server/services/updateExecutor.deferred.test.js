import { afterAll, describe, expect, it, vi } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';
import { installUpdateTestSupervisor } from '../../scripts/lib/updateTestSupervisor.js';
import { continueManualUpdateRecovery, offerManualUpdateRecovery } from '../../scripts/lib/manualUpdateRecovery.mjs';

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
  it('continues a legacy browser confirmation through the real detached update with its prior acknowledgments', async () => {
    installUpdateTestSupervisor(PATHS.root);
    await writeFile(join(PATHS.root, 'package.json'), JSON.stringify({ type: 'module', version: '0.0.0' }));
    const git = args => execFileSync('git', args, { cwd: PATHS.root, stdio: 'pipe' });
    git(['init', '--quiet']); git(['add', 'package.json']);
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'Fixture']);
    mkdirSync(join(PATHS.root, 'client', 'dist'), { recursive: true });
    await writeFile(join(PATHS.root, 'client', 'dist', 'index.html'), 'Old UI');
    const source = await readFile(new URL('../../update.sh', import.meta.url), 'utf8');
    const header = source.slice(0, source.indexOf('mkdir -p "$ROOT_DIR/data"'));
    await writeFile(join(PATHS.root, 'update.sh'), `${header}\nprintf '%s|%s' "$PORTOS_FORCE_CLEAN_WORKSPACES" "$PORTOS_UPDATE_IMAGE_BACKUP_ACKNOWLEDGED" > browser-consent-applied\nnode scripts/deferred-update.mjs --terminal "$PORTOS_DEFERRED_UPDATE_ID" "$$" 0\n`);
    const admission = createMaintenanceAdmission(PATHS.data);
    const request = async () => {
      const { id } = admission.deferredUpdate.request();
      await offerManualUpdateRecovery({ id, root: PATHS.root, directory: admission.directory,
        env: { PORTOS_FORCE_CLEAN_WORKSPACES: 'client', PORTOS_UPDATE_IMAGE_BACKUP_ACKNOWLEDGED: '1' } });
      admission.deferredUpdate.finish(id, false, { errorCode: 'UPDATE_INTERRUPTION_REQUIRED' });
      return id;
    };
    const run = (tag, emit, options) => launchUpdate(tag, emit, { ...options, admission, monitorIntervalMs: 50 });
    const old = await request();
    let newer;
    expect(admission.deferredUpdate.get().result.id).toBe(old);
    await expect(continueManualUpdateRecovery({ id: old, root: PATHS.root, directory: admission.directory,
      launch: (...args) => { newer = admission.deferredUpdate.request(); return run(...args); } })).rejects.toThrow('previous update');
    expect(admission.deferredUpdate.operation().id).toBe(newer.id);
    expect(existsSync(join(PATHS.root, 'browser-consent-applied'))).toBe(false);
    admission.deferredUpdate.finish(newer.id, false);
    const id = await request();
    const continued = await continueManualUpdateRecovery({ id, root: PATHS.root, directory: admission.directory, launch: run });
    await expect(continued.completion).resolves.toMatchObject({ success: true });
    expect(await readFile(join(PATHS.root, 'browser-consent-applied'), 'utf8')).toBe('client|1');
    expect(admission.deferredUpdate.operation()).toBeNull();
  });
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
