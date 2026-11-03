import { EventEmitter } from 'events';
import { describe, it, expect, vi } from 'vitest';
import { DEPLOY_FLAGS as sharedDeployFlags } from '../lib/appDeployFlags.js';

const mockSpawn = vi.hoisted(() => vi.fn());
vi.mock('../lib/childProcess.js', async (importOriginal) => ({
  ...(await importOriginal()),
  spawn: mockSpawn,
}));

import { DEPLOY_FLAGS, deployApp, runDeployFlow } from './appDeployer.js';
import { maintenance } from '../lib/maintenanceAdmission.js';

describe('deployApp environment', () => {
  it('keeps the deploy pending after a live child error until close', async () => {
    const child = new EventEmitter();
    Object.assign(child, { pid: 1234, stdout: new EventEmitter(), stderr: new EventEmitter() });
    mockSpawn.mockReturnValueOnce(child);
    let finished = false;
    const pending = deployApp({ repoPath: '/repo/live-deploy' }, [], () => {}).then(result => { finished = true; return result; });
    child.emit('error', new Error('kill failed'));
    await Promise.resolve();
    expect(finished).toBe(false);
    child.emit('close', 0);
    await expect(pending).resolves.toEqual({ success: false, code: -1 });
  });
  it('does not hand server secrets to deploy.sh', async () => {
    vi.stubEnv('PRIVACY_VAULT_KEY', 'vault');
    vi.stubEnv('PGPASSWORD', 'db');
    vi.stubEnv('PORTOS_DEPLOY_PROBE', 'kept');
    mockSpawn.mockImplementation(() => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      queueMicrotask(() => child.emit('close', 0));
      return child;
    });

    await deployApp({ repoPath: '/repo/example-ios' }, [], () => {});

    const { env } = mockSpawn.mock.calls[0][2];
    expect(env).not.toHaveProperty('PRIVACY_VAULT_KEY');
    expect(env).not.toHaveProperty('PGPASSWORD');
    expect(env.PORTOS_DEPLOY_PROBE).toBe('kept');
    expect(env.FORCE_COLOR).toBe('0');
    vi.unstubAllEnvs();
  });
});

describe('deploy flag contract', () => {
  it('preserves the service export as the shared lib allowlist', () => {
    expect(DEPLOY_FLAGS).toBe(sharedDeployFlags);
    expect(DEPLOY_FLAGS).toEqual(['--ios', '--macos', '--watch', '--all', '--skip-tests']);
  });
});

describe('runDeployFlow', () => {
  const app = { id: 'app-1', name: 'MyApp', repoPath: '/repo', type: 'xcode' };

  it('does not start deployment while an update holds maintenance', async () => {
    const update = maintenance.deferredUpdate.request();
    expect(maintenance.deferredUpdate.acquire(update.id)).toBe(true);
    const runDeploy = vi.fn();
    try {
      await expect(runDeployFlow('app-1', [], { resolveApp: async () => app,
        checkScript: () => true, runDeploy })).rejects.toMatchObject({ code: 'MAINTENANCE_HELD' });
      expect(runDeploy).not.toHaveBeenCalled();
    } finally { maintenance.deferredUpdate.finish(update.id, false); }
  });

  it('returns a not-found outcome when the app is missing (no deploy attempted)', async () => {
    const runDeploy = vi.fn();
    const outcome = await runDeployFlow('missing', [], {
      resolveApp: vi.fn().mockResolvedValue(null),
      checkScript: vi.fn(),
      runDeploy
    });
    expect(outcome).toEqual({ ok: false, error: 'App not found' });
    expect(runDeploy).not.toHaveBeenCalled();
  });

  it('returns a no-script outcome when the app has no deploy.sh', async () => {
    const runDeploy = vi.fn();
    const outcome = await runDeployFlow('app-1', [], {
      resolveApp: vi.fn().mockResolvedValue(app),
      checkScript: vi.fn().mockReturnValue(false),
      runDeploy
    });
    expect(outcome).toEqual({ ok: false, error: 'No deploy.sh found for this app' });
    expect(runDeploy).not.toHaveBeenCalled();
  });

  it('runs the deploy and surfaces success + exit code', async () => {
    const runDeploy = vi.fn().mockResolvedValue({ success: true, code: 0 });
    const onOutput = vi.fn();
    const outcome = await runDeployFlow('app-1', ['--ios'], {
      resolveApp: vi.fn().mockResolvedValue(app),
      checkScript: vi.fn().mockReturnValue(true),
      runDeploy,
      onOutput
    });
    expect(runDeploy).toHaveBeenCalledWith(app, ['--ios'], onOutput);
    expect(outcome).toEqual({ ok: true, success: true, code: 0 });
  });

  it('reports a failed deploy with its non-zero exit code', async () => {
    const outcome = await runDeployFlow('app-1', [], {
      resolveApp: vi.fn().mockResolvedValue(app),
      checkScript: vi.fn().mockReturnValue(true),
      runDeploy: vi.fn().mockResolvedValue({ success: false, code: 2 })
    });
    expect(outcome).toEqual({ ok: true, success: false, code: 2 });
  });

  it('passes a no-op output sink to the deploy runner when onOutput is omitted', async () => {
    const runDeploy = vi.fn().mockResolvedValue({ success: true, code: 0 });
    await runDeployFlow('app-1', [], {
      resolveApp: vi.fn().mockResolvedValue(app),
      checkScript: vi.fn().mockReturnValue(true),
      runDeploy
    });
    const passedSink = runDeploy.mock.calls[0][2];
    expect(typeof passedSink).toBe('function');
    // The sink must be safely callable (the real deployApp invokes it).
    expect(() => passedSink('status', { message: 'x' })).not.toThrow();
  });
});
