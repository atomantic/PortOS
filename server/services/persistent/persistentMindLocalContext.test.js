import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';
import { PATHS } from '../../lib/paths.js';
import { detectSystemCapabilities } from '../../lib/systemCapabilities.js';
import { getMemoryStats } from '../../lib/memoryStats.js';
import { appendMindEvent } from '../agent/agentRunEventLog.js';
import { loadState } from '../cos/cosState.js';
import { ensureContextWindow } from '../ollamaManager.js';
import { getProviderById, updateProvider } from '../provider/providers.js';
import { adjustPersistentMindLocalContext, getPersistentMindLocalContextCatalog } from './persistentMindLocalContext.js';

vi.mock('../../lib/paths.js', async (original) => makePathsProxy(await original(), {
  dataRoot: () => lazyTempDataRoot('portos-mind-local-context-'),
}));
vi.mock('../../lib/systemCapabilities.js', () => ({ detectSystemCapabilities: vi.fn() }));
vi.mock('../../lib/memoryStats.js', () => ({ getMemoryStats: vi.fn() }));
vi.mock('../agent/agentRunEventLog.js', () => ({ appendMindEvent: vi.fn() }));
vi.mock('../cos/cosState.js', () => ({ loadState: vi.fn(), withStateLock: (fn) => fn() }));
vi.mock('../ollamaManager.js', () => ({ ensureContextWindow: vi.fn() }));
vi.mock('../provider/providers.js', () => ({ getProviderById: vi.fn(), updateProvider: vi.fn() }));

const historyPath = join(PATHS.cos, 'persistent-mind-local-context.json');
const gibibyte = 1024 ** 3;
const minute = 60_000;
const day = 24 * 60 * minute;
const now = Date.parse('2026-01-01T12:00:00Z');
const profile = { enabled: true, providerId: 'example-local', model: 'example-model' };
const provider = {
  id: profile.providerId,
  name: 'Example Ollama',
  type: 'api',
  endpoint: 'http://127.0.0.1:11434/v1',
  numCtx: 1024,
  defaultModel: 'example-default-model',
};
const activeTurn = { id: 'example-turn' };
const args = { numCtx: 2048, reason: 'Read the current plan' };
const caller = (requestId = 'example-request') => ({ turnId: activeTurn.id, requestId });

function configureMind(grants) {
  loadState.mockResolvedValue({
    config: { persistentMindProfile: profile, persistentMindCapabilities: grants },
    persistentMind: { activeTurn, enabled: true, started: true, mindId: 'example-mind' },
  });
}

async function expectNoAdjustment() {
  expect(updateProvider).not.toHaveBeenCalled();
  expect(ensureContextWindow).not.toHaveBeenCalled();
  expect(appendMindEvent).not.toHaveBeenCalled();
  await expect(readFile(historyPath)).rejects.toMatchObject({ code: 'ENOENT' });
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
  await mkdir(PATHS.cos, { recursive: true });
  await rm(historyPath, { force: true });
  configureMind({ adjustLocalContext: true });
  getProviderById.mockImplementation(async (id) => (id === profile.providerId ? provider : null));
  detectSystemCapabilities.mockResolvedValue({ totalMemoryGb: 32 });
  getMemoryStats.mockResolvedValue({ free: 24 * gibibyte });
  updateProvider.mockResolvedValue(undefined);
  ensureContextWindow.mockResolvedValue({ applied: true });
  appendMindEvent.mockResolvedValue(undefined);
});

afterEach(() => vi.useRealTimers());
afterAll(cleanupTempDataRoots);

it.each([undefined, { adjustLocalContext: false }, { adjustLocalContext: 'true' }])(
  'requires an explicit capability grant (%j)',
  async (grants) => {
    configureMind(grants);
    expect(await getPersistentMindLocalContextCatalog()).toMatchObject({ enabled: false, eligible: true });
    expect(await adjustPersistentMindLocalContext(args, caller())).toEqual({
      ok: false,
      error: 'adjustLocalContext is not granted',
    });
    await expectNoAdjustment();
  },
);

it.each([
  ['another turn', { ...caller(), turnId: 'example-old-turn' }],
  ['a missing request id', { turnId: activeTurn.id }],
  ['an aborted call', { ...caller(), signal: AbortSignal.abort() }],
])('refuses %s even when the capability is granted', async (_label, context) => {
  expect(await adjustPersistentMindLocalContext(args, context)).toEqual({
    ok: false,
    error: 'Request requires the active mind turn',
  });
  await expectNoAdjustment();
});

it.each([
  ['a missing provider', null],
  ['a CLI wrapper', { ...provider, type: 'cli' }],
  ['a remote runtime endpoint', { ...provider, endpoint: 'https://example.com/v1' }],
  ['an API key', { ...provider, apiKey: 'example-test-key' }],
  ['an API key env var', { ...provider, apiKeyEnvVar: 'EXAMPLE_API_KEY' }],
  ['a gateway', { ...provider, gatewayBacked: true }],
  ['an OrcaRouter provider', { ...provider, orcarouterBacked: true }],
  ['provider-specific environment', { ...provider, envVars: { EXAMPLE_ENV: 'test' } }],
])('rejects %s as an ineligible provider', async (_label, record) => {
  getProviderById.mockResolvedValue(record);
  expect(await getPersistentMindLocalContextCatalog()).toMatchObject({ enabled: true, eligible: false });
  expect(await adjustPersistentMindLocalContext(args, caller())).toEqual({
    ok: false,
    error: "Only the mind's local API provider can adjust numCtx",
  });
  await expectNoAdjustment();
});

it.each([
  ['CPU installed RAM', { totalMemoryGb: 8 }, {}, 2048, null, 'cpu-only-ram-ceiling:2048'],
  ['free RAM', { totalMemoryGb: 32 }, { free: 10 * gibibyte }, 4500, null, 'free-memory-ceiling:4500'],
  ['exhausted RAM headroom', { totalMemoryGb: 32 }, { free: 7 * gibibyte }, 512, null, 'free-memory-ceiling:512'],
  ['CUDA VRAM', { totalMemoryGb: 64, cuda: { status: 'available', maxVramGb: 10 } }, {}, 16384, 10, 'gpu-vram-ceiling:16384'],
  ['Apple Silicon unified RAM', { totalMemoryGb: 24, appleSilicon: true }, {}, 65536, 24, 'gpu-vram-ceiling:65536'],
])('enforces the %s ceiling in both catalog and mutation', async (_label, capabilities, memory, max, maxVramGb, reason) => {
  detectSystemCapabilities.mockResolvedValue(capabilities);
  getMemoryStats.mockResolvedValue(memory);
  const catalog = await getPersistentMindLocalContextCatalog();
  expect(catalog).toMatchObject({
    enabled: true,
    eligible: true,
    providerId: profile.providerId,
    model: profile.model,
    numCtx: provider.numCtx,
    clamp: { min: 512, max, host: { hasUsableGpu: maxVramGb !== null, maxVramGb } },
  });
  expect(catalog.clamp.reasons).toContain(reason);
  expect(await adjustPersistentMindLocalContext({ ...args, numCtx: max + 1 }, caller())).toMatchObject({
    ok: false,
    error: expect.stringContaining('exceeds the safe ceiling'),
    clamp: catalog.clamp,
  });
  await expectNoAdjustment();
  expect(await adjustPersistentMindLocalContext({ ...args, numCtx: max }, caller())).toMatchObject({
    ok: true,
    numCtx: max,
    clamp: catalog.clamp,
  });
  expect(updateProvider).toHaveBeenCalledExactlyOnceWith(profile.providerId, { numCtx: max });
});

it.each([
  ['a context below the minimum', { numCtx: 511 }],
  ['a context above the maximum', { numCtx: 131073 }],
  ['a fractional context', { numCtx: 2048.5 }],
  ['a numeric string', { numCtx: '2048' }],
  ['a blank reason', { reason: '   ' }],
  ['an oversized reason', { reason: 'x'.repeat(241) }],
  ['a caller-supplied provider', { providerId: 'example-other-provider' }],
])('rejects %s before loading state or mutating anything', async (_label, invalid) => {
  await expect(adjustPersistentMindLocalContext({ ...args, ...invalid }, caller())).rejects.toBeInstanceOf(ZodError);
  expect(loadState).not.toHaveBeenCalled();
  await expectNoAdjustment();
});

it.each([512, 131072])('accepts the inclusive wire bound %d when the host supports it', async (numCtx) => {
  detectSystemCapabilities.mockResolvedValue({ totalMemoryGb: 128, cuda: { status: 'available', maxVramGb: 40 } });
  getMemoryStats.mockResolvedValue({ free: 90 * gibibyte });
  expect(await adjustPersistentMindLocalContext({ ...args, numCtx }, caller())).toMatchObject({ ok: true, numCtx });
});

it('persists an Ollama adjustment and reuses the recorded request without repeating side effects', async () => {
  const context = caller();
  const result = await adjustPersistentMindLocalContext({ ...args, reason: `  ${args.reason}  ` }, context);
  expect(result).toMatchObject({
    ok: true,
    providerId: profile.providerId,
    previousNumCtx: provider.numCtx,
    numCtx: args.numCtx,
    daemon: { applied: true },
  });
  expect(JSON.parse(await readFile(historyPath, 'utf8'))).toEqual({
    schemaVersion: 1,
    history: [{
      ...context,
      at: new Date(now).toISOString(),
      providerId: profile.providerId,
      previousNumCtx: provider.numCtx,
      numCtx: args.numCtx,
      reason: args.reason,
      clampMax: result.clamp.max,
    }],
  });
  expect(await adjustPersistentMindLocalContext(args, context)).toEqual({
    ok: true,
    duplicate: true,
    numCtx: args.numCtx,
    providerId: profile.providerId,
  });
  expect(await adjustPersistentMindLocalContext({ ...args, numCtx: 4096 }, context)).toEqual({
    ok: false,
    error: 'Request id already used',
  });
  expect(updateProvider).toHaveBeenCalledExactlyOnceWith(profile.providerId, { numCtx: args.numCtx });
  expect(ensureContextWindow).toHaveBeenCalledExactlyOnceWith(args.numCtx, profile.model);
  expect(appendMindEvent).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    kind: 'mind.local-context.adjusted',
    turnId: activeTurn.id,
    data: expect.objectContaining({ numCtx: args.numCtx, daemonApplied: true }),
  }));
});

it('updates another eligible local runtime without nudging Ollama', async () => {
  getProviderById.mockResolvedValue({ ...provider, name: 'Example LM Studio', endpoint: 'http://127.0.0.1:1234/v1' });
  expect(await adjustPersistentMindLocalContext(args, caller())).toMatchObject({ ok: true, daemon: null });
  expect(updateProvider).toHaveBeenCalledExactlyOnceWith(profile.providerId, { numCtx: args.numCtx });
  expect(ensureContextWindow).not.toHaveBeenCalled();
});

it('enforces spacing and the rolling daily quota from persisted adjustment history', async () => {
  expect((await adjustPersistentMindLocalContext(args, caller('request-0'))).ok).toBe(true);
  vi.setSystemTime(now + 10 * minute - 1);
  expect(await adjustPersistentMindLocalContext(args, caller('too-soon'))).toEqual({
    ok: false,
    error: 'Local context adjustments must be spaced apart',
  });
  for (let index = 1; index < 6; index += 1) {
    vi.setSystemTime(now + index * 10 * minute);
    expect((await adjustPersistentMindLocalContext(args, caller(`request-${index}`))).ok).toBe(true);
  }
  vi.resetModules();
  const { adjustPersistentMindLocalContext: adjustAfterReload } = await import('./persistentMindLocalContext.js');
  vi.setSystemTime(now + day - 1);
  expect(await adjustAfterReload(args, caller('over-quota'))).toEqual({
    ok: false,
    error: 'Local context adjustments already used for the rolling 24 hours',
  });
  const { history } = JSON.parse(await readFile(historyPath, 'utf8'));
  expect(history.map(({ requestId }) => requestId)).toEqual(
    Array.from({ length: 6 }, (_, index) => `request-${index}`),
  );
  expect(updateProvider).toHaveBeenCalledTimes(6);
  expect(ensureContextWindow).toHaveBeenCalledTimes(6);
  vi.setSystemTime(now + day);
  expect((await adjustAfterReload(args, caller('next-day'))).ok).toBe(true);
});

it('retains the latest 40 entries, including the newly recorded adjustment', async () => {
  const history = Array.from({ length: 42 }, (_, index) => ({
    requestId: `old-${index}`,
    at: new Date(now - 2 * day + index * minute).toISOString(),
    providerId: profile.providerId,
    ...args,
  }));
  await writeFile(historyPath, JSON.stringify({ schemaVersion: 1, history }));
  expect((await adjustPersistentMindLocalContext(args, caller())).ok).toBe(true);
  const persisted = JSON.parse(await readFile(historyPath, 'utf8'));
  expect(persisted.schemaVersion).toBe(1);
  expect(persisted.history).toEqual([
    ...history.slice(3),
    expect.objectContaining({ ...caller(), ...args }),
  ]);
});
