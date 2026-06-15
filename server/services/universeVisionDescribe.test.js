import { describe, it, expect, vi, beforeEach } from 'vitest';

// resolveAPIProvider drives provider selection; stripCodeFences is real (re-
// exported through the partial mock so the cleanup of the runner's text works).
vi.mock('../lib/aiProvider.js', async (importActual) => {
  const actual = await importActual();
  return { ...actual, resolveAPIProvider: vi.fn() };
});

// runPromptThroughProvider is the LLM boundary — mock it. assertProvider is
// real (it's the typed-throw helper we want exercised end to end).
vi.mock('../lib/promptRunner.js', async (importActual) => {
  const actual = await importActual();
  return { ...actual, runPromptThroughProvider: vi.fn() };
});

const aiProvider = await import('../lib/aiProvider.js');
const promptRunner = await import('../lib/promptRunner.js');
const { describeEntityFromImages, VISION_KINDS, VISION_MAX_IMAGES, __testing } = await import('./universeVisionDescribe.js');

const apiProvider = { id: 'ollama', type: 'api', defaultModel: 'llava' };

beforeEach(() => {
  vi.clearAllMocks();
  aiProvider.resolveAPIProvider.mockResolvedValue(apiProvider);
  promptRunner.runPromptThroughProvider.mockResolvedValue({ text: 'a weathered scavenger', runId: 'r1', model: 'llava' });
});

describe('buildVisionPrompt', () => {
  it('asks to describe a single subject for one image', () => {
    const p = __testing.buildVisionPrompt({ kind: 'character', name: 'Vex', imageCount: 1 });
    expect(p).toMatch(/reference image of the character "Vex"/);
    expect(p).not.toMatch(/CONSISTENT across all/);
  });

  it('asks for the common description across multiple images', () => {
    const p = __testing.buildVisionPrompt({ kind: 'place', name: 'The Foundry', imageCount: 3 });
    expect(p).toMatch(/3 reference images of the same place/);
    expect(p).toMatch(/CONSISTENT across all/);
  });

  it('folds per-kind focus + known context into the prompt', () => {
    const p = __testing.buildVisionPrompt({ kind: 'object', context: 'a relic blade', imageCount: 1 });
    expect(p).toMatch(/Focus on the object/);
    expect(p).toMatch(/Known context.*a relic blade/s);
  });
});

describe('describeEntityFromImages', () => {
  it('returns the cleaned description + the provider/model that ran', async () => {
    const out = await describeEntityFromImages({
      kind: 'character', name: 'Vex', screenshots: ['a.png'], providerId: 'ollama', model: 'llava',
    });
    expect(out).toEqual({ description: 'a weathered scavenger', llm: { provider: 'ollama', model: 'llava' } });
    expect(promptRunner.runPromptThroughProvider).toHaveBeenCalledWith(
      expect.objectContaining({ screenshots: ['a.png'], source: 'universe-vision-describe' }),
    );
  });

  it('reports the fallback provider id when the runner swapped to another API provider', async () => {
    promptRunner.runPromptThroughProvider.mockResolvedValue({
      text: 'x', model: 'gpt-vision', usedFallback: true, fallbackProvider: { id: 'openai', type: 'api' },
    });
    const out = await describeEntityFromImages({ kind: 'place', screenshots: ['a.png'] });
    expect(out.llm).toEqual({ provider: 'openai', model: 'gpt-vision' });
  });

  it('reports the effective provider on a proactive swap to another API provider', async () => {
    promptRunner.runPromptThroughProvider.mockResolvedValue({
      text: 'x', model: 'gpt-vision', provider: { id: 'openai', type: 'api' },
    });
    const out = await describeEntityFromImages({ kind: 'place', screenshots: ['a.png'] });
    expect(out.llm).toEqual({ provider: 'openai', model: 'gpt-vision' });
  });

  it('rejects (VISION_FALLBACK_DROPPED_IMAGES) on a retry fallback to a non-API provider', async () => {
    promptRunner.runPromptThroughProvider.mockResolvedValue({
      text: 'hallucinated from text alone', model: 'sonnet', usedFallback: true, fallbackProvider: { id: 'claude-code', type: 'cli' },
    });
    await expect(describeEntityFromImages({ kind: 'character', screenshots: ['a.png'] }))
      .rejects.toMatchObject({ code: 'VISION_FALLBACK_DROPPED_IMAGES', status: 502 });
  });

  it('rejects (VISION_FALLBACK_DROPPED_IMAGES) on a proactive swap to a non-API provider (no usedFallback set)', async () => {
    promptRunner.runPromptThroughProvider.mockResolvedValue({
      text: 'hallucinated from text alone', model: 'sonnet', provider: { id: 'claude-code', type: 'cli' },
    });
    await expect(describeEntityFromImages({ kind: 'character', screenshots: ['a.png'] }))
      .rejects.toMatchObject({ code: 'VISION_FALLBACK_DROPPED_IMAGES', status: 502 });
  });

  it('forwards optional context into the vision prompt', async () => {
    await describeEntityFromImages({ kind: 'object', context: 'a relic blade', screenshots: ['a.png'] });
    const { prompt } = promptRunner.runPromptThroughProvider.mock.calls[0][0];
    expect(prompt).toMatch(/Known context.*a relic blade/s);
  });

  it('strips code fences the model may wrap the prose in', async () => {
    promptRunner.runPromptThroughProvider.mockResolvedValue({ text: '```\nfenced prose\n```', model: 'llava' });
    const out = await describeEntityFromImages({ kind: 'object', screenshots: ['a.png'] });
    expect(out.description).toBe('fenced prose');
  });

  it('rejects an unsupported kind', async () => {
    await expect(describeEntityFromImages({ kind: 'spaceship', screenshots: ['a.png'] }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR', status: 400 });
  });

  it('rejects when no images are supplied', async () => {
    await expect(describeEntityFromImages({ kind: 'character', screenshots: [] }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR', status: 400 });
  });

  it(`rejects more than ${VISION_MAX_IMAGES} images`, async () => {
    const tooMany = Array.from({ length: VISION_MAX_IMAGES + 1 }, (_, i) => `${i}.png`);
    await expect(describeEntityFromImages({ kind: 'character', screenshots: tooMany }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR', status: 400 });
  });

  it('throws NO_API_PROVIDER (503) when no API provider is configured', async () => {
    aiProvider.resolveAPIProvider.mockResolvedValue(null);
    await expect(describeEntityFromImages({ kind: 'character', screenshots: ['a.png'] }))
      .rejects.toMatchObject({ code: 'NO_API_PROVIDER', status: 503 });
    expect(promptRunner.runPromptThroughProvider).not.toHaveBeenCalled();
  });

  it('throws VISION_EMPTY (502) when the model returns blank prose', async () => {
    promptRunner.runPromptThroughProvider.mockResolvedValue({ text: '   ', model: 'llava' });
    await expect(describeEntityFromImages({ kind: 'character', screenshots: ['a.png'] }))
      .rejects.toMatchObject({ code: 'VISION_EMPTY', status: 502 });
  });

  it('exports the three canon kinds', () => {
    expect(VISION_KINDS).toEqual(['character', 'place', 'object']);
  });
});
