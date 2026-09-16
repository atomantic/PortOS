import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fetchWithTimeoutModule from '../lib/fetchWithTimeout.js';
import { contextWindowRejection, knownContextWindow } from '../lib/aiToolkit/providerStatus.js';
import { resetOpenAiModelsProbeCache } from '../lib/openAiModelsProbeCache.js';
import { observedContextWindows, withObservedContextWindows } from './observedContextWindows.js';

// The shipped vLLM wrapper, which is exactly the record that carried no window
// at all: seeded by migration with no `contextWindow` and no
// `modelContextWindows`.
const vllmProvider = (overrides = {}) => ({
  id: 'opencode-vllm',
  name: 'OpenCode vLLM',
  type: 'cli',
  command: 'opencode',
  endpoint: 'http://127.0.0.1:18020/v1',
  defaultModel: 'qwen3.8-27b',
  models: ['qwen3.8-27b'],
  vllmBacked: true,
  ...overrides,
});

const listing = (contextWindows) => async () => ({
  reachable: true,
  models: Object.keys(contextWindows),
  contextWindows,
  error: null,
});

beforeEach(() => {
  resetOpenAiModelsProbeCache();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetOpenAiModelsProbeCache();
});

describe('observedContextWindows', () => {
  it('reads the served window off a daemon-backed provider\'s /v1/models', async () => {
    const probe = vi.fn(listing({ 'qwen3.8-27b': 32768 }));

    await expect(observedContextWindows(vllmProvider(), { probe })).resolves.toEqual({ 'qwen3.8-27b': 32768 });
    expect(probe).toHaveBeenCalledWith('http://127.0.0.1:18020/v1', '');
  });

  it('aliases the provider\'s own spelling onto the daemon\'s bare id', async () => {
    // An OpenCode wrapper offers `llama/dflash`; the daemon lists `dflash`. A
    // map keyed on only one of the two answers "unknown" for every dispatch,
    // because `resolveEffectiveModel` hands downstream code the record's
    // spelling.
    const provider = {
      id: 'opencode-llama-tui',
      type: 'tui',
      command: 'opencode',
      endpoint: 'http://127.0.0.1:5568/v1',
      defaultModel: 'llama/dflash',
      models: ['llama/dflash'],
      llamaBacked: true,
    };

    await expect(observedContextWindows(provider, { probe: listing({ dflash: 8192 }) }))
      .resolves.toEqual({ dflash: 8192, 'llama/dflash': 8192 });
  });

  it('observes nothing for a provider that is not daemon-backed', async () => {
    const probe = vi.fn(listing({ 'claude-sonnet-5': 1_000_000 }));
    const remote = { id: 'anthropic', type: 'api', endpoint: 'https://api.anthropic.com/v1', models: [] };

    await expect(observedContextWindows(remote, { probe })).resolves.toBeNull();
    // An external endpoint is somebody else's install — PortOS must not poll it
    // from the dispatch path.
    expect(probe).not.toHaveBeenCalled();
  });

  it('observes nothing when the daemon is down, unreadable, or silent about windows', async () => {
    const unreachable = async () => ({ reachable: false, models: null, contextWindows: null, error: 'ECONNREFUSED' });
    await expect(observedContextWindows(vllmProvider(), { probe: unreachable })).resolves.toBeNull();

    const unlistable = async () => ({ reachable: true, models: null, contextWindows: null, error: 'authentication required' });
    await expect(observedContextWindows(vllmProvider(), { probe: unlistable })).resolves.toBeNull();

    // Up, listing fine, declaring no window — `{}` is "nothing declared one",
    // which must stay "unknown" rather than becoming a zero-token ceiling.
    await expect(observedContextWindows(vllmProvider(), { probe: listing({}) })).resolves.toBeNull();
  });

  it('observes nothing when the probe throws', async () => {
    const probe = async () => { throw new Error('socket hang up'); };
    await expect(observedContextWindows(vllmProvider(), { probe })).resolves.toBeNull();
  });
});

describe('withObservedContextWindows', () => {
  it('folds the live window into modelContextWindows without touching the record', async () => {
    const provider = vllmProvider();
    const decorated = await withObservedContextWindows(provider, { probe: listing({ 'qwen3.8-27b': 32768 }) });

    expect(decorated.modelContextWindows).toEqual({ 'qwen3.8-27b': 32768 });
    // The stored record is observed runtime state's source, never its target —
    // a user editing this provider must not find a probe's number in it.
    expect(provider.modelContextWindows).toBeUndefined();
  });

  it('lets the live window win over a stale stored one, and keeps the rest', async () => {
    // The stored number is whatever a refresh recorded whenever the user last
    // pressed it; the probe describes the process about to serve this request.
    const provider = vllmProvider({ modelContextWindows: { 'qwen3.8-27b': 131072, other: 4096 } });
    const decorated = await withObservedContextWindows(provider, { probe: listing({ 'qwen3.8-27b': 32768 }) });

    expect(decorated.modelContextWindows).toEqual({ 'qwen3.8-27b': 32768, other: 4096 });
  });

  it('returns the SAME provider when there is nothing observed', async () => {
    const provider = vllmProvider();
    const unreachable = async () => ({ reachable: false, models: null, contextWindows: null, error: 'ECONNREFUSED' });

    // Identity, not just equality: an install whose daemon is down must route
    // through exactly the record it always did.
    await expect(withObservedContextWindows(provider, { probe: unreachable })).resolves.toBe(provider);
  });
});

// The end-to-end contract #7441 asked for: a `/v1/models` body carrying
// `max_model_len` must reach `knownContextWindow` for a `vllmBacked` provider,
// through the real probe rather than a stubbed one.
describe('a vLLM listing resolves all the way through knownContextWindow', () => {
  const servedModels = (body) => vi.spyOn(fetchWithTimeoutModule, 'fetchWithTimeout')
    .mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify(body) });

  it('turns max_model_len into a refusal for a prompt that cannot fit', async () => {
    servedModels({ data: [{ id: 'qwen3.8-27b', object: 'model', max_model_len: 32768 }] });

    const provider = await withObservedContextWindows(vllmProvider());

    expect(knownContextWindow(provider, 'qwen3.8-27b')).toBe(32768);
    expect(contextWindowRejection(provider, 'qwen3.8-27b', { requiredContextTokens: 21_000 })).toBeNull();
    expect(contextWindowRejection(provider, 'qwen3.8-27b', { requiredContextTokens: 60_000 }))
      .toMatch(/32768-token context is below the 60000-token request budget/);
  });

  it('leaves an explicit contextWindow the user set in charge', async () => {
    servedModels({ data: [{ id: 'qwen3.8-27b', max_model_len: 32768 }] });

    // A number the operator typed is a deliberate override, not a stale guess —
    // `knownContextWindow` prefers it, and observing must not change that.
    const provider = await withObservedContextWindows(vllmProvider({ contextWindow: 16_384 }));
    expect(knownContextWindow(provider, 'qwen3.8-27b')).toBe(16_384);
  });

  it('stays unknown when the daemon declares no window', async () => {
    servedModels({ data: [{ id: 'qwen3.8-27b', object: 'model' }] });

    const provider = await withObservedContextWindows(vllmProvider());
    expect(knownContextWindow(provider, 'qwen3.8-27b')).toBeNull();
    // Unknown is "no constraint" — a request of any size still routes.
    expect(contextWindowRejection(provider, 'qwen3.8-27b', { requiredContextTokens: 1_000_000 })).toBeNull();
  });
});
