// test-memo: git-fixture — git only runs in temporary repositories created for this suite.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';
import { installUpdateTestSupervisor } from '../../scripts/lib/updateTestSupervisor.js';
import { installAdmittedUpdateFixture } from '../../scripts/lib/updateContractHarness.js';
import { continueManualUpdateRecovery, offerManualUpdateRecovery } from '../../scripts/lib/manualUpdateRecovery.mjs';
import { requestManualUpdate } from '../../scripts/manual-update-recovery.mjs';

vi.mock('./updateChecker.js', () => ({ recordUpdateResult: vi.fn(async () => {}), getCurrentVersion: vi.fn(async () => '0.0.0') }));

describe.skipIf(process.platform === 'win32')('service launch through the real detached supervisor', () => {
  let root, admission, launchUpdate, completions;
  beforeEach(async () => {
    const fixtureRoot = createTempDataRoot('update-service-');
    root = fixtureRoot;
    completions = [];
    vi.resetModules();
    vi.doMock('../lib/paths.js', async original => makePathsProxy(await original(), {
      dataRoot: join(fixtureRoot, 'data'),
      extraOverrides: { root: fixtureRoot, installRoot: fixtureRoot },
    }));
    const { createMaintenanceAdmission } = await import('../lib/maintenanceAdmission.js');
    const { launchUpdate: launch } = await import('./updateExecutor.js');
    const fixtureAdmission = createMaintenanceAdmission(join(fixtureRoot, 'data'));
    const fixtureCompletions = completions;
    admission = fixtureAdmission;
    launchUpdate = async (tag, emit, options) => {
      const update = await launch(tag, emit, { admission: fixtureAdmission, monitorIntervalMs: 50, ...options });
      if (update.started) fixtureCompletions.push(update.completion);
      return update;
    };
    installUpdateTestSupervisor(root);
  });

  afterEach(async () => {
    const fixtureRoot = root;
    try {
      await Promise.all(completions);
      // The journal result can arrive before the detached launcher writes its exit file.
      const control = join(fixtureRoot, 'data', 'update-detached');
      const attempts = await readdir(control).catch(error => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
      const launched = attempts.map(attempt => join(control, attempt)).filter(directory => existsSync(join(directory, 'pid')));
      await vi.waitFor(async () => {
        for (const directory of launched) expect((await stat(join(directory, 'exit'))).size).toBeGreaterThan(0);
      }, { timeout: 10000 });
    } finally {
      vi.doUnmock('../lib/paths.js');
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('lets the existing UI Command Runner request a detached manual update without granting interruption consent', async () => {
    await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module', version: '0.0.0' }));
    installAdmittedUpdateFixture(root, "writeFileSync('request-consent', process.env.PORTOS_UPDATE_INTERRUPT || '');");
    const launch = await requestManualUpdate({ args: ['--request'], root,
      launch: launchUpdate, emit: vi.fn() });
    const outcome = await launch.completion;
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ success: true });
    expect(await readFile(join(root, 'request-consent'), 'utf8')).toBe('');
  });
  it('continues a legacy browser confirmation through the real detached update with its prior acknowledgments', async () => {
    await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module', version: '0.0.0' }));
    const git = args => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
    git(['init', '--quiet']); git(['add', 'package.json']);
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'Fixture']);
    mkdirSync(join(root, 'client', 'dist'), { recursive: true });
    await writeFile(join(root, 'client', 'dist', 'index.html'), 'Old UI');
    installAdmittedUpdateFixture(root, "writeFileSync('browser-consent-applied', [process.env.PORTOS_FORCE_CLEAN_WORKSPACES, process.env.PORTOS_UPDATE_IMAGE_BACKUP_ACKNOWLEDGED].join('|'));");
    const request = async () => {
      const { id } = admission.deferredUpdate.request();
      await offerManualUpdateRecovery({ id, root, directory: admission.directory,
        env: { PORTOS_FORCE_CLEAN_WORKSPACES: 'client', PORTOS_UPDATE_IMAGE_BACKUP_ACKNOWLEDGED: '1' } });
      admission.deferredUpdate.finish(id, false, { errorCode: 'UPDATE_INTERRUPTION_REQUIRED' });
      return id;
    };
    const old = await request();
    let newer;
    expect(admission.deferredUpdate.get().result.id).toBe(old);
    await expect(continueManualUpdateRecovery({ id: old, root, directory: admission.directory,
      launch: (...args) => { newer = admission.deferredUpdate.request(); return launchUpdate(...args); } })).rejects.toThrow('previous update');
    expect(admission.deferredUpdate.operation().id).toBe(newer.id);
    expect(existsSync(join(root, 'browser-consent-applied'))).toBe(false);
    admission.deferredUpdate.finish(newer.id, false);
    const id = await request();
    const continued = await continueManualUpdateRecovery({ id, root, directory: admission.directory, launch: launchUpdate });
    const outcome = await continued.completion;
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ success: true });
    expect(await readFile(join(root, 'browser-consent-applied'), 'utf8')).toBe('client|1');
    expect(admission.deferredUpdate.operation()).toBeNull();
  });
  it('keeps a late manual-consent refusal typed through detached completion and allows explicit continuation', async () => {
    installAdmittedUpdateFixture(root, "writeFileSync('consent-applied', '');");
    const render = admission.admit('render:example', 'project-example');
    try {
      await writeFile(join(root, 'observed-running-work'), 'render');
      const initial = await launchUpdate('v0.0.0', vi.fn());
      expect(initial.started).toBe(true);
      await expect(initial.completion).resolves.toMatchObject({ success: false, errorCode: 'UPDATE_INTERRUPTION_REQUIRED' });
      expect(existsSync(join(root, 'consent-applied'))).toBe(false);
      expect(Object.keys(admission.deferredUpdate.get().result)).toHaveLength(4);
      const continued = await launchUpdate('v0.0.0', vi.fn(), { acknowledgeInterruption: true });
      expect(continued.started, JSON.stringify(continued.result)).toBe(true);
      const outcome = await continued.completion;
      expect(outcome, JSON.stringify(outcome)).toMatchObject({ success: true });
      expect(existsSync(join(root, 'consent-applied'))).toBe(true);
    } finally { await render.finish(); }
  });
  it('replaces a prior waiting owner, refuses duplicate reuse, and waits for a racing render to save', async () => {
    installAdmittedUpdateFixture(root, "writeFileSync('applied', '');");
    const render = admission.admit('render:example', 'project-example');
    try {
      const previous = admission.deferredUpdate.request();
      const launch = await launchUpdate('v0.0.0', vi.fn(), { automatic: true });
      expect(launch.started).toBe(true);
      await vi.waitFor(() => expect(admission.deferredUpdate.operation()?.phase).toBe('waiting'), { timeout: 10000 });
      expect(admission.deferredUpdate.operation().id).not.toBe(previous.id);
      expect(() => admission.deferredUpdate.acquire(previous.id)).toThrow(/ownership changed/);
      expect(() => admission.deferredUpdate.finish(previous.id, false)).toThrow(/ownership changed/);
      const duplicate = await launchUpdate('v0.0.0', vi.fn(), { automatic: true });
      expect(duplicate.started).toBe(false);
      expect(existsSync(join(root, 'applied'))).toBe(false);
      await render.finish();
      expect(await launch.completion).toMatchObject({ success: true });
      expect(existsSync(join(root, 'applied'))).toBe(true);
      expect(admission.held()).toBe(false);
    } finally { await render.finish(); }
  });

  it('replaces an observed automatic waiter without broadcasting its interruption as the manual update failure', async () => {
    installAdmittedUpdateFixture(root, "writeFileSync('manual-applied', '');");
    const render = admission.admit('render:example', 'project-example');
    const report = vi.fn();
    try {
      const automatic = await launchUpdate('v0.0.0', report, { automatic: true });
      expect(automatic.started, JSON.stringify(automatic.result)).toBe(true);
      await vi.waitFor(() => expect(admission.deferredUpdate.operation()?.phase).toBe('waiting'), { timeout: 10000 });
      const manual = await launchUpdate('v0.0.0', vi.fn(), { acknowledgeInterruption: true });
      expect(manual.started).toBe(true);
      const outcome = await automatic.completion;
      expect(outcome, JSON.stringify({ outcome, steps: report.mock.calls })).toMatchObject({ success: false, superseded: true });
      await expect(manual.completion).resolves.toMatchObject({ success: true });
      expect(report.mock.calls.some(([, status]) => status === 'error')).toBe(false);
      expect(existsSync(join(root, 'manual-applied'))).toBe(true);
    } finally { await render.finish(); }
  });
});
