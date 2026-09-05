import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { createDefaultPersistentMindState, normalizePersistentMindState } from '../lib/persistentMind.js';
import { normalizePersistentMindCapabilities } from '../lib/persistentMindCapabilities.js';
const mock = vi.hoisted(() => ({ root: null, provider: null, events: [] }));
vi.mock('./cosState.js', () => ({ loadState: async () => mock.root,
  saveState: async (root) => { mock.root = JSON.parse(JSON.stringify(root)); }, withStateLock: async (fn) => fn() }));
vi.mock('./providers.js', () => ({ getProviderById: async () => mock.provider }));
vi.mock('./providerStatus.js', () => ({ isProviderAvailable: () => true, getProviderStatus: () => null }));
vi.mock('./agentRunEventLog.js', () => ({ appendMindEvent: async (event) => { mock.events.push(event); } }));
import { approvePersistentMindThinkingPresets, getPersistentMindThinkingRequestCatalog,
  requestPersistentMindThinkingPreset, resolvePersistentMindSelfThinkingRequest,
  cancelPersistentMindThinkingRequest } from './persistentMindThinkingRequests.js';
const selection = { id: 'local', label: 'Local pass', providerId: 'example-local', model: 'example-model', effort: '' };
const context = (requestId = 'request-1') => ({ turnId: 'turn-1', requestId });
const request = (requestId) => requestPersistentMindThinkingPreset({ presetId: 'local', reason: 'Try a focused pass' }, context(requestId));
async function approve() {
  const config = mock.root.config;
  config.persistentMindCapabilities = { ...normalizePersistentMindCapabilities(), chooseThinkingPreset: true, thinkingPresetAllowlist: ['local'], thinkingPresetGrants: await approvePersistentMindThinkingPresets(config, ['local']) };
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-01-01T12:00:00Z')); mock.events = [];
  mock.provider = { id: 'example-local', name: 'Example runtime', type: 'api', endpoint: 'http://localhost:1234/v1', models: ['example-model'] };
  mock.root = { config: { persistentMindProfile: { enabled: true, providerId: 'example-default', model: 'home' }, persistentMindThinkingPresets: { presets: [selection] } },
    persistentMind: { ...createDefaultPersistentMindState(), enabled: true, started: true, activeTurn: { id: 'turn-1', wake: { kind: 'message', message: { id: 'message-1', text: 'Hello' } } } } };
});
afterEach(() => vi.useRealTimers());
it('lists only exact human-approved local routes and never modifies the home profile', async () => {
  const original = structuredClone(mock.root.config.persistentMindProfile);
  expect((await getPersistentMindThinkingRequestCatalog()).presets).toEqual([]);
  expect((await request()).ok).toBe(false);
  await approve();
  expect((await getPersistentMindThinkingRequestCatalog()).presets).toEqual([selection]);
  expect((await request()).ok).toBe(true);
  expect(mock.root.config.persistentMindProfile).toEqual(original);
  expect(mock.root.persistentMind.activeTurn.wake.kind).toBe('message');
  expect((await request()).duplicate).toBe(true);
  expect((await request('request-2')).error).toMatch(/pending/);
  expect(mock.events[0].data.displayText).toContain('Try a focused pass');
});
it('retains quota through cancellation and process-style reloads, including the rolling window', async () => {
  await approve();
  for (let i = 0; i < 3; i += 1) {
    expect((await request(`request-${i}`)).ok).toBe(true);
    await cancelPersistentMindThinkingRequest();
    mock.root.persistentMind = normalizePersistentMindState(JSON.parse(JSON.stringify(mock.root.persistentMind)));
    expect((await request(`early-${i}`)).ok).toBe(false);
    vi.advanceTimersByTime(30 * 60_000);
  }
  expect((await request('over-limit')).error).toMatch(/Three/);
  expect(mock.root.persistentMind.thinkingRequests.history).toHaveLength(3);
  vi.advanceTimersByTime(24 * 60 * 60_000);
  expect((await request('next-day')).ok).toBe(true);
});
it.each([
  ['provider rename', () => { mock.provider.name = 'Renamed'; }],
  ['endpoint change', () => { mock.provider.endpoint = 'http://localhost:1234/changed/v1'; }],
  ['removed model', () => { mock.provider.models = []; }],
  ['unsupported effort', () => { mock.root.config.persistentMindThinkingPresets.presets[0] = { ...selection, effort: 'max' }; }],
  ['removed preset', () => { mock.root.config.persistentMindThinkingPresets.presets = []; }],
  ['revoked grant', () => { mock.root.config.persistentMindCapabilities.chooseThinkingPreset = false; }],
  ['account credential', () => { mock.provider.apiKey = 'example-test-key'; }],
])('refuses a stale accepted route after %s, without selecting another alternate', async (_name, change) => {
  await approve(); await request();
  const pending = mock.root.persistentMind.thinkingRequests.pending;
  change();
  expect((await resolvePersistentMindSelfThinkingRequest({ request: pending, config: mock.root.config })).ok).toBe(false);
  expect((await getPersistentMindThinkingRequestCatalog()).presets).toEqual([]);
});
it('refuses name-based guesses, remote accounts, CLI wrappers, config injection and inactive callers', async () => {
  const base = { ...mock.provider };
  for (const provider of [
    { ...base, name: 'Ollama', endpoint: 'https://example.com/v1' },
    { ...base, name: 'LM Studio', endpoint: 'http://localhost:9999/v1' },
    { ...base, type: 'cli', command: 'example' },
  ]) {
    mock.provider = provider; await approve(); expect((await request()).ok).toBe(false);
  }
  await expect(requestPersistentMindThinkingPreset({ presetId: 'local', reason: 'change', endpoint: 'https://example.com' }, context())).rejects.toThrow();
  expect((await requestPersistentMindThinkingPreset({ presetId: 'local', reason: 'change' }, { turnId: 'old', requestId: 'old' })).ok).toBe(false);
});

it('does not resurrect a revoked pending request after re-approval, and charges delayed admission time', async () => {
  await approve(); await request();
  mock.root.config.persistentMindCapabilities.thinkingPresetAllowlist = [];
  await cancelPersistentMindThinkingRequest({ ifRevoked: true });
  await approve();
  expect(mock.root.persistentMind.thinkingRequests.pending).toBeNull();
  vi.advanceTimersByTime(25 * 60 * 60_000);
  mock.root.persistentMind.thinkingRequests.history[0].admittedAt = new Date().toISOString();
  expect((await request('after-delayed-admission')).error).toMatch(/30 minutes/);
});
