import { beforeEach, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ root: null, scan: vi.fn(), actions: vi.fn(), queue: vi.fn(), save: vi.fn(), visibility: vi.fn() }));
vi.mock('./cosState.js', () => ({ loadState: async () => mock.root, saveState: (...args) => mock.save(...args), withStateLock: fn => fn() }));
vi.mock('./developmentWatchdog.js', () => ({ runDevelopmentWatchdog: (...args) => mock.scan(...args), readDevelopmentWatchdogSnapshot: (...args) => mock.scan(...args) }));
vi.mock('./userActions.js', () => ({ listUserActions: (...args) => mock.actions(...args) }));
vi.mock('./reviewQueue.js', () => ({ buildQueue: (...args) => mock.queue(...args) }));
vi.mock('./persistentMindVisibility.js', () => ({ readPersistentMindVisibility: (...args) => mock.visibility(...args) }));
vi.mock('./persistentMindProfile.js', () => ({ resolvePersistentMindProfile: async () => ({ ok: true, provider: { id: 'example' } }) }));
const { readPersistentMindMaintenanceContext: read, buildPersistentMindMaintenancePrompt: prompt } = await import('./persistentMindMaintenanceContext.js');
const now = Date.parse('2026-01-02T00:00:00Z');
const visibility = { capturedAt: new Date(now).toISOString(), health: { system: 'available', forge: 'ready', database: 'unknown' } };
beforeEach(() => {
  vi.clearAllMocks();
  mock.visibility.mockResolvedValue(visibility);
  mock.root = { config: { persistentMindMaintainer: { enabled: true, appIds: ['example'] }, persistentMindCapabilities: { readPortos: true, allowedAppIds: ['example'] } } };
  mock.scan.mockResolvedValue({ id: 'receipt', checkedAt: new Date(now).toISOString(), complete: true, blockers: [], apps: [{ appId: 'example', complete: true, blockers: [],
    pullRequests: [{ number: 12, disposition: 'actively-owned', url: 'private-url', headBranch: 'private-branch' }],
    issues: [{ number: 34, disposition: 'blocked' }] }], decisions: [], recovery: [], counts: { dispatched: 0, duplicateAdmissionsPrevented: 0, deterministicActions: 0 }, availableSlots: 2 });
  mock.actions.mockResolvedValue([{ actor: 'user', type: 'cos.schedule.trigger', summary: 'private-summary' }, { actor: 'system', type: 'cos.task.create' }]);
  mock.queue.mockResolvedValue({ generatedAt: new Date(now).toISOString(), partial: false, nextCursor: null,
    items: [{ title: 'private-obligation', id: 'private-id' }],
    sources: { cos: { availability: 'available', total: 0, lowerBound: 0, truncation: false } } });
});

it('does no collection or dispatch without both opt-in and current scoped read grant', async () => {
  mock.root.config.persistentMindCapabilities.readPortos = false;
  expect(await read({ now })).toEqual({ enabled: true, granted: false });
  expect(mock.scan).not.toHaveBeenCalled(); expect(mock.actions).not.toHaveBeenCalled();
  mock.root.config.persistentMindCapabilities.readPortos = true;
  mock.root.config.persistentMindCapabilities.allowedAppIds = [];
  expect((await read({ now })).granted).toBe(false);
  expect(mock.scan).not.toHaveBeenCalled();
});

it('uses the shared cadence-aware watchdog, excludes automation/prose, and honors canonical settled totals', async () => {
  const result = await read({ visibility, now });
  expect(mock.scan).toHaveBeenCalledWith({ source: 'mind-wake' });
  expect(mock.actions).toHaveBeenCalledWith(expect.objectContaining({ actor: 'user', limit: 201 }));
  expect(mock.queue).toHaveBeenCalledWith(expect.objectContaining({ query: { view: 'today' }, limit: 25 }));
  expect(result.sources.operator.maintenanceInterventions).toBe(1);
  expect(result.sources.actions.sources.cos.total).toBe(0);
  expect(result.sources.watchdog.apps[0]).toMatchObject({ pullRequests: { 'actively-owned': 1 }, issues: { blocked: 1 } });
  expect(result.metrics.current).toMatchObject({ actualDuplicateDispatches: null, savedCognitiveTime: null });
  expect(JSON.stringify(result)).not.toMatch(/private-summary|private-obligation|private-url|private-branch|private-id/);
  expect(prompt(result)).toContain('return to the existing Eidoverse playbook');
});

it('does not mistake a fresh receipt timestamp for changed evidence and retains a bounded baseline', async () => {
  const first = await read({ visibility, now });
  mock.scan.mockResolvedValue({ ...(await mock.scan()), id: 'new-receipt', checkedAt: new Date(now + 60000).toISOString() });
  const second = await read({ visibility, now: now + 60000 });
  expect(first.changed).toBe(true); expect(second.changed).toBe(false);
  expect(second.metrics.baseline.observedAt).toBe(new Date(now).toISOString());
  expect(mock.root.persistentMindMaintenanceContext.samples).toHaveLength(2);
  const refreshed = await read({ now: now + 60000 });
  expect(refreshed.changed).toBe(false);
  expect(mock.visibility).toHaveBeenCalledTimes(1);
});

it('marks failed and truncated sources explicitly rather than reporting zero work', async () => {
  mock.scan.mockRejectedValue(new Error('private-error'));
  mock.actions.mockResolvedValue(Array.from({ length: 201 }, () => ({ actor: 'user', type: 'cos.task.create' })));
  mock.queue.mockRejectedValue(new Error('private-queue-error'));
  const result = await read({ now });
  expect(result.partial).toBe(true);
  expect(result.sources.watchdog.state).toBe('unavailable');
  expect(result.sources.operator).toMatchObject({ partial: true, nextOffset: 200, maintenanceInterventions: 200 });
  expect(result.metrics.current.dispatched).toBeNull();
  expect(prompt(result)).not.toContain('private-error');
});

it('rechecks scope after collection and discards evidence revoked in flight', async () => {
  mock.actions.mockImplementation(async () => { mock.root.config.persistentMindCapabilities.readPortos = false; return []; });
  expect(await read({ visibility, now })).toEqual({ enabled: true, granted: false });
  expect(mock.save).not.toHaveBeenCalled();
});

it('bounds oversized evidence without emitting a partial JSON document', () => {
  const value = { enabled: true, granted: true, sources: { watchdog: { state: 'available', apps: Array(500).fill('x'.repeat(500)) } }, metrics: {} };
  const rendered = prompt(value);
  expect(rendered.length).toBeLessThan(12000);
  expect(JSON.parse(rendered.slice(rendered.indexOf('\n{') + 1)).truncated).toBe(true);
});
