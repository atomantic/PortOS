import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./aiProvider.js', async (importActual) => {
  const actual = await importActual();
  return { ...actual, resolveAPIProvider: vi.fn() };
});
vi.mock('./promptRunner.js', async (importActual) => {
  const actual = await importActual();
  return { ...actual, runPromptThroughProvider: vi.fn() };
});

const aiProvider = await import('./aiProvider.js');
const promptRunner = await import('./promptRunner.js');
const { composeBoardPrompt } = await import('./moodBoardCompositeStyle.js');

const apiProvider = { id: 'ollama', type: 'api', defaultModel: 'qwen' };
const composedText = JSON.stringify({
  prompt: 'Create an image of a weathered foundry in granular ink wash, dusty ochre light, tactile paper grain',
  negativePrompt: 'gloss, neon, plastic',
  rationale: 'Every pin trades polish for a tactile mark.',
});

const analyzed = {
  id: 'i1',
  type: 'image',
  analysis: { prompt: 'a weathered foundry in granular ink wash', negativePrompt: 'gloss, neon' },
};

beforeEach(() => {
  vi.clearAllMocks();
  aiProvider.resolveAPIProvider.mockResolvedValue(apiProvider);
  promptRunner.runPromptThroughProvider.mockResolvedValue({ text: composedText, model: 'qwen', provider: apiProvider });
});

describe('composeBoardPrompt', () => {
  it('refuses a board whose items have not been decomposed into prompts', async () => {
    await expect(composeBoardPrompt({
      board: { id: 'mb-1', name: 'Empty', items: [{ id: 'i1', type: 'image', mediaKey: 'image:a.png', caption: 'a caption' }] },
    })).rejects.toMatchObject({ code: 'NOTHING_ANALYZED', status: 400 });
    expect(promptRunner.runPromptThroughProvider).not.toHaveBeenCalled();
  });

  it('distills stored item prompts into one still-image style and strips an imperative prefix', async () => {
    const style = await composeBoardPrompt({
      board: {
        id: 'mb-1',
        name: 'Foundry',
        description: 'Dusty painted sci-fi.',
        items: [analyzed, { id: 'i2', type: 'text', text: 'lean and grim' }],
      },
      providerId: 'ollama',
      model: 'qwen',
    });
    const sent = promptRunner.runPromptThroughProvider.mock.calls[0][0].prompt;
    expect(sent).toContain('granular ink wash');
    expect(sent).toContain('analyzedPrompt');
    expect(sent).toContain('Dusty painted sci-fi.');
    expect(style.prompt.startsWith('a weathered foundry')).toBe(true);
    expect(style.negativePrompt).toBe('gloss, neon, plastic');
    expect(style.analyzedItemCount).toBe(1);
    expect(style.providerId).toBe('ollama');
    expect(style.model).toBe('qwen');
    expect(style.rationale).toContain('tactile');
  });

  it('rejects an empty model prompt', async () => {
    promptRunner.runPromptThroughProvider.mockResolvedValueOnce({ text: '{"prompt":"   ","negativePrompt":""}', model: 'qwen' });
    await expect(composeBoardPrompt({
      board: { id: 'mb-1', items: [analyzed] },
    })).rejects.toMatchObject({ code: 'COMPOSITE_BAD_JSON', status: 502 });
  });
});
