import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  enabled: true,
  setup: { installed: true, appId: 'example-world', runtimeStatus: 'not_started' },
  cosEnabled: true,
  start: vi.fn(),
  ready: vi.fn(),
  presence: vi.fn(),
  design: vi.fn(),
  assertInstalled: vi.fn(),
}));
vi.mock('./instanceFeatures.js', () => ({
  isInstanceFeatureEnabled: async () => mock.enabled,
  assertConfiguredEidoverseInstalled: mock.assertInstalled,
}));
vi.mock('./apps.js', () => ({
  getAppById: async () => ({ id: 'example-world', repoPath: '/example/worlds', pm2Home: '/example/pm2',
    pm2ProcessNames: ['eidoverse-worlds'], startCommands: ['bun --env-file=.env.portos server/server.ts'] }),
  notifyAppsChanged: vi.fn(),
}));
vi.mock('./eidoverse.js', () => ({ EIDOVERSE_PROCESS_NAME: 'eidoverse-worlds', EIDOVERSE_PORT: 8940, EIDOVERSE_MAX_MEMORY_RESTART: '2G' }));
vi.mock('./pm2.js', () => ({ startWithCommand: mock.start }));
vi.mock('./eidoverseHost.js', () => ({ ensureEidoverseHost: mock.ready }));
vi.mock('./eidoverseWorld.js', () => ({
  ensureEidoverseWorldConfig: async () => ({ cos: { enabled: mock.cosEnabled } }),
  ensureEidoverseWorldPresence: mock.presence,
  reconcilePendingEidoverseWorld: mock.design,
}));
import { reconcileEidoverseRuntime } from './eidoverseRuntime.js';

beforeEach(() => {
  vi.clearAllMocks();
  mock.enabled = true;
  mock.cosEnabled = true;
  mock.setup = { installed: true, appId: 'example-world', runtimeStatus: 'not_started' };
  mock.assertInstalled.mockReset().mockImplementation(async () => mock.setup);
  mock.start.mockReset().mockResolvedValue({ success: true });
  mock.ready.mockReset().mockResolvedValue({ running: true });
});

describe('installed Eidoverse startup workflow', () => {
  it('starts once, waits for readiness, then reconnects and reconciles the world', async () => {
    let release;
    mock.ready.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const first = reconcileEidoverseRuntime();
    const second = reconcileEidoverseRuntime();
    expect(second).toBe(first);
    await vi.waitFor(() => expect(mock.ready).toHaveBeenCalledOnce());
    expect(mock.start).toHaveBeenCalledWith('eidoverse-worlds', '/example/worlds',
      'bun --env-file=.env.portos server/server.ts', { pm2Home: '/example/pm2', port: 8940, maxMemoryRestart: '2G' });
    expect(mock.presence).not.toHaveBeenCalled();
    release();
    await expect(first).resolves.toMatchObject({ running: true, started: true });
    expect(mock.presence).toHaveBeenCalledOnce();
    expect(mock.design).toHaveBeenCalledOnce();
    expect(mock.presence.mock.invocationCallOrder[0]).toBeLessThan(mock.design.mock.invocationCallOrder[0]);
  });

  it('does nothing while the optional feature is disabled', async () => {
    mock.enabled = false;
    await expect(reconcileEidoverseRuntime()).resolves.toMatchObject({ reason: 'feature-disabled' });
    expect(mock.assertInstalled).not.toHaveBeenCalled();
    expect(mock.start).not.toHaveBeenCalled();
    expect(mock.ready).not.toHaveBeenCalled();
  });

  it('does not install an absent runtime or launch one with unknown status', async () => {
    mock.assertInstalled.mockRejectedValueOnce(new Error('Install required'));
    await expect(reconcileEidoverseRuntime()).rejects.toThrow('Install required');
    mock.setup.runtimeStatus = 'unknown';
    await expect(reconcileEidoverseRuntime()).rejects.toMatchObject({ code: 'EIDOVERSE_RUNTIME_UNKNOWN' });
    expect(mock.start).not.toHaveBeenCalled();
  });

  it('reuses an online runtime and respects disabled CoS presence', async () => {
    mock.setup.runtimeStatus = 'online';
    mock.cosEnabled = false;
    await expect(reconcileEidoverseRuntime()).resolves.toMatchObject({ running: true, started: false, presenceEnabled: false });
    expect(mock.start).not.toHaveBeenCalled();
    expect(mock.presence).not.toHaveBeenCalled();
    expect(mock.design).toHaveBeenCalledOnce();
  });

  it('stops at failed launch/readiness and permits a later explicit retry', async () => {
    mock.start.mockResolvedValueOnce({ success: false });
    await expect(reconcileEidoverseRuntime()).rejects.toMatchObject({ code: 'EIDOVERSE_START_FAILED' });
    expect(mock.ready).not.toHaveBeenCalled();
    mock.ready.mockRejectedValueOnce(new Error('Readiness timed out'));
    await expect(reconcileEidoverseRuntime()).rejects.toThrow('Readiness timed out');
    expect(mock.presence).not.toHaveBeenCalled();
    await expect(reconcileEidoverseRuntime()).resolves.toMatchObject({ running: true });
  });

  it('does not start after the feature is disabled during the install probe', async () => {
    mock.assertInstalled.mockImplementation(async () => { mock.enabled = false; return mock.setup; });
    await expect(reconcileEidoverseRuntime()).resolves.toMatchObject({ reason: 'feature-disabled' });
    expect(mock.start).not.toHaveBeenCalled();
    expect(mock.presence).not.toHaveBeenCalled();
  });
});
