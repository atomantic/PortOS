import { afterEach, describe, expect, it, vi } from 'vitest';
import { __testing } from './runtimeUpdateReview.js';
import { runtimeUpdateEvents } from './runtimeUpdateEvents.js';
import { __testing as restartTesting } from './browserUpdateRestart.js';

const { createRuntimeUpdateReviewMonitor } = __testing;
const { createBrowserRestartController } = restartTesting;

const runtime = (overrides = {}) => ({
  node: { version: 'v26.10.0', inSupportedRange: true, securityBaseline: { minimum: '26.12.1', compliant: false } },
  releases: { latestInLine: { version: 'v26.13.0' }, latestSecurity: { version: 'v26.12.1' }, securityUpdate: true, securityVerified: true },
  pm2: { shipped: '7.1.0', latest: '7.2.0', cli: '7.0.0', cliState: 'available', cliBehind: true, daemonStale: true, daemon: { pm2Version: '7.0.0', nodeVersion: '26.10.0' } },
  startup: { configured: true, current: false },
  ...overrides,
});
const harness = (overrides = {}) => ({ id: 'codex', label: 'Codex CLI', installed: true, probeState: 'available', package: '@openai/codex', version: '1.0.0', latestVersion: '1.1.0', ...overrides });

function fixture({ node = runtime(), harnesses = [harness()], cached = [], browser } = {}) {
  const deps = {
    readRuntime: vi.fn().mockResolvedValue(node),
    readHarnesses: vi.fn().mockResolvedValue(harnesses),
    notify: vi.fn(),
    load: vi.fn().mockResolvedValue(cached),
    save: vi.fn().mockResolvedValue(undefined),
    ...(browser ? { readBrowser: vi.fn().mockResolvedValue(browser) } : {}),
  };
  return { deps, monitor: createRuntimeUpdateReviewMonitor(deps) };
}

afterEach(() => vi.useRealTimers());

describe('runtime update review monitor', () => {
  it('raises only a confirmed installed Chrome update and clears it after the running version changes', async () => {
    const browser = { state: 'restart-required', runningVersion: '156.0.8078.4', installedVersion: '156.0.8078.74', channel: 'stable' };
    const { monitor, deps } = fixture({ node: status(), harnesses: [], browser });
    await monitor.refresh();
    expect(monitor.items()).toEqual([expect.objectContaining({ id: 'browser-chrome', drillTo: '/browser',
      revision: '156.0.8078.4:156.0.8078.74', summary: expect.stringContaining('Review open work') })]);
    deps.readBrowser.mockResolvedValue({ state: 'unverified' });
    await monitor.refresh();
    expect(monitor.items()).toEqual([]);
    deps.readBrowser.mockResolvedValue({ state: 'current', runningVersion: '156.0.8078.74', installedVersion: '156.0.8078.74',
      publishedVersions: { mac_arm64: '157.0.9000.1' } });
    await monitor.refresh();
    expect(monitor.items()).toEqual([]);
    expect(monitor.browserSnapshot().publishedVersions.mac_arm64).toBe('157.0.9000.1');
  });

  it('discards cached or superseded browser actions until the current identity is verified', async () => {
    const stale = { id: 'browser-chrome', title: 'old', summary: 'old', revision: 'old', drillTo: '/browser' };
    const { monitor, deps } = fixture({ node: status(), harnesses: [], cached: [stale], browser: { state: 'unverified' } });
    await monitor.start();
    await vi.waitFor(() => expect(deps.readBrowser).toHaveBeenCalled());
    expect(monitor.items()).toEqual([]);
    deps.readBrowser.mockResolvedValue({ state: 'restart-required', runningVersion: '1.0.0.1', installedVersion: '1.0.0.2' });
    await monitor.refresh();
    expect(monitor.items()).toHaveLength(1);
    let finish;
    deps.readBrowser.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
      .mockResolvedValue({ state: 'unverified' });
    const pending = monitor.refresh();
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    runtimeUpdateEvents.emit('changed', { browserChanged: true });
    expect(monitor.items()).toEqual([]);
    finish({ state: 'restart-required', runningVersion: '1.0.0.1', installedVersion: '1.0.0.2' });
    await pending;
    expect(monitor.items()).toEqual([]);
    monitor.stop();
  });

  it('invalidates a stale action when the confirmation check finds a changed browser', async () => {
    let observed = { state: 'restart-required', runningVersion: '1.0.0.1', installedVersion: '1.0.0.2', channel: 'stable', proof: 'first' };
    const { monitor, deps } = fixture({ node: status(), harnesses: [], browser: observed });
    deps.readBrowser.mockImplementation(async () => observed);
    const controller = createBrowserRestartController({
      readStatus: async () => observed,
      restart: async ({ beforeRestart }) => { await beforeRestart(); },
      newToken: () => 'review-ticket',
    });
    await monitor.start();
    await vi.waitFor(() => expect(monitor.items().find(item => item.id === 'browser-chrome')).toBeDefined());
    const preflight = await controller.prepare();
    await vi.waitFor(() => expect(monitor.items().find(item => item.id === 'browser-chrome')).toBeDefined());
    observed = { state: 'current', runningVersion: '1.0.0.2', installedVersion: '1.0.0.2', channel: 'stable', proof: 'changed' };
    await expect(controller.confirm(preflight.ticket)).rejects.toMatchObject({ status: 409 });
    await vi.waitFor(() => expect(monitor.items().some(item => item.id === 'browser-chrome')).toBe(false));
    monitor.stop();
  });

  it('raises an actionable downgrade warning instead of a restart offer', async () => {
    const { monitor } = fixture({ node: status(), harnesses: [], browser: {
      state: 'downgrade-risk', runningVersion: '156.0.8078.74', installedVersion: '156.0.8078.4',
    } });
    await monitor.refresh();
    expect(monitor.items()).toEqual([expect.objectContaining({ id: 'browser-chrome', severity: 'high',
      nextAction: 'Update installed Chrome', revision: 'downgrade:156.0.8078.74:156.0.8078.4' })]);
  });

  it('reports a verified post-restart downgrade even when running and installed versions match', async () => {
    const { monitor, deps } = fixture({ node: status(), harnesses: [], browser: {
      state: 'current', runningVersion: '1.0.0.1', installedVersion: '1.0.0.1', channel: 'stable',
      restartVerification: { state: 'older', expectedVersion: '1.0.0.2', expectedChannel: 'stable' },
    } });
    await monitor.refresh();
    expect(monitor.items()).toEqual([expect.objectContaining({ id: 'browser-chrome', severity: 'high',
      summary: expect.stringContaining('1.0.0.2') })]);
    deps.readBrowser.mockResolvedValue({ state: 'unverified' });
    await monitor.refresh();
    expect(monitor.items()).toEqual([]);
  });

  it('performs a bounded follow-up after browser changes even without an open Browser page', async () => {
    vi.useFakeTimers();
    const { monitor, deps } = fixture({ node: status(), harnesses: [], browser: { state: 'unverified' } });
    await monitor.start();
    await vi.waitFor(() => expect(deps.readBrowser).toHaveBeenCalledTimes(1));
    runtimeUpdateEvents.emit('changed', { browserChanged: true });
    await vi.waitFor(() => expect(deps.readBrowser).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(12_000);
    expect(deps.readBrowser).toHaveBeenCalledTimes(3);
    monitor.stop();
  });

  it('does not make an unknown or mismatched browser an action and isolates failures from other update sources', async () => {
    const { monitor, deps } = fixture({ browser: { state: 'unverified' } });
    await monitor.refresh();
    expect(monitor.items().some(item => item.id === 'browser-chrome')).toBe(false);
    expect(monitor.items().some(item => item.id === 'node')).toBe(true);
    deps.readBrowser.mockResolvedValue({ state: 'restart-required', runningVersion: '1.0.0.1', installedVersion: '1.0.0.2' });
    deps.readRuntime.mockRejectedValue(new Error('offline'));
    await monitor.refresh();
    expect(monitor.items().find(item => item.id === 'browser-chrome')).not.toHaveProperty('unverified');
    expect(monitor.items().find(item => item.id === 'node')).toHaveProperty('unverified', true);
    deps.readBrowser.mockResolvedValue({ state: 'configuration-mismatch' });
    await monitor.refresh();
    expect(monitor.items().some(item => item.id === 'browser-chrome')).toBe(false);
  });

  it('projects the running versions, security priority, guarded actions, and distinct pm2 update paths', async () => {
    const { monitor, deps } = fixture();
    await monitor.refresh();
    const byId = Object.fromEntries(monitor.items().map((item) => [item.id, item]));
    expect(byId.node).toMatchObject({ severity: 'high', revision: 'security:v26.12.1', drillTo: '/apps/portos-default/update' });
    expect(byId.node.summary).toContain('v26.10.0');
    expect(byId.node.summary).toContain('v26.13.0');
    expect(byId.node.summary).toContain('restart');
    expect(byId['pm2-sync'].summary).toContain('daemon 7.0.0 on Node 26.10.0');
    expect(byId['pm2-upstream']).toBeUndefined();
    expect(deps.save.mock.calls.at(-1)[0].find((item) => item.id === 'pm2-upstream').summary).toContain('npm has 7.2.0');
    expect(byId['pm2-startup'].summary).toContain('after boot');
    expect(byId['harness:codex']).toMatchObject({ drillTo: '/ai/harnesses/codex', revision: '1.0.0:1.1.0' });
    expect(byId['harness:codex'].summary).toContain('Installed 1.0.0; latest 1.1.0');
    expect(monitor.items().every((item) => item.required === !item.id.startsWith('harness:') && item.operations.length === 0)).toBe(true);
  });

  it('reads effective harness usage and keeps unavailable enabled tools dismissible', async () => {
    const listHarnesses = vi.fn().mockResolvedValue([
      harness({ id: 'unused', vendor: 'unused', providers: [{ enabled: false }] }),
      harness({ id: 'runtime-id', vendor: 'disabled-vendor', providers: [{ enabled: true }] }),
      harness({ providers: [{ enabled: false }, { enabled: true }], vendor: 'codex', latestVersion: null }),
    ]);
    const listEnablement = vi.fn().mockResolvedValue([
      { id: 'disabled-vendor', source: 'setting', enabled: false },
      { id: 'codex', source: 'detected', enabled: false },
    ]);
    const entries = await __testing.readReviewHarnesses({ listHarnesses, listEnablement });
    expect(entries.map(entry => entry.enabled)).toEqual([false, false, true]);
    const cached = { id: 'harness:codex', title: 'Codex update', summary: 'An older update', revision: '1.0.0:1.1.0', required: true };
    const { monitor } = fixture({ harnesses: entries, cached: [cached] });
    await monitor.start();
    await vi.waitFor(() => expect(monitor.items().find(item => item.id === 'harness:codex')).toMatchObject({ required: false, unverified: true }));
    expect(monitor.items().filter(item => item.id.startsWith('harness:'))).toHaveLength(1);
    monitor.stop();
  });

  it('clears disabled harness updates, including cached missing binaries, and restores them on enable', async () => {
    const { monitor, deps } = fixture({ harnesses: [harness()] });
    await monitor.refresh();
    expect(monitor.items().find(item => item.id === 'harness:codex')).toMatchObject({ required: false });
    deps.readHarnesses.mockResolvedValue([harness({ enabled: false, installed: false, probeState: 'missing' })]);
    await monitor.refresh();
    expect(monitor.items().some(item => item.id === 'harness:codex')).toBe(false);
    expect(deps.save.mock.calls.at(-1)[0].some(item => item.id === 'harness:codex')).toBe(false);
    deps.readHarnesses.mockResolvedValue([harness({ enabled: true })]);
    await monitor.refresh();
    expect(monitor.items().find(item => item.id === 'harness:codex')).toMatchObject({ required: false });
  });

  it('projects inline harness review details only for an observed update', async () => {
    const { monitor, deps } = fixture({ node: status(), harnesses: [harness({ updatable: true })] });
    await monitor.refresh();
    expect(monitor.items().find(item => item.id === 'harness:codex')).toMatchObject({ harnessUpdate: {
      id: 'codex', label: 'Codex CLI', package: '@openai/codex', installedVersion: '1.0.0', candidateVersion: '1.1.0', updatable: true,
    } });
    deps.readHarnesses.mockResolvedValue([harness({ updatable: true, probeState: 'unavailable' })]);
    await monitor.refresh();
    expect(monitor.items().find(item => item.id === 'harness:codex')).toMatchObject({ unverified: true });
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
    expect(byId['pm2-upstream']).toBeUndefined();
    expect(deps.save.mock.calls.at(-1)[0].find((item) => item.id === 'pm2-upstream').unverified).toBe(true);
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

  it('retains a known security floor offline without making an unknown harness an action', async () => {
    const { monitor, deps } = fixture({ node: runtime({ releases: null }), harnesses: [harness({ latestVersion: null })] });
    await monitor.refresh();
    const byId = Object.fromEntries(monitor.items().map((item) => [item.id, item]));
    expect(byId.node).toMatchObject({ severity: 'high', revision: 'security:v26.12.1', unverified: true });
    expect(byId.node.summary).toContain('v26.12.1');
    expect(byId['harness:codex']).toBeUndefined();
    expect(deps.save.mock.calls.at(-1)[0].find((item) => item.id === 'harness:codex'))
      .toMatchObject({ unverified: true, unverifiedPrevious: false, retrySoon: true, summary: expect.stringContaining('could not be verified') });
  });

  it('keeps unverified checks diagnostic, retries them, and raises a confirmed update', async () => {
    vi.useFakeTimers();
    const unknownHarness = harness({ id: 'unknown', latestVersion: null });
    const manualHarness = harness({ id: 'manual', package: null, latestVersion: null });
    const { monitor, deps } = fixture({ node: status(), harnesses: [unknownHarness, manualHarness, harness()] });
    expect(monitor.items()).toEqual([]);
    expect(monitor.snapshot().incomplete).toBe(true);
    await monitor.start();
    await vi.waitFor(() => expect(deps.save).toHaveBeenCalled());
    expect(monitor.items().map((item) => item.id)).toEqual(['harness:codex']);
    const saved = deps.save.mock.calls.at(-1)[0];
    expect(monitor.snapshot().incomplete).toBe(true);
    expect(saved.find((item) => item.id === 'harness:unknown')).toMatchObject({ unverified: true, unverifiedPrevious: false, retrySoon: true });
    expect(saved.find((item) => item.id === 'harness:manual')).toMatchObject({ unverified: true, unverifiedPrevious: false, retrySoon: false });

    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    expect(deps.readHarnesses).toHaveBeenCalledTimes(2);
    deps.readHarnesses.mockResolvedValue([harness({ id: 'unknown' }), manualHarness, harness()]);
    await monitor.refresh();
    expect(monitor.items().find((item) => item.id === 'harness:unknown')).toMatchObject({ revision: '1.0.0:1.1.0' });
    expect(monitor.snapshot().incomplete).toBe(false);
    deps.readHarnesses.mockResolvedValue([harness({ id: 'unknown', probeState: 'unavailable' }), manualHarness, harness()]);
    await monitor.refresh();
    expect(monitor.items().find((item) => item.id === 'harness:unknown')).toMatchObject({ revision: '1.0.0:1.1.0', unverified: true, unverifiedPrevious: true });
    monitor.stop();
  });

  it('filters cached unknown-only rows after restart while keeping known actions', async () => {
    const first = fixture({ node: status(), harnesses: [harness(), harness({ id: 'unknown', latestVersion: null })] });
    await first.monitor.refresh();
    const cached = first.deps.save.mock.calls.at(-1)[0];
    const second = fixture({ cached });
    second.deps.readRuntime.mockRejectedValue(new Error('offline'));
    second.deps.readHarnesses.mockRejectedValue(new Error('offline'));
    await second.monitor.start();
    await vi.waitFor(() => expect(second.deps.save).toHaveBeenCalled());
    expect(second.monitor.items().map((item) => item.id)).toEqual(['harness:codex']);
    expect(second.monitor.items()[0]).toMatchObject({ revision: '1.0.0:1.1.0', unverified: true, unverifiedPrevious: true });
    expect(second.deps.save.mock.calls.at(-1)[0].find((item) => item.id === 'harness:unknown'))
      .toMatchObject({ unverified: true, unverifiedPrevious: false });
    second.monitor.stop();
  });

  it('reports and retries failed source reads even when the cached rows do not change', async () => {
    vi.useFakeTimers();
    const manual = harness({ id: 'manual', package: null, latestVersion: null });
    const { monitor, deps } = fixture({ node: status(), harnesses: [manual] });
    await monitor.start();
    await vi.waitFor(() => expect(deps.save).toHaveBeenCalled());
    expect(monitor.snapshot()).toMatchObject({ items: [], incomplete: false });
    deps.notify.mockClear();
    deps.readHarnesses.mockRejectedValue(new Error('offline'));
    runtimeUpdateEvents.emit('changed');
    await vi.waitFor(() => expect(deps.notify).toHaveBeenCalled());
    expect(monitor.snapshot()).toMatchObject({ items: [], incomplete: true });
    const calls = deps.readHarnesses.mock.calls.length;
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    expect(deps.readHarnesses).toHaveBeenCalledTimes(calls + 1);
    deps.readHarnesses.mockResolvedValue([manual]);
    runtimeUpdateEvents.emit('changed');
    await vi.waitFor(() => expect(monitor.snapshot().incomplete).toBe(false));
    monitor.stop();
  });

  it('reports a failed runtime read when its only cached observation is an upstream pm2 release', async () => {
    const { monitor, deps } = fixture({ node: status({ pm2: { latest: '7.2.0' } }), harnesses: [] });
    await monitor.refresh();
    expect(monitor.snapshot()).toMatchObject({ items: [], incomplete: false });
    deps.readRuntime.mockRejectedValue(new Error('offline'));
    await monitor.refresh();
    expect(monitor.snapshot()).toMatchObject({ items: [], incomplete: true });
  });

  it('retries a harness probe failure after an unsupported release comparison', async () => {
    const manual = harness({ id: 'manual', package: null, latestVersion: null });
    const { monitor, deps } = fixture({ node: status(), harnesses: [manual] });
    await monitor.refresh();
    expect(monitor.snapshot().incomplete).toBe(false);
    deps.readHarnesses.mockResolvedValue([harness({ id: 'manual', package: null, probeState: 'unavailable', installed: false, version: null, latestVersion: null })]);
    await monitor.refresh();
    expect(monitor.snapshot().incomplete).toBe(true);
    expect(deps.save.mock.calls.at(-1)[0].find(item => item.id === 'harness:manual')).toMatchObject({ retrySoon: true, unverifiedPrevious: false });
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
    vi.useFakeTimers();
    const { monitor, deps } = fixture();
    await monitor.refresh();
    deps.readHarnesses.mockResolvedValue([harness({ installed: false, probeState: 'missing', version: null, latestVersion: null })]);
    await monitor.refresh();
    expect(monitor.items().find((item) => item.id === 'harness:codex')).toMatchObject({ revision: '1.0.0:1.1.0', unverified: true });
    vi.advanceTimersByTime(30 * 60 * 1000);
    await monitor.refresh();
    expect(monitor.items().find((item) => item.id === 'harness:codex')).toMatchObject({ revision: '1.0.0:1.1.0', unverified: true });
  });

  it('clears a missing harness diagnostic without hiding a later confirmed update', async () => {
    const manual = harness({ id: 'manual', package: null, latestVersion: null });
    const { monitor, deps } = fixture({ node: status(), harnesses: [manual] });
    await monitor.refresh();
    deps.readHarnesses.mockResolvedValue([harness({ id: 'manual', package: null, installed: false, probeState: 'missing', version: null, latestVersion: null })]);
    await monitor.refresh();
    expect(monitor.snapshot()).toMatchObject({ items: [], incomplete: false });
    expect(deps.save.mock.calls.at(-1)[0].some(item => item.id === 'harness:manual')).toBe(false);
    deps.readHarnesses.mockResolvedValue([harness({ id: 'manual' })]);
    await monitor.refresh();
    expect(monitor.items().find(item => item.id === 'harness:manual')).toMatchObject({ revision: '1.0.0:1.1.0' });
  });

  it('retries a missing npm diagnostic before treating sustained absence as a cold missing probe', async () => {
    vi.useFakeTimers();
    const { monitor, deps } = fixture({ node: status(), harnesses: [harness({ latestVersion: null })] });
    await monitor.refresh();
    deps.readHarnesses.mockResolvedValue([harness({ installed: false, probeState: 'missing', version: null, latestVersion: null })]);
    await monitor.refresh();
    expect(monitor.snapshot()).toMatchObject({ items: [], incomplete: true });
    expect(deps.save.mock.calls.at(-1)[0].find(item => item.id === 'harness:codex')).toMatchObject({ retrySoon: true, unverifiedPrevious: false });
    vi.advanceTimersByTime(15 * 60 * 1000);
    await monitor.refresh();
    expect(monitor.snapshot().incomplete).toBe(true);
    vi.advanceTimersByTime(15 * 60 * 1000);
    await monitor.refresh();
    expect(monitor.snapshot()).toMatchObject({ items: [], incomplete: false });
    deps.readHarnesses.mockResolvedValue([harness()]);
    await monitor.refresh();
    expect(monitor.items().find(item => item.id === 'harness:codex')).toMatchObject({ revision: '1.0.0:1.1.0' });
  });

  it('restarts the missing grace period after a different probe result', async () => {
    vi.useFakeTimers();
    const { monitor, deps } = fixture({ node: status(), harnesses: [harness({ latestVersion: null })] });
    await monitor.refresh();
    deps.readHarnesses.mockResolvedValue([harness({ installed: false, probeState: 'missing', version: null, latestVersion: null })]);
    await monitor.refresh();
    vi.advanceTimersByTime(20 * 60 * 1000);
    deps.readHarnesses.mockResolvedValue([harness({ installed: false, probeState: 'unavailable', version: null, latestVersion: null })]);
    await monitor.refresh();
    deps.readHarnesses.mockResolvedValue([harness({ installed: false, probeState: 'missing', version: null, latestVersion: null })]);
    await monitor.refresh();
    vi.advanceTimersByTime(10 * 60 * 1000);
    await monitor.refresh();
    expect(monitor.snapshot()).toMatchObject({ items: [], incomplete: true });
  });

  it('finishes the missing diagnostic grace period after restart', async () => {
    vi.useFakeTimers();
    const missing = harness({ installed: false, probeState: 'missing', version: null, latestVersion: null });
    const first = fixture({ node: status(), harnesses: [harness({ latestVersion: null })] });
    await first.monitor.refresh();
    first.deps.readHarnesses.mockResolvedValue([missing]);
    await first.monitor.refresh();
    const cached = first.deps.save.mock.calls.at(-1)[0];
    vi.advanceTimersByTime(30 * 60 * 1000);
    const second = fixture({ node: status(), harnesses: [missing], cached });
    await second.monitor.start();
    await vi.waitFor(() => expect(second.deps.save).toHaveBeenCalled());
    expect(second.monitor.snapshot()).toMatchObject({ items: [], incomplete: false });
    second.monitor.stop();
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

const clean = {
  node: { version: 'v26.12.1', inSupportedRange: true },
  baseline: { minimum: '26.12.1', compliant: true },
  releases: { latestInLine: { version: 'v26.12.1' }, latestSecurity: { version: 'v26.12.1' }, securityUpdate: false, securityVerified: true },
  pm2: { shipped: '7.1.0', latest: '7.1.0', cli: '7.1.0', cliState: 'available', cliBehind: false, daemonStale: false },
  daemon: { pm2Version: '7.1.0', nodeVersion: '26.12.1' },
  startup: { configured: true, current: true },
};
const status = (o = {}) => ({
  node: { ...clean.node, ...o.node, securityBaseline: { ...clean.baseline, ...o.baseline } },
  releases: { ...clean.releases, ...o.releases },
  pm2: { ...clean.pm2, ...o.pm2, daemon: o.daemon === null ? null : { ...clean.daemon, ...o.daemon } },
  startup: { ...clean.startup, ...o.startup },
});

async function observe(...statuses) {
  const { monitor, deps } = fixture({ harnesses: [] });
  for (const next of statuses) {
    deps.readRuntime.mockResolvedValue(next);
    await monitor.refresh();
  }
  return Object.fromEntries(monitor.items().map((item) => [item.id, item]));
}

async function observeCache(next) {
  const { monitor, deps } = fixture({ node: next, harnesses: [] });
  await monitor.refresh();
  return Object.fromEntries(deps.save.mock.calls.at(-1)[0].map((item) => [item.id, item]));
}

describe('runtime row reconciliation', () => {
  it('reports nothing for an aligned, current runtime', async () => {
    expect(await observe(status())).toEqual({});
  });

  it('replaces the cold runtime-check row with evidence and later marks only the runtime rows unknown', async () => {
    const { monitor, deps } = fixture({ node: {} });
    await monitor.refresh();
    const byId = () => Object.fromEntries(monitor.items().map((item) => [item.id, item]));
    expect(byId()['runtime-check']).toBeUndefined();
    expect(deps.save.mock.calls.at(-1)[0].find((item) => item.id === 'runtime-check'))
      .toMatchObject({ title: 'Runtime update check unavailable', unverified: true, unverifiedPrevious: false });
    deps.readRuntime.mockResolvedValue(runtime());
    await monitor.refresh();
    expect(byId()['runtime-check']).toBeUndefined();
    expect(byId().node.unverified).toBeUndefined();
    deps.readRuntime.mockResolvedValue({ pm2: {} });
    await monitor.refresh();
    expect(byId()['runtime-check']).toBeUndefined();
    expect(byId().node).toMatchObject({ revision: 'security:v26.12.1', unverified: true, unverifiedPrevious: true });
    expect(byId()['pm2-startup']).toMatchObject({ unverified: true, unverifiedPrevious: true });
    expect(byId()['harness:codex'].unverified).toBeUndefined();
  });

  it.each([
    ['an advisory the baseline does not yet require', { node: { version: 'v26.11.0' }, releases: { securityUpdate: true } }, {
      title: 'Node.js security update needed', severity: 'high', revision: 'security:v26.12.1',
      summary: 'Security update: PortOS runs v26.11.0; target v26.12.1. Updating Node requires a PortOS restart.',
    }],
    ['an advisory naming no security release', { node: { version: 'v26.11.0' }, releases: { securityUpdate: true, latestSecurity: null } }, {
      title: 'Node.js security update needed', severity: 'high', revision: 'security:v26.12.1',
    }],
    ['an unsupported runtime with no newer release', {
      node: { version: 'v25.1.0', inSupportedRange: false }, baseline: { minimum: null }, releases: { latestInLine: { version: 'v25.1.0' }, latestSecurity: null },
    }, {
      title: 'Node.js update available', severity: 'high', revision: 'update:v25.1.0',
      summary: 'Unsupported runtime: PortOS runs v25.1.0. Updating Node requires a PortOS restart.',
    }],
    ['a newer release in the same line', { releases: { latestInLine: { version: 'v26.13.0' } } }, {
      title: 'Node.js update available', severity: 'normal', revision: 'update:v26.13.0',
      summary: 'Update available: PortOS runs v26.12.1; target v26.13.0. Updating Node requires a PortOS restart.',
    }],
  ])('raises a verified Node.js row for %s', async (_label, overrides, expected) => {
    const { node } = await observe(status(overrides));
    expect(node).toMatchObject(expected);
    expect(node.unverified).toBeUndefined();
  });

  it.each([
    ['a security floor above the newest indexed release', {
      node: { version: 'v26.10.0' }, baseline: { compliant: false }, releases: { latestInLine: { version: 'v26.11.0' }, latestSecurity: { version: 'v26.11.0' } },
    }, { severity: 'high', revision: 'security:v26.12.1', summary: expect.stringContaining('target v26.12.1.') }],
    ['an unknown security baseline', { baseline: { compliant: null } }, { title: 'Node.js update status unverified', revision: 'unverified' }],
    ['an unverified release index', { releases: { securityVerified: false } }, { title: 'Node.js update status unverified', revision: 'unverified' }],
  ])('marks the Node.js row unverified for %s', async (_label, overrides, expected) => {
    const { node } = await observeCache(status(overrides));
    expect(node).toMatchObject({ ...expected, unverified: true });
  });

  it('holds the last known Node.js row through an unverified index unless it adds security evidence', async () => {
    const newer = status({ releases: { latestInLine: { version: 'v26.13.0' } } });
    const held = await observe(newer, status({ releases: { latestInLine: { version: 'v26.14.0' }, securityVerified: false } }));
    expect(held.node).toMatchObject({ revision: 'update:v26.13.0', severity: 'normal', unverified: true });
    const escalated = await observe(newer, status({
      releases: { latestInLine: { version: 'v26.13.0' }, latestSecurity: null, securityUpdate: true, securityVerified: false },
    }));
    expect(escalated.node).toMatchObject({ revision: 'security:v26.13.0', severity: 'high', unverified: true });
    const unsupported = await observe(newer, status({
      node: { inSupportedRange: false }, releases: { latestInLine: { version: 'v26.13.0' }, securityVerified: false },
    }));
    expect(unsupported.node).toMatchObject({ revision: 'update:v26.13.0', severity: 'high', unverified: true, summary: expect.stringContaining('Unsupported runtime') });
  });

  it('replaces an unknown-only Node observation when a newer release is found', async () => {
    const byId = await observe(
      status({ releases: { securityVerified: false } }),
      status({ releases: { latestInLine: { version: 'v26.14.0' }, securityVerified: false } }),
    );
    expect(byId.node).toMatchObject({ title: 'Node.js update available', revision: 'update:v26.14.0', unverified: true });
  });

  it('holds a security Node.js row when the unverified index repeats or lacks its target, but escalates an unsupported row', async () => {
    const repeated = await observe(
      status({ node: { version: 'v26.10.0' }, releases: { latestInLine: { version: 'v26.13.0' }, securityUpdate: true } }),
      status({ node: { version: 'v26.10.0' }, releases: { latestInLine: { version: 'v26.14.0' }, securityUpdate: true, securityVerified: false } }),
    );
    expect(repeated.node).toMatchObject({ revision: 'security:v26.12.1', unverified: true, summary: expect.stringContaining('target v26.13.0.') });
    const unsupported = { node: { version: 'v25.1.0', inSupportedRange: false }, baseline: { minimum: null }, releases: { latestInLine: { version: 'v25.1.0' }, latestSecurity: null } };
    const unnamed = await observe(status(unsupported), status({ ...unsupported, releases: { ...unsupported.releases, securityUpdate: true, securityVerified: false } }));
    expect(unnamed.node).toMatchObject({ title: 'Node.js security update needed', severity: 'high', unverified: true });
  });

  it.each([
    ['a stale daemon', { pm2: { daemonStale: true } }, 'terminal 7.1.0, daemon 7.1.0 on Node 26.12.1', 'Synchronizing the daemon requires a restart.', '7.1.0:7.1.0:7.1.0:26.12.1:v26.12.1'],
    ['a terminal CLI behind the bundle', { pm2: { cli: '7.0.0', cliBehind: true } }, 'terminal 7.0.0, daemon 7.1.0 on Node 26.12.1',
      'The terminal CLI can be synchronized without a restart.', '7.1.0:7.0.0:7.1.0:26.12.1:v26.12.1'],
    ['a daemon on another Node', { daemon: { nodeVersion: '26.11.0' } }, 'terminal 7.1.0, daemon 7.1.0 on Node 26.11.0',
      'Review the differing Node versions; the pm2 sync action cannot fix this mismatch on its own.', '7.1.0:7.1.0:7.1.0:26.11.0:v26.12.1'],
  ])('raises a verified pm2 alignment row for %s', async (_label, overrides, versions, action, revision) => {
    const { 'pm2-sync': sync } = await observe(status(overrides));
    expect(sync).toMatchObject({ title: 'Review pm2 runtime alignment', revision, summary: `PortOS bundles pm2 7.1.0; ${versions}; PortOS runs v26.12.1. ${action}` });
    expect(sync.unverified).toBeUndefined();
  });

  it('accepts a v-prefixed daemon Node version as aligned', async () => {
    expect(await observe(status({ daemon: { nodeVersion: 'v26.12.1' } }))).toEqual({});
  });

  it.each([
    ['no terminal CLI or daemon', { pm2: { cli: null, cliBehind: true } , daemon: null }, '7.1.0::::v26.12.1', 'terminal not installed, daemon unknown on Node unknown'],
    ['an unreadable daemon Node version', { pm2: { cliBehind: true }, daemon: { nodeVersion: 'unknown' } }, '7.1.0:7.1.0:7.1.0:unknown:v26.12.1', 'on Node unknown'],
    ['a daemon reporting no pm2 version', { pm2: { daemonStale: true }, daemon: { pm2Version: null } }, '7.1.0:7.1.0::26.12.1:v26.12.1', 'daemon unknown on Node 26.12.1'],
  ])('keeps a drift row unverified for %s', async (_label, overrides, revision, versions) => {
    const { 'pm2-sync': sync } = await observe(status(overrides));
    expect(sync).toMatchObject({ title: 'Review pm2 runtime alignment', revision, unverified: true, summary: expect.stringContaining(versions) });
  });

  it.each([
    ['no bundled pm2', { pm2: { shipped: null, cliBehind: true } }, true],
    ['a daemon missing its Node version', { daemon: { nodeVersion: null } }, true],
    ['a daemon missing its pm2 version', { daemon: { pm2Version: null } }, true],
    ['an unsupported terminal CLI', { pm2: { cliState: 'unsupported' } }, false],
    ['an unsupported terminal CLI and unreadable daemon', { pm2: { cliState: 'unsupported' }, daemon: { nodeVersion: null } }, true],
  ])('reports pm2 alignment unverified for %s', async (_label, overrides, retrySoon) => {
    const { 'pm2-sync': sync } = await observeCache(status(overrides));
    expect(sync).toMatchObject({ title: 'pm2 runtime status unverified', revision: 'unverified', unverified: true, retrySoon });
  });

  it('keeps the last known pm2 drift when the terminal CLI becomes unverifiable', async () => {
    const byId = await observe(status({ pm2: { cli: '7.0.0', cliBehind: true } }), status({ pm2: { cli: null, cliState: 'unverified' } }));
    expect(byId['pm2-sync']).toMatchObject({ revision: '7.1.0:7.0.0:7.1.0:26.12.1:v26.12.1', unverified: true, unverifiedPrevious: true, retrySoon: true });
  });

  it.each([
    ['no bundled version', { pm2: { shipped: null } }, 'pm2 release status unverified', 'the npm release could not be checked'],
    ['an incomparable npm version', { pm2: { latest: 'next' } }, 'pm2 release status unverified', 'could not be compared'],
  ])('reports the pm2 release row unverified for %s', async (_label, overrides, title, summary) => {
    const { 'pm2-upstream': upstream } = await observeCache(status(overrides));
    expect(upstream).toMatchObject({ title, unverified: true, summary: expect.stringContaining(summary) });
  });

  it('raises no pm2 release row when the bundle is newer than npm', async () => {
    expect(await observe(status({ pm2: { latest: '7.0.0' } }))).toEqual({});
  });

  it.each([
    ['an unconfigured startup hook', { configured: false, current: false }],
    ['an unreadable startup hook with no prior row', { configured: true, current: null }],
  ])('raises no startup row for %s', async (_label, startup) => {
    expect(await observe(status({ startup }))).toEqual({});
  });
});
