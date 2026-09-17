import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../ollamaManager.js', () => ({
  getInstalledModels: vi.fn(),
  getLastInstalledModelsError: vi.fn(() => null),
  getModelCapabilities: vi.fn(),
  getLoadedModels: vi.fn(),
  pullModel: vi.fn(),
  ensureRunning: vi.fn(),
  warmModel: vi.fn(),
}));

const ollamaManager = await import('../ollamaManager.js');
const { getVoiceProvisioner, defaultToolModelChain, sizeOf, paramsToB, CHAIN_ENTRIES } = await import('./modelProvisioners.js');

const ollama = getVoiceProvisioner('ollama');
const lmstudio = getVoiceProvisioner('lmstudio');

beforeEach(() => vi.clearAllMocks());

describe('getVoiceProvisioner', () => {
  it('serves both built-in local backends and nothing for a remote provider', () => {
    expect(ollama.id).toBe('ollama');
    expect(lmstudio.id).toBe('lmstudio');
    // A remote OpenAI-compatible provider serves its own models — there is
    // nothing to install or pre-warm, so `null` is the answer, not an error.
    expect(getVoiceProvisioner('openai')).toBeNull();
  });
});

// The sentinel is the whole point of this module: `null` = "could not ask",
// `[]` = "asked, nothing installed". Collapsing them is what made voice chase
// a four-entry install chain on every boot against a backend that was down.
describe('listModels sentinel', () => {
  it('reports an unreachable Ollama as null, not an empty list', async () => {
    ollamaManager.getInstalledModels.mockResolvedValue([]);
    ollamaManager.getLastInstalledModelsError.mockReturnValue('Ollama is unavailable');
    expect(await ollama.listModels()).toBeNull();
  });

  it('reports a reachable but empty Ollama as an empty list', async () => {
    ollamaManager.getInstalledModels.mockResolvedValue([]);
    ollamaManager.getLastInstalledModelsError.mockReturnValue(null);
    expect(await ollama.listModels()).toEqual([]);
  });

  it('maps installed Ollama models to their ids', async () => {
    ollamaManager.getInstalledModels.mockResolvedValue([{ id: 'qwen2.5:7b-instruct' }, { name: 'granite4.1:3b' }]);
    ollamaManager.getLastInstalledModelsError.mockReturnValue(null);
    expect(await ollama.listModels()).toEqual(['qwen2.5:7b-instruct', 'granite4.1:3b']);
  });

  it('reports an unreachable LM Studio as null, not an empty list', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    expect(await lmstudio.listModels()).toBeNull();
    vi.unstubAllGlobals();
  });

  it('reports a reachable but empty LM Studio as an empty list', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data: [] }) })));
    expect(await lmstudio.listModels()).toEqual([]);
    vi.unstubAllGlobals();
  });
});

describe('tool capability', () => {
  it('trusts Ollama /api/show capabilities over the id heuristic', async () => {
    // `granite4.1:3b` carries no tool-ish token in its id, so the LM Studio
    // heuristic would miss it — Ollama reports the fact directly.
    ollamaManager.getModelCapabilities.mockResolvedValue(['completion', 'tools']);
    expect(await ollama.isToolCapable('granite4.1:3b')).toBe(true);

    ollamaManager.getModelCapabilities.mockResolvedValue(['completion']);
    expect(await ollama.isToolCapable('qwen2.5:7b-instruct')).toBe(false);
  });

  it('falls back to the id heuristic when the capability probe fails', async () => {
    // null = the probe failed. "Unknown" must not read as "no tools".
    ollamaManager.getModelCapabilities.mockResolvedValue(null);
    expect(await ollama.isToolCapable('qwen2.5-7b-instruct')).toBe(true);
  });
});

describe('defaultToolModelChain', () => {
  it('derives small non-reasoning tool models from the shared catalog, smallest first', () => {
    const chain = defaultToolModelChain('ollama');
    expect(chain.length).toBeGreaterThan(0);
    const sizes = CHAIN_ENTRIES('ollama').map(e => paramsToB(e.params));
    expect([...sizes].sort((a, b) => a - b)).toEqual(sizes);
    expect(sizes.every(s => s <= 10)).toBe(true);
    // Every entry must be a real install target, not an unparseable size that
    // slipped through the cap because Infinity <= 10 is false but NaN isn't.
    expect(sizes.every(Number.isFinite)).toBe(true);
  });

  // Regression: `params` below a billion is written in MILLIONS. Ranking the
  // chain with the id-based `sizeOf` scored "270M" as Infinity and sorted the
  // smallest, fastest function-calling model LAST.
  it('ranks a sub-billion model ahead of a multi-billion one', () => {
    expect(paramsToB('270M')).toBeCloseTo(0.27);
    expect(paramsToB('7B')).toBe(7);
    expect(paramsToB('3.8B')).toBe(3.8);
    expect(paramsToB('')).toBe(Infinity);
    expect(sizeOf('functiongemma:270m')).toBe(Infinity);
    expect(paramsToB('270M')).toBeLessThan(paramsToB('3B'));
  });

  it('produces backend-native ids per backend', () => {
    // The same catalog entry has a different install id per backend; a chain
    // must never hand LM Studio repo ids to `ollama pull`.
    expect(defaultToolModelChain('ollama')).not.toEqual(defaultToolModelChain('lmstudio'));
  });

  it('honours the single-id env override', () => {
    process.env.PORTOS_VOICE_DEFAULT_TOOL_MODEL = 'custom/model:tag';
    expect(defaultToolModelChain('ollama')).toEqual(['custom/model:tag']);
    delete process.env.PORTOS_VOICE_DEFAULT_TOOL_MODEL;
  });
});

describe('ollama load', () => {
  afterEach(() => vi.clearAllMocks());

  it('warms the model once the daemon is confirmed running', async () => {
    ollamaManager.ensureRunning.mockResolvedValue({ success: true, running: true });
    ollamaManager.warmModel.mockResolvedValue({ warmed: true, model: 'granite4.1:3b' });
    expect(await ollama.load('granite4.1:3b')).toEqual({ ok: true, reason: '' });
    expect(ollamaManager.warmModel).toHaveBeenCalledWith('granite4.1:3b');
  });

  it('does not attempt a warm when the daemon could not be started', async () => {
    ollamaManager.ensureRunning.mockResolvedValue({ success: false, error: 'port in use' });
    expect(await ollama.load('granite4.1:3b')).toEqual({ ok: false, reason: 'port in use' });
    expect(ollamaManager.warmModel).not.toHaveBeenCalled();
  });
});
