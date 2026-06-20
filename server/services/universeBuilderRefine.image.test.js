import { describe, it, expect, vi, beforeEach } from 'vitest';

// Style-reference-image refine path: forces a vision API provider, passes the
// resolved image path as a screenshot, and rejects a non-API fallback.
vi.mock('../lib/aiProvider.js', async (importActual) => {
  const actual = await importActual();
  return { ...actual, resolveAPIProvider: vi.fn() };
});
vi.mock('../lib/promptRunner.js', async (importActual) => {
  const actual = await importActual();
  return {
    ...actual,
    resolveProviderAndModel: vi.fn(),
    runPromptThroughProvider: vi.fn(),
  };
});

const aiProvider = await import('../lib/aiProvider.js');
const promptRunner = await import('../lib/promptRunner.js');
const { refineWorldPrompts } = await import('./universeBuilderRefine.js');

const apiProvider = { id: 'ollama', type: 'api', enabled: true, defaultModel: 'qwen-vl' };
const cliProvider = { id: 'claude-code', type: 'cli', enabled: true, defaultModel: 'sonnet' };

const REFINE_JSON = JSON.stringify({
  starterPrompt: 'a rust-toned scavenger world',
  logline: 'l', premise: 'p', styleNotes: 'rust palette, low sun',
  influences: { embrace: ['rust palette'], avoid: ['neon'] },
  rationale: 'pulled toward the reference', changes: ['palette → rust'],
});

beforeEach(() => {
  vi.clearAllMocks();
  aiProvider.resolveAPIProvider.mockResolvedValue(apiProvider);
  promptRunner.resolveProviderAndModel.mockResolvedValue({ provider: cliProvider, selectedModel: 'sonnet' });
  promptRunner.runPromptThroughProvider.mockResolvedValue({
    text: REFINE_JSON, runId: 'r1', model: 'qwen-vl', provider: apiProvider,
  });
});

describe('refineWorldPrompts — style-reference image', () => {
  it('forces a vision API provider and passes the image path as a screenshot', async () => {
    const out = await refineWorldPrompts({
      starterPrompt: 'seed', feedback: 'pull toward this', imagePath: '/abs/data/images/ref.png',
    });
    expect(aiProvider.resolveAPIProvider).toHaveBeenCalled();
    // The text-only resolver must NOT be used when an image is supplied.
    expect(promptRunner.resolveProviderAndModel).not.toHaveBeenCalled();
    expect(promptRunner.runPromptThroughProvider).toHaveBeenCalledWith(
      expect.objectContaining({ screenshots: ['/abs/data/images/ref.png'] }),
    );
    expect(out.starterPrompt).toBe('a rust-toned scavenger world');
    // hasImage guidance reached the prompt.
    const { prompt } = promptRunner.runPromptThroughProvider.mock.calls[0][0];
    expect(prompt).toMatch(/REFERENCE IMAGE/);
  });

  it('throws NO_API_PROVIDER (503) when no vision provider is configured', async () => {
    aiProvider.resolveAPIProvider.mockResolvedValue(null);
    await expect(refineWorldPrompts({ starterPrompt: 'seed', feedback: 'x', imagePath: '/abs/ref.png' }))
      .rejects.toMatchObject({ code: 'NO_API_PROVIDER', status: 503 });
    expect(promptRunner.runPromptThroughProvider).not.toHaveBeenCalled();
  });

  it('rejects (VISION_FALLBACK_DROPPED_IMAGES) when the run fell back to a non-API provider', async () => {
    promptRunner.runPromptThroughProvider.mockResolvedValue({
      text: REFINE_JSON, runId: 'r1', model: 'sonnet',
      usedFallback: true, fallbackProvider: cliProvider,
    });
    await expect(refineWorldPrompts({ starterPrompt: 'seed', feedback: 'x', imagePath: '/abs/ref.png' }))
      .rejects.toMatchObject({ code: 'VISION_FALLBACK_DROPPED_IMAGES', status: 502 });
  });

  it('uses the text-only provider resolution and sends no screenshots without an image', async () => {
    // Text-only path returns an API provider here just so JSON parsing succeeds.
    promptRunner.resolveProviderAndModel.mockResolvedValue({ provider: apiProvider, selectedModel: 'qwen-vl' });
    const out = await refineWorldPrompts({ starterPrompt: 'seed', feedback: 'x' });
    expect(aiProvider.resolveAPIProvider).not.toHaveBeenCalled();
    expect(promptRunner.resolveProviderAndModel).toHaveBeenCalled();
    expect(promptRunner.runPromptThroughProvider).toHaveBeenCalledWith(
      expect.objectContaining({ screenshots: [] }),
    );
    const { prompt } = promptRunner.runPromptThroughProvider.mock.calls[0][0];
    expect(prompt).not.toMatch(/REFERENCE IMAGE/);
    expect(out.starterPrompt).toBe('a rust-toned scavenger world');
  });
});
