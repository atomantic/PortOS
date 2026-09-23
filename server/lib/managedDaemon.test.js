import { describe, expect, it, vi } from 'vitest';
import { createDaemonWatcher, createOnDemandDaemon, createPm2ExitTail, reapIdleDaemons, _resetIdleDaemonsForTests } from './managedDaemon.js';

const makeWatcher = (overrides = {}) => {
  let config = overrides.config ?? null;
  const getAppStatus = vi.fn(async () => Object.hasOwn(overrides, 'pm2Status')
    ? overrides.pm2Status
    : { status: 'online', pid: 42, args: ['--port', '9001'] });
  const execPm2 = vi.fn(async () => ({ stdout: 'pm2 output', stderr: '' }));
  const isPortInUse = vi.fn(async () => false);
  const probe = vi.fn(async () => overrides.reachable ?? false);
  const watcher = createDaemonWatcher({
    appName: 'example-daemon',
    defaultPort: 9000,
    endpointFor: (value) => `http://127.0.0.1:${value?.port ?? 9000}/v1`,
    parseConfigFromArgs: (args) => ({ port: Number(args[args.indexOf('--port') + 1]) }),
    probe,
    isPortInUse,
    sleep: vi.fn(async () => {}),
    getConfig: () => config,
    setConfig: (value) => { config = value; },
    getLastExitError: () => null,
    getAppStatus,
    getSavedProcessNames: vi.fn(async () => ['example-daemon']),
    execPm2,
    getPortReleaseTimeoutMs: () => 5_000,
    ...overrides.options,
  });
  return { watcher, getAppStatus, execPm2, isPortInUse, probe, getConfig: () => config };
};

describe('createDaemonWatcher', () => {
  it('re-adopts a live PM2 launch line and builds the shared status fields', async () => {
    const { watcher, execPm2, probe, getConfig } = makeWatcher();

    const status = await watcher.getStatusBase({ installed: true });

    expect(getConfig()).toEqual({ port: 9001 });
    expect(status).toMatchObject({
      installed: true,
      running: true,
      managed: true,
      pid: 42,
      port: 9001,
      endpoint: 'http://127.0.0.1:9001/v1',
      config: { port: 9001 },
      runAtStartup: true,
      recentLogs: ['pm2 output'],
      lastExitError: null,
    });
    expect(probe).toHaveBeenCalledWith('http://127.0.0.1:9001/v1');
    expect(execPm2).toHaveBeenCalledWith(['logs', 'example-daemon', '--nostream', '--lines', '100']);
  });

  it('keeps an unreadable PM2 distinct from a confirmed missing process', async () => {
    const { watcher } = makeWatcher({
      config: { port: 9002 },
      pm2Status: null,
      options: { preserveConfigOnReadFailure: true },
    });

    await expect(watcher.getStatusBase({ installed: true })).resolves.toMatchObject({
      managed: null,
      config: { port: 9002 },
      lastExitError: 'Failed to read PM2 status',
    });
  });

  it('waits until a stopped daemon releases its port', async () => {
    const { watcher, isPortInUse } = makeWatcher();
    isPortInUse.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await watcher.waitForPortRelease(9001);

    expect(isPortInUse).toHaveBeenCalledTimes(2);
    expect(isPortInUse).toHaveBeenCalledWith(9001);
  });
});

describe('createPm2ExitTail', () => {
  it('folds the PM2 log tail into the manager log buffer and the returned status string', async () => {
    const appended = [];
    const execPm2 = vi.fn(async () => ({ stdout: '', stderr: 'line one\nline two\n' }));
    const exitTail = createPm2ExitTail({ appName: 'example-daemon', execPm2, appendLog: (l) => appended.push(l) });

    const result = await exitTail('errored');

    expect(execPm2).toHaveBeenCalledWith(['logs', 'example-daemon', '--nostream', '--lines', '15']);
    expect(appended).toEqual(['line one', 'line two']);
    expect(result).toBe('PM2 status: errored — line one | line two');
  });

  it('reports a bare status word when PM2 has nothing to say', async () => {
    const exitTail = createPm2ExitTail({
      appName: 'example-daemon',
      execPm2: vi.fn(async () => ({ stdout: '', stderr: '' })),
      appendLog: () => {},
    });

    expect(await exitTail('stopped')).toBe('PM2 status: stopped');
  });
});

describe('createOnDemandDaemon', () => {
  const makeOnDemand = (overrides = {}) => {
    let config = overrides.config ?? null;
    let section = overrides.section ?? {};
    let status = overrides.status ?? { status: 'not_found' };
    const probe = vi.fn(async () => overrides.reachable ?? false);
    const start = overrides.start ?? vi.fn(async () => ({ online: true, endpoint: 'http://127.0.0.1:9100/v1', config: { port: 9100 } }));
    const stop = vi.fn(async () => {});
    const onDemand = createOnDemandDaemon({
      appName: 'example-on-demand',
      label: 'Example',
      emoji: '🧪',
      readSection: async () => section,
      endpointFor: (c) => `http://127.0.0.1:${c?.port ?? 9000}/v1`,
      probe,
      start,
      stop,
      getStatusStrict: async () => status,
      exitTail: overrides.exitTail ?? (async (s) => `PM2 status: ${s}`),
      resolveLaunch: overrides.resolveLaunch ?? ((current, saved) => ({
        port: current?.port ?? saved.port ?? 9000,
        model: current?.model ?? saved.model ?? null,
      })),
      getConfig: () => config,
      sleep: vi.fn(async () => {}),
      getRelaunchReadyTimeoutMs: () => overrides.relaunchReadyTimeoutMs ?? 50,
      getRelaunchPollMs: () => 0,
    });
    return {
      onDemand,
      probe,
      start,
      stop,
      setStatus: (v) => { status = v; },
      setSection: (v) => { section = v; },
      setConfig: (v) => { config = v; },
    };
  };

  it('resolves the numeric port-match arm, fixing the string/number mismatch that made it permanently dead', () => {
    const { onDemand } = makeOnDemand();
    // `localEndpointPort` returns a STRING; comparing it with `===` against a
    // numeric `managedPort` is what made `isMtplxProvider`'s port arm dead
    // since it was added (#8105) — `servesPort` compares numerically instead.
    expect(onDemand.servesPort({ endpoint: 'http://127.0.0.1:8010/v1' }, 8010)).toBe(true);
    expect(onDemand.servesPort({ endpoint: 'http://127.0.0.1:8011/v1' }, 8010)).toBe(false);
    expect(onDemand.servesPort({ endpoint: 'http://127.0.0.1:8010/v1' }, null)).toBe(false);
  });

  it('resolves the launch line via resolveLaunch(current, saved) before probing, live config wins', async () => {
    const { onDemand, probe, setConfig, setSection } = makeOnDemand({ reachable: true });
    setConfig({ port: 9100, model: 'live' });
    setSection({ launch: { port: 9200, model: 'saved' } });

    const result = await onDemand.ensureRunning();

    expect(result).toEqual({ ready: true, reason: null });
    expect(probe).toHaveBeenCalledWith('http://127.0.0.1:9100/v1');
  });

  it('falls back to the saved launch when nothing is live', async () => {
    const { onDemand, probe, setSection } = makeOnDemand({ reachable: true });
    setSection({ launch: { port: 9200, model: 'saved' } });

    await onDemand.ensureRunning();

    expect(probe).toHaveBeenCalledWith('http://127.0.0.1:9200/v1');
  });

  it('waitForReady reports the shared exit-tail diagnosis when the process dies before answering', async () => {
    const { onDemand, setStatus } = makeOnDemand({
      start: vi.fn(async () => ({ online: false, endpoint: 'http://127.0.0.1:9000/v1' })),
      exitTail: async (status) => `PM2 status: ${status} — metal buffer allocation failed`,
    });
    setStatus({ status: 'errored' });

    const result = await onDemand.ensureRunning();

    expect(result).toEqual({
      ready: false,
      reason: 'Example exited while loading (PM2 status: errored — metal buffer allocation failed)',
    });
  });

  it('registerIdle honors a legacy `pinned` setting the same as `keepLoaded`', async () => {
    _resetIdleDaemonsForTests();
    const { onDemand, stop } = makeOnDemand({
      section: { idleMinutes: 1, pinned: true }, // legacy key, no `keepLoaded`
      status: { status: 'online' },
    });
    onDemand.registerIdle();

    const stopped = await reapIdleDaemons(Date.now() + 10 * 60_000);

    expect(stopped).not.toContain('example-on-demand');
    expect(stop).not.toHaveBeenCalled();
  });

  it('registerIdle stops the daemon once its configured idle window elapses and it is not pinned', async () => {
    _resetIdleDaemonsForTests();
    const { onDemand, stop } = makeOnDemand({
      section: { idleMinutes: 1, keepLoaded: false },
      status: { status: 'online' },
    });
    onDemand.registerIdle();

    const stopped = await reapIdleDaemons(Date.now() + 10 * 60_000);

    expect(stopped).toContain('example-on-demand');
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('the idle-minutes/keep-loaded test overrides win over the section read', async () => {
    _resetIdleDaemonsForTests();
    const { onDemand, stop } = makeOnDemand({
      // The section says "pinned, no window" — the overrides below must win.
      section: { idleMinutes: 0, keepLoaded: true },
      status: { status: 'online' },
    });
    onDemand.setIdleMinutesOverrideForTests(1);
    onDemand.setKeepLoadedOverrideForTests(false);
    onDemand.registerIdle();

    const stopped = await reapIdleDaemons(Date.now() + 10 * 60_000);

    expect(stopped).toContain('example-on-demand');
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
