import { afterEach, describe, expect, it, vi } from 'vitest';
import { __testing } from './runtimeUpdateReview.js';
import { runtimeUpdateEvents } from './runtimeUpdateEvents.js';

const { createRuntimeUpdateReviewMonitor } = __testing;

const runtime = (overrides = {}) => ({
  node: { version: 'v26.10.0', inSupportedRange: true, securityBaseline: { minimum: '26.12.1', compliant: false } },
  releases: { latestInLine: { version: 'v26.13.0' }, latestSecurity: { version: 'v26.12.1' }, securityUpdate: true, securityVerified: true },
  pm2: { shipped: '7.1.0', latest: '7.2.0', cli: '7.0.0', cliState: 'available', cliBehind: true, daemonStale: true, daemon: { pm2Version: '7.0.0', nodeVersion: '26.10.0' } },
  startup: { configured: true, current: false },
  ...overrides,
});
const harness = (overrides = {}) => ({ id: 'codex', label: 'Codex CLI', installed: true, probeState: 'available', package: '@openai/codex', version: '1.0.0', latestVersion: '1.1.0', ...overrides });

function fixture({ node = runtime(), harnesses = [harness()], cached = [] } = {}) {
  const deps = {
    readRuntime: vi.fn().mockResolvedValue(node),
    readHarnesses: vi.fn().mockResolvedValue(harnesses),
    notify: vi.fn(),
    load: vi.fn().mockResolvedValue(cached),
    save: vi.fn().mockResolvedValue(undefined),
  };
  return { deps, monitor: createRuntimeUpdateReviewMonitor(deps) };
}

afterEach(() => vi.useRealTimers());

describe('runtime update review monitor', () => {
  it('projects the running versions, security priority, guarded actions, and distinct pm2 update paths', async () => {
    const { monitor } = fixture();
    await monitor.refresh();
    const byId = Object.fromEntries(monitor.items().map((item) => [item.id, item]));
    expect(byId.node).toMatchObject({ severity: 'high', revision: 'security:v26.12.1', drillTo: '/apps/portos-default/update' });
    expect(byId.node.summary).toContain('v26.10.0');
    expect(byId.node.summary).toContain('v26.13.0');
    expect(byId.node.summary).toContain('restart');
    expect(byId['pm2-sync'].summary).toContain('daemon 7.0.0 on Node 26.10.0');
    expect(byId['pm2-upstream'].summary).toContain('sync action installs the bundled version');
    expect(byId['pm2-upstream'].summary).toContain('npm has 7.2.0');
    expect(byId['pm2-startup'].summary).toContain('after boot');
    expect(byId['harness:codex']).toMatchObject({ drillTo: '/ai/harnesses/codex', revision: '1.0.0:1.1.0' });
    expect(byId['harness:codex'].summary).toContain('Installed 1.0.0; latest 1.1.0');
    expect(monitor.items().every((item) => item.required && item.operations.length === 0)).toBe(true);
  });

  it('keeps last known alerts through partial failures and clears only after verified observations', async () => {
    const { monitor, deps } = fixture();
    await monitor.refresh();
    deps.readRuntime.mockResolvedValue(runtime({ releases: null, pm2: { shipped: '7.1.0', latest: null, cli: null, daemon: null } }));
    deps.readHarnesses.mockResolvedValue([harness({ installed: false, probeState: 'unavailable', version: null, latestVersion: null })]);
    await monitor.refresh();
    let byId = Object.fromEntries(monitor.items().map((item) => [item.id, item]));
    expect(byId.node).toMatchObject({ severity: 'high', revision: 'security:v26.12.1', unverified: true });
    expect(byId.node.summary).toContain('last known result');
    expect(byId['pm2-sync'].unverified).toBe(true);
    expect(byId['pm2-upstream'].unverified).toBe(true);
    expect(byId['harness:codex']).toMatchObject({ revision: '1.0.0:1.1.0', unverified: true });

    deps.readRuntime.mockResolvedValue(runtime({
      node: { version: 'v26.13.0', inSupportedRange: true, securityBaseline: { minimum: '26.12.1', compliant: true } },
      releases: { latestInLine: { version: 'v26.13.0' }, securityUpdate: false, securityVerified: true },
      pm2: { shipped: '7.1.0', latest: '7.1.0', cli: '7.1.0', cliBehind: false, daemonStale: false, daemon: { pm2Version: '7.1.0', nodeVersion: '26.13.0' } },
      startup: { configured: true, current: true },
    }));
    deps.readHarnesses.mockResolvedValue([harness({ version: '1.1.0', latestVersion: '1.1.0' })]);
    await monitor.refresh();
    byId = Object.fromEntries(monitor.items().map((item) => [item.id, item]));
    expect(byId).toEqual({});
  });

  it('reports an unknown status on a cold failure and retains the known security floor offline', async () => {
    const { monitor } = fixture({ node: runtime({ releases: null }), harnesses: [harness({ latestVersion: null })] });
    await monitor.refresh();
    const byId = Object.fromEntries(monitor.items().map((item) => [item.id, item]));
    expect(byId.node).toMatchObject({ severity: 'high', revision: 'security:v26.12.1', unverified: true });
    expect(byId.node.summary).toContain('v26.12.1');
    expect(byId['harness:codex']).toMatchObject({ unverified: true });
    expect(byId['harness:codex'].summary).toContain('could not be verified');
  });

  it('keeps pm2 alerts when the terminal CLI or startup configuration cannot be read', async () => {
    const { monitor, deps } = fixture();
    await monitor.refresh();
    deps.readRuntime.mockResolvedValue(runtime({
      pm2: { shipped: '7.1.0', latest: '7.1.0', cli: null, cliState: 'unverified', cliBehind: false, daemonStale: false, daemon: { pm2Version: '7.1.0', nodeVersion: '26.10.0' } },
      startup: { configured: false, current: null },
    }));
    await monitor.refresh();
    const byId = Object.fromEntries(monitor.items().map((item) => [item.id, item]));
    expect(byId['pm2-sync'].unverified).toBe(true);
    expect(byId['pm2-startup'].unverified).toBe(true);
  });

  it('does not treat a vanished harness on PATH as a verified update', async () => {
    const { monitor, deps } = fixture();
    await monitor.refresh();
    deps.readHarnesses.mockResolvedValue([harness({ installed: false, probeState: 'missing', version: null, latestVersion: null })]);
    await monitor.refresh();
    expect(monitor.items().find((item) => item.id === 'harness:codex')).toMatchObject({ revision: '1.0.0:1.1.0', unverified: true });
  });

  it('clears a harness after its explicit removal is rechecked', async () => {
    const { monitor, deps } = fixture();
    await monitor.start();
    await vi.waitFor(() => expect(monitor.items().some((item) => item.id === 'harness:codex')).toBe(true));
    deps.readHarnesses.mockResolvedValue([harness({ installed: false, probeState: 'missing', version: null, latestVersion: null })]);
    runtimeUpdateEvents.emit('changed', { removedHarness: 'codex' });
    await vi.waitFor(() => expect(monitor.items().some((item) => item.id === 'harness:codex')).toBe(false));
    monitor.stop();
  });

  it('records a confirmed removal arriving while the previous cache is loading', async () => {
    const first = fixture();
    await first.monitor.refresh();
    const cached = first.deps.save.mock.calls.at(-1)[0];
    const second = fixture({ harnesses: [harness({ installed: false, probeState: 'missing', version: null, latestVersion: null })] });
    let finishLoad;
    second.deps.load.mockImplementation(() => new Promise((resolve) => { finishLoad = resolve; }));
    const starting = second.monitor.start();
    runtimeUpdateEvents.emit('changed', { removedHarness: 'codex' });
    finishLoad(cached);
    await starting;
    await vi.waitFor(() => expect(second.deps.save).toHaveBeenCalled());
    expect(second.monitor.items().some((item) => item.id === 'harness:codex')).toBe(false);
    second.monitor.stop();
  });

  it('changes a security revision only for newer evidence, even when other release metadata is incomplete', async () => {
    const { monitor, deps } = fixture({ node: runtime({ releases: null }) });
    await monitor.refresh();
    expect(monitor.items().find((item) => item.id === 'node').revision).toBe('security:v26.12.1');
    deps.readRuntime.mockResolvedValue(runtime());
    await monitor.refresh();
    expect(monitor.items().find((item) => item.id === 'node').revision).toBe('security:v26.12.1');
    deps.readRuntime.mockResolvedValue(runtime({ releases: { latestInLine: { version: 'v26.14.0' }, latestSecurity: { version: 'v26.14.0' }, securityUpdate: true, securityVerified: false } }));
    await monitor.refresh();
    expect(monitor.items().find((item) => item.id === 'node')).toMatchObject({ revision: 'security:v26.14.0', unverified: true });
  });

  it('rechecks on the schedule and after a runtime change', async () => {
    vi.useFakeTimers();
    const { monitor, deps } = fixture();
    await monitor.start();
    await vi.waitFor(() => expect(deps.readRuntime).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
    expect(deps.readRuntime).toHaveBeenCalledTimes(2);
    runtimeUpdateEvents.emit('changed');
    await vi.waitFor(() => expect(deps.readRuntime).toHaveBeenCalledTimes(3));
    monitor.stop();
  });

  it('rechecks after a change arriving during an in-flight observation', async () => {
    const { monitor, deps } = fixture();
    let finishFirst;
    deps.readRuntime.mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve; }));
    await monitor.start();
    await vi.waitFor(() => expect(finishFirst).toBeTypeOf('function'));
    runtimeUpdateEvents.emit('changed');
    expect(deps.readRuntime).toHaveBeenCalledTimes(1);
    finishFirst(runtime());
    await vi.waitFor(() => expect(deps.readRuntime).toHaveBeenCalledTimes(2));
    monitor.stop();
  });

  it('restores the previous observations as unverified after restart and preserves them when checks fail', async () => {
    const first = fixture();
    await first.monitor.refresh();
    const cached = first.deps.save.mock.calls.at(-1)[0];
    const second = fixture({ cached });
    second.deps.readRuntime.mockRejectedValue(new Error('offline'));
    second.deps.readHarnesses.mockRejectedValue(new Error('offline'));
    await second.monitor.start();
    await vi.waitFor(() => expect(second.deps.save).toHaveBeenCalled());
    const previous = second.monitor.items().find((item) => item.id === 'node');
    expect(previous).toMatchObject({ severity: 'high', revision: 'security:v26.12.1', unverified: true });
    second.monitor.stop();
  });
});
