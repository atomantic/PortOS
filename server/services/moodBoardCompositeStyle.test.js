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
    expect(sent).toContain('subject-independent visual style');
    expect(sent).toContain('Remove subject definitions even from older source styles');
    expect(sent).not.toContain(analyzed.analysis.prompt);
    expect(style.prompt).toBe(JSON.parse(composedText).prompt);
    promptRunner.runPromptThroughProvider.mockResolvedValueOnce({ text: JSON.stringify({ prompt: 'x'.repeat(8001) }) });
    await expect(composeBoardPrompt({ sourceBoards: [{ style: { prompt: 'Ink' } }, { style: { prompt: 'Neon' } }] }))
      .rejects.toMatchObject({ code: 'COMPOSITE_BAD_JSON', status: 502 });
  });

  it.each(['cli', 'tui'])('runs the picked vision %s provider with its model and effort instead of swapping to an API provider', async (type) => {
    const codex = { id: 'codex', type, command: 'codex', enabled: true };
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
    expect(sent).toContain('HOW the images look from WHAT they depict');
    expect(sent).toContain('abstract, non-narrative study');
    expect(sent).toContain('Start with the visual treatment, not a subject or scene');
    expect(sent).not.toContain('Start with the subject or scene');
    expect(style.prompt.startsWith('a weathered foundry')).toBe(true);
    expect(style.negativePrompt).toBe('gloss, neon, plastic');
    expect(style.analyzedItemCount).toBe(1);
    expect(style.providerId).toBe('ollama');
    expect(style.model).toBe('qwen');
    expect(style.rationale).toContain('tactile');
  });

  it('preserves the optical finish at the end of long pin analyses', async () => {
    const finish = 'Soft defocused edges, halation and misregistered color fringes.';
    const prompt = `${'An elaborate imaginary landscape with layered architecture. '.repeat(20)}${finish}`;
    await composeBoardPrompt({
      board: { id: 'mb-1', style: { prompt: 'OLD_COMPOSITE', negativePrompt: 'OLD_NEGATIVE' }, items: Array.from({ length: 7 }, (_, i) => ({
        id: `pin-${i}`, type: 'image', analysis: { prompt, negativePrompt: 'harsh digital sharpening' },
      })) },
    });
    const sent = promptRunner.runPromptThroughProvider.mock.calls[0][0].prompt;
    expect(sent.split(finish)).toHaveLength(8);
    expect(sent).not.toContain('OLD_COMPOSITE');
    expect(sent).not.toContain('OLD_NEGATIVE');
    expect(sent).toContain('harsh digital sharpening');
  });

  it('rejects an empty model prompt', async () => {
    promptRunner.runPromptThroughProvider.mockResolvedValueOnce({ text: '{"prompt":"   ","negativePrompt":""}', model: 'qwen' });
    await expect(composeBoardPrompt({
      board: { id: 'mb-1', items: [analyzed] },
    })).rejects.toMatchObject({ code: 'COMPOSITE_BAD_JSON', status: 502 });
  });
});
