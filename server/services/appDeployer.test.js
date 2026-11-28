import { EventEmitter } from 'events';
import { describe, it, expect, vi, onTestFinished } from 'vitest';
import { DEPLOY_FLAGS as sharedDeployFlags } from '../lib/appDeployFlags.js';

const mockSpawn = vi.hoisted(() => vi.fn());
vi.mock('../lib/childProcess.js', async (importOriginal) => ({
  ...(await importOriginal()),
  spawn: mockSpawn,
}));

import { DEPLOY_FLAGS, cancelDeploy, deployApp, isDeploying, runDeployFlow } from './appDeployer.js';
import { IS_WIN32, MAX_OUTPUT_BYTES } from '../lib/bufferedSpawn.js';
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
    await expect(pending).resolves.toEqual({ success: false, code: -1, cancelled: false, timedOut: false, error: 'kill failed' });
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

describe.skipIf(IS_WIN32)('deployApp teardown', () => {
  it.each([
    { action: 'times out', reason: 'Deploy timed out', advance: 600_000, cancelled: false, timedOut: true },
    { action: 'is cancelled', reason: 'Deploy cancelled', advance: 0, cancelled: true, timedOut: false },
  ])('reports and releases a deploy when it $action even with stalled pipes', async ({ reason, advance, cancelled, timedOut }) => {
    vi.useFakeTimers();
    const groupSignal = vi.spyOn(process, 'kill').mockReturnValue(true);
    onTestFinished(() => {
      groupSignal.mockRestore();
      vi.useRealTimers();
    });

    const app = { id: 'example-app', name: 'Example App', repoPath: '/repo/example-app' };
    const child = new EventEmitter();
    Object.assign(child, { pid: 1234, stdout: new EventEmitter(), stderr: new EventEmitter() });
    mockSpawn.mockReturnValueOnce(child);
    const emit = vi.fn();
    const pending = runDeployFlow(app.id, ['--ios'], {
      resolveApp: () => app, checkScript: () => true, onOutput: emit,
    });
    await Promise.resolve();
    expect(mockSpawn).toHaveBeenLastCalledWith(expect.any(String), ['deploy.sh', '--ios'],
      expect.objectContaining({ detached: true }));
    child.stdout.emit('data', `discard${'a'.repeat(MAX_OUTPUT_BYTES)}`);
    expect(isDeploying(app.repoPath)).toBe(true);
    expect(cancelDeploy('other-app')).toBe(false);
    if (advance) await vi.advanceTimersByTimeAsync(advance);
    else {
      expect(cancelDeploy(app.id)).toBe(true);
      expect(cancelDeploy(app.id)).toBe(false);
    }
    expect(groupSignal).toHaveBeenCalledWith(-child.pid, 'SIGTERM');
    expect(isDeploying(app.repoPath)).toBe(true);

    await vi.advanceTimersByTimeAsync(10_000);
    await expect(pending).resolves.toEqual({ ok: true, success: false, code: -1, cancelled, timedOut, error: reason });
    expect(groupSignal).toHaveBeenCalledWith(-child.pid, 'SIGKILL');
    expect(emit).toHaveBeenCalledWith('output', { stream: 'stdout', text: 'a'.repeat(MAX_OUTPUT_BYTES) });
    expect(emit).toHaveBeenCalledWith('status', { phase: 'complete', success: false, code: -1, message: reason });
    expect(isDeploying(app.repoPath)).toBe(false);
    expect(cancelDeploy(app.id)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);

    const nextChild = new EventEmitter();
    mockSpawn.mockReturnValueOnce(nextChild);
    const retry = deployApp(app, [], emit);
    child.emit('close', null);
    expect(isDeploying(app.repoPath)).toBe(true);
    nextChild.emit('close', 0);
    await expect(retry).resolves.toEqual({ success: true, code: 0, cancelled: false, timedOut: false });
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
