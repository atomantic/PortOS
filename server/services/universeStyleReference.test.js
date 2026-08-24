import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./aiProvider.js', async (importActual) => {
  const actual = await importActual();
  return { ...actual, resolveAPIProvider: vi.fn() };
});
vi.mock('../lib/promptRunner.js', async (importActual) => {
  const actual = await importActual();
  return { ...actual, runPromptThroughProvider: vi.fn() };
});

const aiProvider = await import('./aiProvider.js');
const promptRunner = await import('../lib/promptRunner.js');
const {
  analyzeUniverseStyleReference,
  buildStyleReferenceDiff,
  buildStyleReferencePrompt,
} = await import('./universeStyleReference.js');

const apiProvider = { id: 'ollama', type: 'api', defaultModel: 'qwen-vl' };
const analysisText = JSON.stringify({
  title: 'Dust-lit ink wash',
  prompt: 'A weathered city rendered in granular ink wash and muted ochre.',
  styleNotes: 'Tactile ink-wash science fiction with restrained, dusty light.',
  influences: {
    embrace: ['granular ink wash', 'muted ochre', 'weathered silhouettes'],
    avoid: ['glossy 3D', 'neon'],
  },
  rationale: 'The image replaces polish with tactile marks and restrained color.',
});

beforeEach(() => {
  vi.clearAllMocks();
  aiProvider.resolveAPIProvider.mockResolvedValue(apiProvider);
  promptRunner.runPromptThroughProvider.mockResolvedValue({
    text: analysisText,
    model: 'qwen-vl',
  });
});

describe('universeStyleReference', () => {
  it('analyzes the image and returns a reference plus a reviewable diff', async () => {
    const result = await analyzeUniverseStyleReference({
      imagePath: '/mock/images/reference.png',
      imageFilename: 'reference.png',
      styleNotes: 'Clean vector art',
      influences: { embrace: ['clean vectors'], avoid: ['grain'] },
      model: 'qwen-vl',
    });

    expect(result.reference).toMatchObject({
      title: 'Dust-lit ink wash',
      prompt: expect.stringContaining('granular ink wash'),
      imageRefs: ['reference.png'],
    });
    expect(result.reference.id).toMatch(/^style-ref-/);
    expect(result.diff).toMatchObject({
      hasChanges: true,
      influences: {
        embrace: { added: ['granular ink wash', 'muted ochre', 'weathered silhouettes'], removed: ['clean vectors'] },
        avoid: { added: ['glossy 3D', 'neon'], removed: ['grain'] },
      },
    });
    expect(promptRunner.runPromptThroughProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        screenshots: ['/mock/images/reference.png'],
        source: 'universe-style-reference',
      }),
    );
  });

  it('preserves user-supplied metadata and locked guidance', async () => {
    const result = await analyzeUniverseStyleReference({
      imagePath: '/mock/images/reference.png',
      imageFilename: 'reference.png',
      title: 'My title',
      prompt: 'My exact recreation prompt',
      styleNotes: 'Pinned prose',
      influences: { embrace: ['pinned positive'], avoid: ['pinned negative'] },
      locked: { styleNotes: true, influencesEmbrace: true, influencesAvoid: true },
    });

    expect(result.reference).toMatchObject({
      title: 'My title',
      prompt: 'My exact recreation prompt',
    });
    expect(result.proposed).toEqual({
      styleNotes: 'Pinned prose',
      influences: { embrace: ['pinned positive'], avoid: ['pinned negative'] },
    });
    expect(result.diff.hasChanges).toBe(false);
  });

  it('distinguishes an explicit empty recommendation from an omitted list', async () => {
    promptRunner.runPromptThroughProvider.mockResolvedValue({
      text: JSON.stringify({
        title: 'Reference',
        prompt: 'Prompt',
        styleNotes: 'Notes',
        influences: { embrace: [] },
      }),
    });
    const result = await analyzeUniverseStyleReference({
      imagePath: '/mock/reference.png',
      imageFilename: 'reference.png',
      influences: { embrace: ['remove me'], avoid: ['preserve me'] },
    });
    expect(result.proposed.influences).toEqual({ embrace: [], avoid: ['preserve me'] });
  });

  it('rejects invalid JSON and vision runs that dropped the image', async () => {
    promptRunner.runPromptThroughProvider.mockResolvedValueOnce({ text: 'not json' });
    await expect(analyzeUniverseStyleReference({
      imagePath: '/mock/reference.png',
      imageFilename: 'reference.png',
    })).rejects.toMatchObject({ code: 'VISION_BAD_JSON', status: 502 });

    promptRunner.runPromptThroughProvider.mockResolvedValueOnce({
      text: analysisText,
      provider: { id: 'cli-provider', type: 'cli' },
    });
    await expect(analyzeUniverseStyleReference({
      imagePath: '/mock/reference.png',
      imageFilename: 'reference.png',
    })).rejects.toMatchObject({ code: 'VISION_FALLBACK_DROPPED_IMAGES', status: 502 });
  });

  it('builds deterministic list and prose diffs', () => {
    expect(buildStyleReferenceDiff(
      { styleNotes: 'before', influences: { embrace: ['A'], avoid: [] } },
      { styleNotes: 'after', influences: { embrace: ['A', 'B'], avoid: [] } },
    )).toMatchObject({
      hasChanges: true,
      styleNotes: { before: 'before', after: 'after', changed: true },
      influences: { embrace: { added: ['B'], removed: [] } },
    });
  });

  it('embeds supplied metadata and locks as JSON context', () => {
    const prompt = buildStyleReferencePrompt({
      title: 'Reference',
      prompt: '',
      styleNotes: 'Notes',
      influences: { embrace: ['ink'], avoid: [] },
      locked: { styleNotes: true },
    });
    expect(prompt).toContain('"suppliedTitle":"Reference"');
    expect(prompt).toContain('"locked":{"styleNotes":true}');
  });
});
