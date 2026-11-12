import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./aiProvider.js', async (importActual) => {
  const actual = await importActual();
  return { ...actual, resolveAPIProvider: vi.fn() };
});
vi.mock('./promptRunner.js', async (importActual) => {
  const actual = await importActual();
  return { ...actual, runPromptThroughProvider: vi.fn() };
});

vi.mock('./providers.js', () => ({ getProviderById: vi.fn() }));

const aiProvider = await import('./aiProvider.js');
const promptRunner = await import('./promptRunner.js');
const providers = await import('./providers.js');
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
  providers.getProviderById.mockResolvedValue(null);
  aiProvider.resolveAPIProvider.mockResolvedValue(apiProvider);
  promptRunner.runPromptThroughProvider.mockResolvedValue({ text: composedText, model: 'qwen', provider: apiProvider });
});

describe('composeBoardPrompt', () => {
  it('synthesizes both saved board styles without feeding their pins to the model', async () => {
    const style = await composeBoardPrompt({
      sourceBoards: [
        { name: 'Ink', style: { prompt: 'Ink washes' }, items: [analyzed] },
        { name: 'Neon', style: { prompt: 'Neon lights' }, items: [] },
      ], providerId: 'ollama', model: 'qwen',
    });
    const sent = promptRunner.runPromptThroughProvider.mock.calls[0][0].prompt;
    expect(sent).toContain('Ink washes');
    expect(sent).toContain('Neon lights');
    expect(sent).toContain('ONE new, coherent visual style');
    expect(sent).not.toContain(analyzed.analysis.prompt);
    expect(style.prompt).toBe(JSON.parse(composedText).prompt);
    promptRunner.runPromptThroughProvider.mockResolvedValueOnce({ text: JSON.stringify({ prompt: 'x'.repeat(8001) }) });
    await expect(composeBoardPrompt({ sourceBoards: [{ style: { prompt: 'Ink' } }, { style: { prompt: 'Neon' } }] }))
      .rejects.toMatchObject({ code: 'COMPOSITE_BAD_JSON', status: 502 });
  });

  it('runs the picked vision CLI provider with its model and effort instead of swapping to an API provider', async () => {
    const codex = { id: 'codex', type: 'cli', command: 'codex', enabled: true };
    providers.getProviderById.mockResolvedValue(codex);
    promptRunner.runPromptThroughProvider.mockResolvedValue({ text: composedText, model: 'gpt-5.6-luna', provider: codex });
    const style = await composeBoardPrompt({
      board: { id: 'mb-1', name: 'Foundry', items: [analyzed] },
      providerId: 'codex',
      model: 'gpt-5.6-luna',
      effort: 'high',
    });
    expect(aiProvider.resolveAPIProvider).not.toHaveBeenCalled();
    expect(promptRunner.runPromptThroughProvider).toHaveBeenCalledWith(expect.objectContaining({
      provider: codex, model: 'gpt-5.6-luna', effort: 'high',
    }));
    expect(style.providerId).toBe('codex');
  });

  it('refuses a board whose items carry neither an analysis nor a caption', async () => {
    await expect(composeBoardPrompt({
      board: { id: 'mb-1', name: 'Empty', items: [{ id: 'i1', type: 'image', mediaKey: 'image:a.png', caption: null }] },
    })).rejects.toMatchObject({ code: 'NOTHING_ANALYZED', status: 400 });
    expect(promptRunner.runPromptThroughProvider).not.toHaveBeenCalled();
  });

  it('accepts items with prompt captions for style composition', async () => {
    const style = await composeBoardPrompt({
      board: { id: 'mb-1', name: 'Captioned', items: [{ id: 'i1', type: 'image', mediaKey: 'image:a.png', caption: 'granular ink wash' }] },
      providerId: 'ollama',
      model: 'qwen',
    });
    expect(style.prompt.startsWith('a weathered foundry')).toBe(true);
    expect(style.analyzedItemCount).toBe(1);
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
