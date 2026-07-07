import { describe, it, expect, vi, beforeEach } from 'vitest';

// resolveAPIProvider drives provider selection; parseLLMJSON stays real so the
// JSON-parse + fence-strip path is exercised end to end.
vi.mock('../lib/aiProvider.js', async (importActual) => {
  const actual = await importActual();
  return { ...actual, resolveAPIProvider: vi.fn() };
});

// runPromptThroughProvider is the LLM boundary — mock it. assertProvider stays
// real (the typed-throw helper we want exercised).
vi.mock('../lib/promptRunner.js', async (importActual) => {
  const actual = await importActual();
  return { ...actual, runPromptThroughProvider: vi.fn() };
});

// getUniverse is the only universeBuilder surface the service touches (review-
// only — it never writes).
vi.mock('./universeBuilder.js', async (importActual) => {
  const actual = await importActual();
  return { ...actual, getUniverse: vi.fn() };
});

const aiProvider = await import('../lib/aiProvider.js');
const promptRunner = await import('../lib/promptRunner.js');
const universeBuilder = await import('./universeBuilder.js');
const {
  expandEntityFromImages, buildVisionExpandPrompt, VISION_EXPAND_MAX_IMAGES, __testing,
} = await import('./universeVisionExpand.js');

const apiProvider = { id: 'ollama', type: 'api', defaultModel: 'qwen-vl' };

// A minimal character with one populated field (role) and the rest blank.
const makeUniverse = (overrides = {}) => ({
  id: 'uni-1',
  characters: [{ id: 'chr-1', name: 'Freydis', role: 'protagonist', ...overrides }],
});

beforeEach(() => {
  vi.clearAllMocks();
  aiProvider.resolveAPIProvider.mockResolvedValue(apiProvider);
  universeBuilder.getUniverse.mockResolvedValue(makeUniverse());
  promptRunner.runPromptThroughProvider.mockResolvedValue({
    text: JSON.stringify({ pronouns: 'she/her', age: 'late 20s' }),
    runId: 'r1', model: 'qwen-vl',
  });
});

describe('buildVisionExpandPrompt', () => {
  it('asks for JSON keyed by the requested blank fields only', () => {
    const p = buildVisionExpandPrompt({ name: 'Freydis', imageCount: 1, blankFields: ['pronouns', 'colorPalette'] });
    expect(p).toMatch(/"pronouns"/);
    expect(p).toMatch(/"colorPalette"/);
    // A field NOT in blankFields shouldn't appear in the schema body.
    expect(p).not.toMatch(/"speechAccent"/);
    expect(p).toMatch(/reference image of the character "Freydis"/);
  });

  it('uses the multi-image consistent-subject framing', () => {
    const p = buildVisionExpandPrompt({ name: 'Freydis', imageCount: 3, blankFields: ['age'] });
    expect(p).toMatch(/3 reference images of the same character/);
    expect(p).toMatch(/CONSISTENT across all/);
  });

  it('offers the full field set when no blank list is given', () => {
    const p = buildVisionExpandPrompt({ imageCount: 1 });
    expect(p).toMatch(/"speechPattern"/);
    expect(p).toMatch(/"handGestures"/);
  });

  it('excludes non-visual character-framework fields from the vision prompt (#2175)', () => {
    // A vision model cannot infer Ghost/Lie/Want/Need/secrets from an image, and
    // `secrets` has no list row-shape — asking for them would invite hallucinated
    // backstory / emit `[ undefined ]`. They must never reach the vision schema,
    // in either the full-set or blank-narrowed ask.
    const full = buildVisionExpandPrompt({ imageCount: 1 });
    for (const f of ['ghost', 'wound', 'lie', 'want', 'need', 'secrets']) {
      expect(full).not.toMatch(new RegExp(`"${f}"`));
    }
    // Even when a framework field is blank (and would otherwise be "targeted"),
    // it is filtered out — while a real visual field in the same list still shows.
    const narrowed = buildVisionExpandPrompt({ imageCount: 1, blankFields: ['lie', 'secrets', 'pronouns'] });
    expect(narrowed).not.toMatch(/"lie"/);
    expect(narrowed).not.toMatch(/"secrets"/);
    expect(narrowed).toMatch(/"pronouns"/);
  });

  it('is re-exported on __testing', () => {
    expect(__testing.buildVisionExpandPrompt).toBe(buildVisionExpandPrompt);
  });
});

describe('expandEntityFromImages', () => {
  it('proposes blank-field values without writing', async () => {
    const out = await expandEntityFromImages({
      universeId: 'uni-1', entryId: 'chr-1', name: 'Freydis', screenshots: ['a.png'],
    });
    expect(out.fields).toEqual({ pronouns: 'she/her', age: 'late 20s' });
    expect(out.updatedFields).toEqual(expect.arrayContaining(['pronouns', 'age']));
    expect(out.llm).toEqual({ provider: 'ollama', model: 'qwen-vl' });
    // Review-only: the runner ran, but nothing in the service writes the universe.
    expect(promptRunner.runPromptThroughProvider).toHaveBeenCalledWith(
      expect.objectContaining({ screenshots: ['a.png'], source: 'universe-vision-expand' }),
    );
  });

  it('does not overwrite a populated field (no-clobber)', async () => {
    universeBuilder.getUniverse.mockResolvedValue(makeUniverse({ pronouns: 'they/them' }));
    promptRunner.runPromptThroughProvider.mockResolvedValue({
      text: JSON.stringify({ pronouns: 'she/her', age: 'late 20s' }), model: 'qwen-vl',
    });
    const out = await expandEntityFromImages({ universeId: 'uni-1', entryId: 'chr-1', screenshots: ['a.png'] });
    expect(out.fields).not.toHaveProperty('pronouns');
    expect(out.fields).toEqual({ age: 'late 20s' });
  });

  it('sanitizes proposed list rows and drops malformed ones', async () => {
    promptRunner.runPromptThroughProvider.mockResolvedValue({
      text: JSON.stringify({
        colorPalette: [{ name: 'rust', hex: '#b7410e', role: 'cloak' }, { hex: '#000' }],
      }),
      model: 'qwen-vl',
    });
    const out = await expandEntityFromImages({ universeId: 'uni-1', entryId: 'chr-1', screenshots: ['a.png'] });
    expect(out.fields.colorPalette).toHaveLength(1);
    expect(out.fields.colorPalette[0]).toMatchObject({ name: 'rust' });
  });

  it('short-circuits a locked character with no LLM call', async () => {
    universeBuilder.getUniverse.mockResolvedValue(makeUniverse({ locked: true }));
    const out = await expandEntityFromImages({ universeId: 'uni-1', entryId: 'chr-1', screenshots: ['a.png'] });
    expect(out).toMatchObject({ locked: true, updatedFields: [] });
    expect(promptRunner.runPromptThroughProvider).not.toHaveBeenCalled();
  });

  it('404s when the character is not in the universe', async () => {
    await expect(expandEntityFromImages({ universeId: 'uni-1', entryId: 'nope', screenshots: ['a.png'] }))
      .rejects.toMatchObject({ code: 'UNIVERSE_CANON_NOT_FOUND', status: 404 });
  });

  it('throws NO_API_PROVIDER (503) when no API provider is configured', async () => {
    aiProvider.resolveAPIProvider.mockResolvedValue(null);
    await expect(expandEntityFromImages({ universeId: 'uni-1', entryId: 'chr-1', screenshots: ['a.png'] }))
      .rejects.toMatchObject({ code: 'NO_API_PROVIDER', status: 503 });
    expect(promptRunner.runPromptThroughProvider).not.toHaveBeenCalled();
  });

  it('rejects (VISION_FALLBACK_DROPPED_IMAGES) on a fallback to a non-API provider', async () => {
    promptRunner.runPromptThroughProvider.mockResolvedValue({
      text: '{}', model: 'sonnet', usedFallback: true, fallbackProvider: { id: 'claude-code', type: 'cli' },
    });
    await expect(expandEntityFromImages({ universeId: 'uni-1', entryId: 'chr-1', screenshots: ['a.png'] }))
      .rejects.toMatchObject({ code: 'VISION_FALLBACK_DROPPED_IMAGES', status: 502 });
  });

  it('rejects bad JSON (UNIVERSE_VISION_EXPAND_BAD_JSON 502)', async () => {
    promptRunner.runPromptThroughProvider.mockResolvedValue({ text: 'not json at all', model: 'qwen-vl' });
    await expect(expandEntityFromImages({ universeId: 'uni-1', entryId: 'chr-1', screenshots: ['a.png'] }))
      .rejects.toMatchObject({ code: 'UNIVERSE_VISION_EXPAND_BAD_JSON', status: 502 });
  });

  it('rejects a JSON array (non-object) response', async () => {
    promptRunner.runPromptThroughProvider.mockResolvedValue({ text: '[1,2,3]', model: 'qwen-vl' });
    await expect(expandEntityFromImages({ universeId: 'uni-1', entryId: 'chr-1', screenshots: ['a.png'] }))
      .rejects.toMatchObject({ code: 'UNIVERSE_VISION_EXPAND_BAD_JSON', status: 502 });
  });

  it('rejects when no images are supplied', async () => {
    await expect(expandEntityFromImages({ universeId: 'uni-1', entryId: 'chr-1', screenshots: [] }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR', status: 400 });
  });

  it(`rejects more than ${VISION_EXPAND_MAX_IMAGES} images`, async () => {
    const tooMany = Array.from({ length: VISION_EXPAND_MAX_IMAGES + 1 }, (_, i) => `${i}.png`);
    await expect(expandEntityFromImages({ universeId: 'uni-1', entryId: 'chr-1', screenshots: tooMany }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR', status: 400 });
  });
});
