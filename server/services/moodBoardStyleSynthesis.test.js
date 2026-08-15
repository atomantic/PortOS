import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/aiProvider.js', async (importActual) => {
  const actual = await importActual();
  return { ...actual, resolveAPIProvider: vi.fn() };
});
vi.mock('../lib/promptRunner.js', async (importActual) => {
  const actual = await importActual();
  return { ...actual, runPromptThroughProvider: vi.fn() };
});

const aiProvider = await import('../lib/aiProvider.js');
const promptRunner = await import('../lib/promptRunner.js');
const {
  collectBoardStyleContext,
  buildBoardStyleSynthesisPrompt,
  synthesizeBoardStyle,
} = await import('./moodBoardStyleSynthesis.js');

const apiProvider = { id: 'ollama', type: 'api', defaultModel: 'qwen' };
const synthesisText = JSON.stringify({
  styleNotes: 'Tactile ink-wash science fiction with restrained, dusty light.',
  influences: {
    embrace: ['granular ink wash', 'muted ochre'],
    avoid: ['glossy 3D', 'neon'],
  },
  rationale: 'The board consistently trades polish for tactile marks.',
});

const boardWith = (items) => ({
  id: 'mb-1',
  name: 'Universe refs',
  description: 'Dusty painted sci-fi.',
  items,
});

const analyzedItem = {
  id: 'i1',
  type: 'image',
  mediaKey: 'image:ref.png',
  caption: 'palette anchor',
  analysis: {
    prompt: 'a weathered foundry in granular ink wash',
    negativePrompt: 'gloss, neon',
    rationale: 'muted, tactile look',
    analyzedAt: '2026-08-14T00:00:00.000Z',
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  aiProvider.resolveAPIProvider.mockResolvedValue(apiProvider);
  promptRunner.runPromptThroughProvider.mockResolvedValue({ text: synthesisText, model: 'qwen' });
});

describe('collectBoardStyleContext', () => {
  it('gathers notes, captions, and persisted analyses; skips media items with neither', () => {
    const ctx = collectBoardStyleContext(boardWith([
      analyzedItem,
      { id: 'i2', type: 'text', text: 'lean grim and spiritual', caption: null },
      { id: 'i3', type: 'video', mediaKey: 'video:clip.mp4', caption: null, analysis: null },
    ]));
    expect(ctx.description).toBe('Dusty painted sci-fi.');
    expect(ctx.items).toHaveLength(2);
    expect(ctx.items[0]).toMatchObject({
      kind: 'image',
      caption: 'palette anchor',
      analyzedPrompt: expect.stringContaining('granular ink wash'),
      analyzedNegative: 'gloss, neon',
    });
    expect(ctx.items[1]).toMatchObject({ kind: 'text', note: 'lean grim and spiritual' });
    expect(ctx.droppedItems).toBe(0);
  });

  it('caps the fragment list and reports the overflow', () => {
    const many = Array.from({ length: 70 }, (_, i) => ({ id: `t${i}`, type: 'text', text: `note ${i}` }));
    const ctx = collectBoardStyleContext(boardWith(many));
    expect(ctx.items).toHaveLength(60);
    expect(ctx.droppedItems).toBe(10);
  });
});

describe('synthesizeBoardStyle', () => {
  it('400s a board with no synthesizable content', async () => {
    await expect(synthesizeBoardStyle({
      board: { id: 'mb-1', name: 'Empty', description: '', items: [{ id: 'i1', type: 'image', mediaKey: 'image:a.png' }] },
      providerId: 'ollama',
    })).rejects.toMatchObject({ code: 'NOTHING_TO_SYNTHESIZE', status: 400 });
    expect(promptRunner.runPromptThroughProvider).not.toHaveBeenCalled();
  });

  it('synthesizes a proposal with a reviewable diff and feeds the board content to the prompt', async () => {
    const result = await synthesizeBoardStyle({
      board: boardWith([analyzedItem]),
      styleNotes: 'Clean vector art',
      influences: { embrace: ['clean vectors'], avoid: ['grain'] },
      providerId: 'ollama',
      model: 'qwen',
    });

    const sentPrompt = promptRunner.runPromptThroughProvider.mock.calls[0][0].prompt;
    expect(sentPrompt).toContain('granular ink wash');
    expect(sentPrompt).toContain('Dusty painted sci-fi.');

    expect(result.proposed.styleNotes).toContain('Tactile ink-wash');
    expect(result.proposed.influences.embrace).toEqual(['granular ink wash', 'muted ochre']);
    expect(result.diff.hasChanges).toBe(true);
    expect(result.diff.influences.embrace.added).toContain('granular ink wash');
    expect(result.diff.influences.embrace.removed).toContain('clean vectors');
    expect(result.rationale).toContain('tactile marks');
    expect(result.llm).toMatchObject({ provider: 'ollama' });
    expect(result.context).toEqual({ items: 1, droppedItems: 0 });
  });

  it('keeps locked fields at their current values regardless of the model output', async () => {
    const result = await synthesizeBoardStyle({
      board: boardWith([analyzedItem]),
      styleNotes: 'Locked prose',
      influences: { embrace: ['keep me'], avoid: [] },
      locked: { styleNotes: true, influencesEmbrace: true },
      providerId: 'ollama',
    });
    expect(result.proposed.styleNotes).toBe('Locked prose');
    expect(result.proposed.influences.embrace).toEqual(['keep me']);
    // The avoid list is unlocked, so the model's proposal applies.
    expect(result.proposed.influences.avoid).toEqual(['glossy 3D', 'neon']);
  });

  it('502s when the model returns unparseable JSON', async () => {
    promptRunner.runPromptThroughProvider.mockResolvedValue({ text: 'not json at all' });
    await expect(synthesizeBoardStyle({
      board: boardWith([analyzedItem]),
      providerId: 'ollama',
    })).rejects.toMatchObject({ code: 'SYNTHESIS_BAD_JSON', status: 502 });
  });

  it('503s when no API provider is configured', async () => {
    aiProvider.resolveAPIProvider.mockResolvedValue(null);
    await expect(synthesizeBoardStyle({
      board: boardWith([analyzedItem]),
    })).rejects.toMatchObject({ code: 'NO_API_PROVIDER', status: 503 });
  });
});

describe('buildBoardStyleSynthesisPrompt', () => {
  it('embeds current guidance and lock state so the model can honor them', () => {
    const prompt = buildBoardStyleSynthesisPrompt({
      context: { name: 'B', description: 'd', items: [], droppedItems: 0 },
      styleNotes: 'current notes',
      influences: { embrace: ['a'], avoid: ['b'] },
      locked: { influencesAvoid: true },
    });
    expect(prompt).toContain('current notes');
    expect(prompt).toContain('influencesAvoid');
    expect(prompt).toContain('Return JSON only');
  });
});
