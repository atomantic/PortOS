/**
 * Unit tests for catalogExtraction — bibleExtractor + stageRunner are both
 * mocked so this test stays pure (no LLM call). Asserts:
 *   - Stage list covers the three bible kinds + one bundled light stage
 *   - Each stage emits running → completed progress frames
 *   - Failures isolate (one kind's throw doesn't poison the rest)
 *   - The returned draft groups extracted entries under the right field key
 *   - The bundled light stage splits its LLM response into ideas/scenes/concepts
 *   - Light-shape entries are sanitized (drops nameless rows, caps fields)
 *   - Triple-backtick fences in user paste are neutralized before reaching
 *     extractBible (so a paste containing ``` can't close the prompt fence)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/bibleExtractor.js', () => ({
  extractBible: vi.fn(),
}));
vi.mock('../lib/stageRunner.js', () => ({
  runStagedLLM: vi.fn(),
}));
// catalogDB pulls in the Postgres pool — mock just the one function the
// extractor consumes so scanProseForIngredientRefs stays a pure unit test.
vi.mock('./catalogDB.js', () => ({
  listIngredientsForRef: vi.fn(),
  getScrap: vi.fn(),
  listChildScraps: vi.fn(),
}));

const bibleExtractor = await import('../lib/bibleExtractor.js');
const stageRunner = await import('../lib/stageRunner.js');
const catalogDB = await import('./catalogDB.js');
const { catalogEvents } = await import('./catalogEvents.js');
const {
  extractIngredients,
  extractIngredientsForScrap,
  dedupDrafts,
  EXTRACTION_STAGES,
  scanProseForIngredientRefs,
} = await import('./catalogExtraction.js');

const emptyLightResponse = { content: { ideas: [], scenes: [], concepts: [] } };

beforeEach(() => {
  vi.clearAllMocks();
  // Default: the light stage returns nothing unless the test overrides.
  stageRunner.runStagedLLM.mockResolvedValue(emptyLightResponse);
});

describe('catalogExtraction — stage shape', () => {
  it('covers the three bible kinds + one bundled light stage', () => {
    const ids = EXTRACTION_STAGES.map((s) => s.id);
    expect(ids).toEqual(['characters', 'places', 'objects', 'ideasScenesConcepts']);
    // The bible stages carry a `kind`; the bundled light stage does not.
    const bibleKinds = EXTRACTION_STAGES.filter((s) => s.kind).map((s) => s.kind);
    expect(bibleKinds.sort()).toEqual(['character', 'object', 'place']);
  });
});

describe('catalogExtraction — extractIngredients', () => {
  it('rejects an empty corpus before any LLM call', async () => {
    await expect(extractIngredients({ rawText: '   ' })).rejects.toThrow(/rawText is required/);
    expect(bibleExtractor.extractBible).not.toHaveBeenCalled();
    expect(stageRunner.runStagedLLM).not.toHaveBeenCalled();
  });

  it('runs every bible stage in parallel and groups results under the BIBLE_FIELD key', async () => {
    bibleExtractor.extractBible.mockImplementation(async ({ kind }) => ({
      extracted: [{ name: `${kind}-1` }],
    }));

    const out = await extractIngredients({ rawText: 'long prose', scrapId: 'cat-scrap-x' });
    expect(out).toHaveProperty('runId');
    expect(out.characters).toEqual([{ name: 'character-1' }]);
    expect(out.places).toEqual([{ name: 'place-1' }]);
    expect(out.objects).toEqual([{ name: 'object-1' }]);
    // Bible stages report count=1; the (unused) light stage reports 0.
    const bibleStages = out.stages.filter((s) => s.id !== 'ideasScenesConcepts');
    expect(bibleStages.every((s) => s.status === 'completed' && s.count === 1)).toBe(true);
  });

  it('isolates per-stage failures — one kind throwing does not block the others', async () => {
    bibleExtractor.extractBible.mockImplementation(async ({ kind }) => {
      if (kind === 'place') throw new Error('llm timeout');
      return { extracted: [{ name: `${kind}-ok` }] };
    });

    const out = await extractIngredients({ rawText: 'prose' });
    expect(out.places).toEqual([]);
    expect(out.characters).toEqual([{ name: 'character-ok' }]);
    expect(out.objects).toEqual([{ name: 'object-ok' }]);
    const placeStage = out.stages.find((s) => s.id === 'places');
    expect(placeStage.status).toBe('failed');
    expect(placeStage.error).toBe('llm timeout');
  });

  it('emits a start frame listing every stage, then per-stage running/completed frames', async () => {
    const frames = [];
    const listener = (frame) => frames.push(frame);
    catalogEvents.on('progress', listener);

    bibleExtractor.extractBible.mockResolvedValue({ extracted: [] });

    await extractIngredients({ rawText: 'prose', scrapId: 'cat-scrap-y' });

    catalogEvents.off('progress', listener);

    const start = frames.find((f) => f.type === 'start');
    expect(start).toBeTruthy();
    expect(start.stages.map((s) => s.id)).toEqual(
      ['characters', 'places', 'objects', 'ideasScenesConcepts'],
    );

    // Each stage gets both a `running` and a `completed` frame, scoped to the
    // same runId + scrapId pair so the UI can demultiplex parallel extractions.
    for (const id of ['characters', 'places', 'objects', 'ideasScenesConcepts']) {
      const running = frames.find((f) => f.type === 'stage' && f.id === id && f.status === 'running');
      const done = frames.find((f) => f.type === 'stage' && f.id === id && f.status === 'completed');
      expect(running, `missing running frame for ${id}`).toBeTruthy();
      expect(done, `missing completed frame for ${id}`).toBeTruthy();
      expect(running.scrapId).toBe('cat-scrap-y');
      expect(done.scrapId).toBe('cat-scrap-y');
    }
  });

  it('forwards providerOverride to every stage', async () => {
    bibleExtractor.extractBible.mockResolvedValue({ extracted: [] });
    await extractIngredients({ rawText: 'prose', providerOverride: 'codex' });
    for (const call of bibleExtractor.extractBible.mock.calls) {
      expect(call[0].providerOverride).toBe('codex');
    }
    // The light stage also receives the override (third positional arg).
    expect(stageRunner.runStagedLLM).toHaveBeenCalledWith(
      'catalog-ideas-scenes-concepts',
      expect.any(Object),
      expect.objectContaining({ providerOverride: 'codex' }),
    );
  });

  it('neutralizes ``` in user paste so the prompt fence cannot be closed early', async () => {
    bibleExtractor.extractBible.mockResolvedValue({ extracted: [] });

    const evil = 'before\n```\ninjected content\n```\nafter';
    await extractIngredients({ rawText: evil });

    // Every bible stage AND the light stage receive the SAME neutralized
    // corpus (parallel passes).
    for (const call of bibleExtractor.extractBible.mock.calls) {
      const corpus = call[0].corpus;
      expect(corpus).not.toContain('```');
      expect(corpus).toContain('injected content');
    }
    const lightCall = stageRunner.runStagedLLM.mock.calls[0];
    expect(lightCall[1].draftBody).not.toContain('```');
    expect(lightCall[1].draftBody).toContain('injected content');
  });

  it('neutralizes runs of 4+ backticks (regression: naive /```/g replacement leaves a triple in the output)', async () => {
    bibleExtractor.extractBible.mockResolvedValue({ extracted: [] });
    // 4, 5, 6 backtick runs — each was a hole in the original regex.
    const evil = 'a\n````\nb\n`````\nc\n``````\nd';
    await extractIngredients({ rawText: evil });
    for (const call of bibleExtractor.extractBible.mock.calls) {
      expect(call[0].corpus).not.toContain('```');
    }
    expect(stageRunner.runStagedLLM.mock.calls[0][1].draftBody).not.toContain('```');
  });

  it('returns a fresh runId per call (no carry-over)', async () => {
    bibleExtractor.extractBible.mockResolvedValue({ extracted: [] });
    const a = await extractIngredients({ rawText: 'prose' });
    const b = await extractIngredients({ rawText: 'prose' });
    expect(a.runId).not.toBe(b.runId);
  });
});

describe('catalogExtraction — bundled light stage', () => {
  it('splits the single LLM response into ideas/scenes/concepts arrays', async () => {
    bibleExtractor.extractBible.mockResolvedValue({ extracted: [] });
    stageRunner.runStagedLLM.mockResolvedValue({
      content: {
        ideas:    [{ name: 'Inherited memory', summary: 'What if memory was genetic?' }],
        scenes:   [{ name: 'Diner 3am', summary: 'Two friends at a 3am diner.', setting: 'a diner', actors: ['friend A', 'friend B'] }],
        concepts: [{ name: 'Sleep magic', summary: 'Spells cost sleep.', kind: 'magic-system' }],
      },
    });
    const out = await extractIngredients({ rawText: 'prose' });
    expect(out.ideas).toHaveLength(1);
    expect(out.ideas[0]).toMatchObject({ name: 'Inherited memory', summary: 'What if memory was genetic?' });
    expect(out.scenes).toHaveLength(1);
    expect(out.scenes[0]).toMatchObject({ name: 'Diner 3am', setting: 'a diner', actors: ['friend A', 'friend B'] });
    expect(out.concepts).toHaveLength(1);
    // The LLM's `kind` field is preserved verbatim on payload — payload is
    // a JSONB column, so it doesn't collide with the row-level `type`.
    expect(out.concepts[0]).toMatchObject({ name: 'Sleep magic', kind: 'magic-system' });
  });

  it('reports a combined count (ideas + scenes + concepts) on the light stage', async () => {
    bibleExtractor.extractBible.mockResolvedValue({ extracted: [] });
    stageRunner.runStagedLLM.mockResolvedValue({
      content: {
        ideas:    [{ name: 'a' }, { name: 'b' }],
        scenes:   [{ name: 'c' }],
        concepts: [{ name: 'd' }, { name: 'e' }, { name: 'f' }],
      },
    });
    const out = await extractIngredients({ rawText: 'prose' });
    const lightStage = out.stages.find((s) => s.id === 'ideasScenesConcepts');
    expect(lightStage.count).toBe(6);
    expect(lightStage.status).toBe('completed');
  });

  it('drops rows missing a name and caps long fields', async () => {
    bibleExtractor.extractBible.mockResolvedValue({ extracted: [] });
    const longSummary = 'x'.repeat(5000);
    stageRunner.runStagedLLM.mockResolvedValue({
      content: {
        ideas: [
          { name: '', summary: 'nameless' },          // dropped
          { summary: 'still nameless' },              // dropped
          null,                                       // dropped (non-object)
          { name: 'Keeper', summary: longSummary },   // kept, summary capped
        ],
        scenes: [],
        concepts: [],
      },
    });
    const out = await extractIngredients({ rawText: 'prose' });
    expect(out.ideas).toHaveLength(1);
    expect(out.ideas[0].name).toBe('Keeper');
    expect(out.ideas[0].summary.length).toBeLessThanOrEqual(2000);
  });

  it('a malformed light response (non-array `ideas`) yields empty arrays — never poisons the rest', async () => {
    bibleExtractor.extractBible.mockResolvedValue({ extracted: [{ name: 'A' }] });
    stageRunner.runStagedLLM.mockResolvedValue({ content: { ideas: 'oops' } });
    const out = await extractIngredients({ rawText: 'prose' });
    expect(out.ideas).toEqual([]);
    expect(out.scenes).toEqual([]);
    expect(out.concepts).toEqual([]);
    expect(out.characters).toEqual([{ name: 'A' }]); // bible stage unaffected
    const lightStage = out.stages.find((s) => s.id === 'ideasScenesConcepts');
    expect(lightStage.status).toBe('completed');
    expect(lightStage.count).toBe(0);
  });

  it('isolates a thrown LLM error from the bible passes', async () => {
    bibleExtractor.extractBible.mockResolvedValue({ extracted: [{ name: 'A' }] });
    stageRunner.runStagedLLM.mockRejectedValue(new Error('provider down'));
    const out = await extractIngredients({ rawText: 'prose' });
    expect(out.characters).toEqual([{ name: 'A' }]);
    expect(out.ideas).toEqual([]);
    const lightStage = out.stages.find((s) => s.id === 'ideasScenesConcepts');
    expect(lightStage.status).toBe('failed');
    expect(lightStage.error).toBe('provider down');
  });
});

describe('catalogExtraction — dedupDrafts', () => {
  it('unions per-child draft arrays under each type key', () => {
    const merged = dedupDrafts([
      { characters: [{ name: 'Alice' }], ideas: [{ name: 'Memory genes' }] },
      { characters: [{ name: 'Bob' }], scenes: [{ name: 'Rooftop' }] },
    ]);
    expect(merged.characters.map((c) => c.name)).toEqual(['Alice', 'Bob']);
    expect(merged.ideas.map((c) => c.name)).toEqual(['Memory genes']);
    expect(merged.scenes.map((c) => c.name)).toEqual(['Rooftop']);
  });

  it('dedups by name+type keeping the FIRST occurrence (case-insensitive)', () => {
    const merged = dedupDrafts([
      { characters: [{ name: 'Echo', summary: 'first' }] },
      { characters: [{ name: 'echo', summary: 'second' }, { name: 'Nova' }] },
    ]);
    expect(merged.characters).toHaveLength(2);
    expect(merged.characters[0]).toMatchObject({ name: 'Echo', summary: 'first' });
    expect(merged.characters[1]).toMatchObject({ name: 'Nova' });
  });

  it('a same name under DIFFERENT type keys is NOT a dup', () => {
    const merged = dedupDrafts([
      { characters: [{ name: 'Harbor' }], places: [{ name: 'Harbor' }] },
    ]);
    expect(merged.characters).toHaveLength(1);
    expect(merged.places).toHaveLength(1);
  });

  it('tolerates missing / non-array keys and nameless entries', () => {
    const merged = dedupDrafts([
      { characters: 'oops', ideas: [{ name: '' }, { summary: 'no name' }, null] },
      null,
      undefined,
    ]);
    expect(merged.characters).toEqual([]);
    expect(merged.ideas).toEqual([]);
  });
});

describe('catalogExtraction — extractIngredientsForScrap', () => {
  it('falls back to a single extraction when the scrap has no children', async () => {
    catalogDB.getScrap.mockResolvedValue({ id: 'cat-scrap-p', rawText: 'whole text', parentScrapId: null });
    catalogDB.listChildScraps.mockResolvedValue([]);
    bibleExtractor.extractBible.mockImplementation(async ({ kind, corpus }) => ({
      extracted: [{ name: `${kind}:${corpus}` }],
    }));

    const out = await extractIngredientsForScrap({ scrapId: 'cat-scrap-p' });
    expect(catalogDB.listChildScraps).toHaveBeenCalledWith('cat-scrap-p');
    // Single pass over the parent's full text.
    expect(bibleExtractor.extractBible).toHaveBeenCalledTimes(3); // 3 bible kinds, one pass
    expect(out.characters).toEqual([{ name: 'character:whole text' }]);
  });

  it('runs per-child and unions the drafts (dedup by name+type, keep first)', async () => {
    catalogDB.getScrap.mockResolvedValue({ id: 'cat-scrap-p', rawText: 'A|B', parentScrapId: null });
    catalogDB.listChildScraps.mockResolvedValue([
      { id: 'cat-scrap-c1', rawText: 'chunkA', chunkIndex: 1, parentScrapId: 'cat-scrap-p' },
      { id: 'cat-scrap-c2', rawText: 'chunkB', chunkIndex: 2, parentScrapId: 'cat-scrap-p' },
    ]);
    // Both chunks surface a 'Shared' character; chunk B adds 'OnlyB'.
    bibleExtractor.extractBible.mockImplementation(async ({ kind, corpus }) => {
      if (kind !== 'character') return { extracted: [] };
      if (corpus === 'chunkA') return { extracted: [{ name: 'Shared', summary: 'fromA' }] };
      return { extracted: [{ name: 'Shared', summary: 'fromB' }, { name: 'OnlyB' }] };
    });

    const out = await extractIngredientsForScrap({ scrapId: 'cat-scrap-p' });
    // bible called once per kind per child (3 kinds × 2 children).
    expect(bibleExtractor.extractBible).toHaveBeenCalledTimes(6);
    expect(out.characters.map((c) => c.name)).toEqual(['Shared', 'OnlyB']);
    // First occurrence wins — chunk A's summary, not chunk B's.
    expect(out.characters[0].summary).toBe('fromA');
  });

  it('a stage failing in only ONE child is not marked failed overall', async () => {
    catalogDB.getScrap.mockResolvedValue({ id: 'cat-scrap-p', rawText: 'x', parentScrapId: null });
    catalogDB.listChildScraps.mockResolvedValue([
      { id: 'c1', rawText: 'chunkA', chunkIndex: 1, parentScrapId: 'cat-scrap-p' },
      { id: 'c2', rawText: 'chunkB', chunkIndex: 2, parentScrapId: 'cat-scrap-p' },
    ]);
    bibleExtractor.extractBible.mockImplementation(async ({ kind, corpus }) => {
      if (kind === 'place' && corpus === 'chunkA') throw new Error('llm timeout');
      return { extracted: kind === 'place' ? [{ name: 'Harbor' }] : [] };
    });

    const out = await extractIngredientsForScrap({ scrapId: 'cat-scrap-p' });
    const placeStage = out.stages.find((s) => s.id === 'places');
    // chunk B's success clears the failed flag.
    expect(placeStage.status).toBe('completed');
    expect(out.places.map((p) => p.name)).toEqual(['Harbor']);
  });

  it('throws when the scrap does not exist', async () => {
    catalogDB.getScrap.mockResolvedValue(null);
    await expect(extractIngredientsForScrap({ scrapId: 'missing' }))
      .rejects.toThrow(/not found/);
  });
});

describe('catalogExtraction — scanProseForIngredientRefs', () => {
  // Build the { ingredient, role } row shape listIngredientsForRef returns.
  const row = (id, name) => ({ ingredient: { id, name }, role: 'cast' });

  it('returns [] for empty / non-string prose without querying the DB', async () => {
    expect(await scanProseForIngredientRefs('', { workId: 'wr-work-1' })).toEqual([]);
    expect(await scanProseForIngredientRefs('   ', { workId: 'wr-work-1' })).toEqual([]);
    expect(await scanProseForIngredientRefs(null, { workId: 'wr-work-1' })).toEqual([]);
    expect(catalogDB.listIngredientsForRef).not.toHaveBeenCalled();
  });

  it('returns [] when no scope target is provided (nothing to scope to)', async () => {
    expect(await scanProseForIngredientRefs('Mira walked in.', {})).toEqual([]);
    expect(catalogDB.listIngredientsForRef).not.toHaveBeenCalled();
  });

  it('ignores unknown / non-string scope ids', async () => {
    // Only the three known kinds (universe/series/work) are honored, and each
    // must be a non-empty string.
    expect(await scanProseForIngredientRefs('text', { workId: 42, foo: 'bar' })).toEqual([]);
    expect(await scanProseForIngredientRefs('text', { universeId: '  ' })).toEqual([]);
    expect(catalogDB.listIngredientsForRef).not.toHaveBeenCalled();
  });

  it('matches ingredient names as case-insensitive word-boundary matches (incl. multi-word phrases)', async () => {
    catalogDB.listIngredientsForRef.mockResolvedValue([
      row('cat-chr-mira', 'Mira'),
      row('cat-chr-tomas', 'Tomas'),
      row('cat-plc-harbor', 'The Drowned Harbor'),
    ]);
    const prose = 'mira crossed the drowned harbor at dawn, alone.';
    const ids = await scanProseForIngredientRefs(prose, { workId: 'wr-work-1' });
    // Mira (lowercased) + the multi-word phrase "The Drowned Harbor" match;
    // Tomas does not. Sorted.
    expect(ids).toEqual(['cat-chr-mira', 'cat-plc-harbor'].sort());
    expect(catalogDB.listIngredientsForRef).toHaveBeenCalledWith('work', 'wr-work-1');
  });

  it('does not false-positive a short name embedded inside a larger word', async () => {
    catalogDB.listIngredientsForRef.mockResolvedValue([
      row('cat-chr-sun', 'Sun'),
      row('cat-chr-al', 'Al'),
    ]);
    // "Sunday" contains "Sun" and "always" contains "Al", but neither is a
    // real reference — word-boundary matching must reject both.
    const ids = await scanProseForIngredientRefs('On Sunday she always waited.', { workId: 'wr-work-1' });
    expect(ids).toEqual([]);
  });

  it('matches a short name when it appears as a whole word', async () => {
    catalogDB.listIngredientsForRef.mockResolvedValue([row('cat-chr-sun', 'Sun')]);
    const ids = await scanProseForIngredientRefs('The Sun rose over the bay.', { workId: 'wr-work-1' });
    expect(ids).toEqual(['cat-chr-sun']);
  });

  it('scopes candidates to the linked refs — never an arbitrary catalog row', async () => {
    // listIngredientsForRef is the only candidate source, so a name that isn't
    // in the linked cast simply never enters the match set.
    catalogDB.listIngredientsForRef.mockResolvedValue([row('cat-chr-mira', 'Mira')]);
    const ids = await scanProseForIngredientRefs('Mira and Galadriel spoke.', { workId: 'wr-work-1' });
    expect(ids).toEqual(['cat-chr-mira']); // Galadriel is not linked → not returned
  });

  it('unions candidates across multiple scope targets and de-dupes by id', async () => {
    catalogDB.listIngredientsForRef.mockImplementation(async (kind) => {
      if (kind === 'universe') return [row('cat-chr-mira', 'Mira'), row('cat-chr-shared', 'Shared')];
      if (kind === 'work') return [row('cat-chr-shared', 'Shared'), row('cat-chr-tomas', 'Tomas')];
      return [];
    });
    const ids = await scanProseForIngredientRefs('Mira, Shared, and Tomas all appear.', {
      universeId: 'u-1', workId: 'wr-work-1',
    });
    // Shared appears in both refs but is returned once. All three matched.
    expect(ids).toEqual(['cat-chr-mira', 'cat-chr-shared', 'cat-chr-tomas'].sort());
    expect(catalogDB.listIngredientsForRef).toHaveBeenCalledTimes(2);
  });

  it('returns [] when the linked cast is empty', async () => {
    catalogDB.listIngredientsForRef.mockResolvedValue([]);
    expect(await scanProseForIngredientRefs('Some prose.', { workId: 'wr-work-1' })).toEqual([]);
  });

  it('skips candidate rows missing an id or name', async () => {
    catalogDB.listIngredientsForRef.mockResolvedValue([
      { ingredient: { id: 'cat-chr-noname' }, role: 'cast' },     // no name → skipped
      { ingredient: { name: 'Nameless appears' }, role: 'cast' }, // no id → skipped
      row('cat-chr-real', 'Real'),
    ]);
    const ids = await scanProseForIngredientRefs('Real and Nameless appears here.', { workId: 'wr-work-1' });
    expect(ids).toEqual(['cat-chr-real']);
  });

  it('returns a sorted, de-duplicated id list', async () => {
    catalogDB.listIngredientsForRef.mockResolvedValue([
      row('cat-z', 'Zed'),
      row('cat-a', 'Ada'),
      row('cat-m', 'Mira'),
    ]);
    const ids = await scanProseForIngredientRefs('Zed, Ada, and Mira.', { workId: 'wr-work-1' });
    expect(ids).toEqual(['cat-a', 'cat-m', 'cat-z']);
  });
});
