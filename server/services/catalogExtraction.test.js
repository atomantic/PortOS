import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { applyTemplate } from '../lib/promptTemplate.js';
import { withCreativeLatitude, CREATIVE_LATITUDE_HEADING } from '../lib/creativeLatitude.js';
import { estimateTokens } from '../lib/contextBudget.js';
import { neutralizeFences } from '../lib/promptFencing.js';
import { catalogScrapCommitSchema } from '../lib/catalogValidation.js';

vi.mock('./stageRunner.js', () => ({ resolveStageContext: vi.fn(), runStageScopedInlineLLM: vi.fn() }));
vi.mock('./promptService.js', () => ({ buildPrompt: vi.fn() }));
vi.mock('./catalogDB.js', () => ({ getScrap: vi.fn(), listChildScraps: vi.fn(), listIngredientsForRef: vi.fn(), createIngredient: vi.fn() }));
const stageRunner = await import('./stageRunner.js');
const prompts = await import('./promptService.js');
const catalogDB = await import('./catalogDB.js');
const { catalogEvents } = await import('./catalogEvents.js');
const { extractIngredients, extractIngredientsForScrap, scanProseForIngredientRefs } = await import('./catalogExtraction.js');
const template = readFileSync(new URL('../../data.reference/prompts/stages/catalog-extract.md', import.meta.url), 'utf8');
const empty = () => ({ characters: [], places: [], objects: [], ideas: [], scenes: [], concepts: [], relationships: [] });
const route = (contextWindow = 64000) => ({ provider: { id: 'example-provider' }, model: 'example-model', contextWindow });
const story = 'Example Owner owns the pistol inherited from her aunt. At Example Station she lends it to Example Companion, who uses it to signal the last train. A paper cup sits nearby. What if memory could be inherited? In this world memory is currency.';
const storyGraph = () => ({
  characters: [
    { draftId: 'owner', name: 'Example Owner', background: 'Inherited the pistol from her aunt.', evidence: ['Example Owner owns the pistol inherited from her aunt.'] },
    { draftId: 'companion', name: 'Example Companion', evidence: ['Example Companion, who uses it to signal the last train.'] },
  ],
  places: [{ draftId: 'station', name: 'Example Station', evidence: ['At Example Station'] }],
  objects: [{ draftId: 'pistol', name: 'Inherited pistol', aliases: ['the pistol'], sourceIdentity: 'the pistol inherited from her aunt', description: 'An inherited pistol lent to a companion.', significance: 'Inheritance and the last train signal.', evidence: ['Example Owner owns the pistol inherited from her aunt.'] }],
  ideas: [{ draftId: 'idea', name: 'Inherited memory', summary: 'A question about inherited memory.', evidence: 'What if memory could be inherited?' }],
  scenes: [{ draftId: 'scene', name: 'Signal the last train', summary: 'The companion uses the lent pistol to signal.', setting: 'Example Station', actors: ['Example Owner', 'Example Companion'], evidence: 'At Example Station she lends it to Example Companion, who uses it to signal the last train.' }],
  concepts: [{ draftId: 'concept', name: 'Memory currency', summary: 'Memory is currency.', kind: 'rule', evidence: 'In this world memory is currency.' }],
  relationships: [
    { fromDraftId: 'pistol', toDraftId: 'owner', kind: 'owned-by', evidence: 'Example Owner owns the pistol inherited from her aunt.' },
    { fromDraftId: 'pistol', toDraftId: 'companion', kind: 'used-by', evidence: 'she lends it to Example Companion, who uses it to signal the last train.' },
    { fromDraftId: 'pistol', toDraftId: 'scene', kind: 'appears-in', evidence: 'Example Companion, who uses it to signal the last train.' },
    { fromDraftId: 'scene', toDraftId: 'station', kind: 'appears-in', evidence: 'At Example Station she lends it to Example Companion' },
  ],
});

beforeEach(() => {
  vi.resetAllMocks();
  stageRunner.resolveStageContext.mockResolvedValue(route());
  stageRunner.runStageScopedInlineLLM.mockResolvedValue({ content: JSON.stringify(empty()) });
  prompts.buildPrompt.mockImplementation(async (_name, variables) => withCreativeLatitude(applyTemplate(template, variables)));
});

describe('catalog extraction workflow', () => {
  it('extracts six types and the grounded ownership/use/scene graph with one call and no saves', async () => {
    stageRunner.runStageScopedInlineLLM.mockResolvedValue({ content: JSON.stringify(storyGraph()) });
    const out = await extractIngredients({ rawText: story, scrapId: 'example-scrap', providerOverride: 'chosen', modelOverride: 'chosen-model' });
    expect(stageRunner.runStageScopedInlineLLM).toHaveBeenCalledTimes(1);
    expect(stageRunner.resolveStageContext).toHaveBeenCalledWith('catalog-extract', { providerOverride: 'chosen', modelOverride: 'chosen-model' });
    const [stage, prompt, options] = stageRunner.runStageScopedInlineLLM.mock.calls[0];
    expect(stage).toBe('catalog-extract');
    expect(options).toMatchObject({ providerOverride: 'example-provider', modelOverride: 'example-model', allowFallback: false, returnsJson: false, maxTokens: 8000 });
    expect(prompt).toContain(CREATIVE_LATITUDE_HEADING);
    expect(prompt).toContain('Omit incidental generic props');
    expect(prompt).toContain('does NOT establish ownership');
    expect(out.coverage.status).toBe('complete');
    for (const key of Object.keys(empty()).filter(key => key !== 'relationships')) expect(out[key].length).toBeGreaterThan(0);
    expect(out.objects).toHaveLength(1);
    expect(out.objects[0]).toMatchObject({ name: 'Inherited pistol', significance: 'Inheritance and the last train signal.' });
    const objectId = out.objects[0].draftId;
    expect(out.relationships).toContainEqual(expect.objectContaining({ fromDraftId: objectId, toDraftId: out.characters[0].draftId, kind: 'owned-by' }));
    expect(out.relationships).toContainEqual(expect.objectContaining({ fromDraftId: objectId, toDraftId: out.characters[1].draftId, kind: 'used-by' }));
    const accepted = ['characters', 'places', 'objects', 'ideas', 'scenes', 'concepts'].flatMap(key =>
      out[key].map(({ draftId, sourceIdentity: _identity, name, tags, ...payload }) => ({
        draftId, type: key.slice(0, -1), name, tags, payload,
      })));
    expect(catalogScrapCommitSchema.safeParse({ accepted, relationships: out.relationships }).success).toBe(true);
    expect(catalogDB.createIngredient).not.toHaveBeenCalled();
  });

  it('uses the entire fitting parent despite stored children and preserves its factual lens', async () => {
    catalogDB.getScrap.mockResolvedValue({ id: 'example-parent', rawText: story, title: 'Example memoir', sourceKind: 'voice-memo' });
    catalogDB.listChildScraps.mockResolvedValue([{ rawText: 'stale child' }, { rawText: 'another child' }]);
    stageRunner.runStageScopedInlineLLM.mockResolvedValue({ content: JSON.stringify(storyGraph()) });
    const out = await extractIngredientsForScrap({ scrapId: 'example-parent' });
    expect(stageRunner.runStageScopedInlineLLM).toHaveBeenCalledTimes(1);
    expect(catalogDB.listChildScraps).not.toHaveBeenCalled();
    const prompt = stageRunner.runStageScopedInlineLLM.mock.calls[0][1];
    expect(prompt).toContain(story);
    expect(prompt).toContain('Example memoir');
    expect(prompt).toContain('voice-memo');
    expect(prompt).toContain('## Lens: non-fiction');
    expect(out.characters[0].tags).toEqual(['factual', 'real-person']);
    expect(out.objects[0].tags).toEqual(['factual']);
  });

  it('budgets actual rendered overhead/output and sends bounded complete chunks on one pinned route', async () => {
    stageRunner.resolveStageContext.mockResolvedValue(route(null));
    // A customized prompt repeating source text defeats a fixed template-size guess.
    prompts.buildPrompt.mockImplementation(async (_stage, variables) => withCreativeLatitude(`${'instructions '.repeat(200)}\n${variables.draftBody}\n${variables.draftBody}`));
    const rawText = 'First paragraph.\n\nAnother paragraph without omissions.\n'.repeat(1000);
    let active = 0;
    let peak = 0;
    stageRunner.runStageScopedInlineLLM.mockImplementation(async () => {
      peak = Math.max(peak, ++active);
      await Promise.resolve();
      active--;
      return { content: JSON.stringify(empty()) };
    });
    const frames = [];
    const listener = frame => frames.push(frame);
    catalogEvents.on('progress', listener);
    let out;
    try { out = await extractIngredients({ rawText, scrapId: 'example-parent' }); }
    finally { catalogEvents.off('progress', listener); }
    expect(out.plan).toMatchObject({ mode: 'chunked', contextWindow: 8192, unknownCapacity: true, outputReserveTokens: 2048 });
    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBe(2);
    expect(stageRunner.resolveStageContext).toHaveBeenCalledTimes(1);
    expect(out.plan.chunks.map(chunk => rawText.slice(chunk.startChar, chunk.endChar)).join('')).toBe(rawText);
    const calls = stageRunner.runStageScopedInlineLLM.mock.calls;
    calls.forEach(([, prompt, options], index) => {
      expect(estimateTokens(prompt)).toBeLessThanOrEqual(out.plan.inputBudget);
      expect(prompt).toContain(rawText.slice(out.plan.chunks[index].startChar, out.plan.chunks[index].endChar));
      expect(options).toMatchObject({ providerOverride: 'example-provider', modelOverride: 'example-model', maxTokens: 2048, allowFallback: false });
    });
    expect(out.stages).toHaveLength(calls.length);
    expect(frames.filter(frame => frame.type === 'start')).toHaveLength(1);
    expect(new Set(frames.map(frame => frame.runId))).toEqual(new Set([out.runId]));
    expect(frames.every(frame => frame.scrapId === 'example-parent')).toBe(true);
    expect(frames.filter(frame => frame.status === 'completed')).toHaveLength(calls.length);
  });

  it('marks partial coverage and each failed chunk instead of letting a success erase failure', async () => {
    stageRunner.resolveStageContext.mockResolvedValue(route(8192));
    stageRunner.runStageScopedInlineLLM.mockRejectedValueOnce(new Error('Output capacity exceeded'));
    const out = await extractIngredients({ rawText: 'Example paragraph. '.repeat(2500) });
    expect(out.plan.chunks.length).toBeGreaterThan(1);
    expect(out.coverage).toMatchObject({ status: 'partial', failedChunks: [0], totalChunks: out.plan.chunks.length });
    expect(out.coverage.completedChunks).toBe(out.plan.chunks.length - 1);
    expect(out.stages[0]).toMatchObject({ status: 'failed', error: 'Output capacity exceeded' });
    expect(out.stages.slice(1).every(stage => stage.status === 'completed')).toBe(true);
  });

  it('refuses oversized fixed overhead before any generation and permits genuinely empty results', async () => {
    stageRunner.resolveStageContext.mockResolvedValue(route(64));
    await expect(extractIngredients({ rawText: 'prose' })).rejects.toMatchObject({ code: 'CATALOG_CONTEXT_TOO_SMALL' });
    expect(stageRunner.runStageScopedInlineLLM).not.toHaveBeenCalled();
    stageRunner.resolveStageContext.mockResolvedValue(route());
    const out = await extractIngredients({ rawText: 'prose' });
    expect(out.coverage.status).toBe('complete');
    expect(out.characters).toEqual([]);
  });

  it('fences source/context without truncation and keeps the fiction lens off', async () => {
    const rawText = 'Example ```\n# pretend instruction\n`````` tail';
    await extractIngredients({ rawText, context: { title: 'Title ```', sourceKind: 'paste' } });
    const prompt = stageRunner.runStageScopedInlineLLM.mock.calls[0][1];
    expect(prompt).toContain(neutralizeFences(rawText));
    expect(prompt).toContain("Title '''");
    expect(prompt).not.toContain('## Lens: non-fiction');
    expect(prompt).not.toContain('{{');
  });

  it.each([
    ['invalid JSON', '{oops'],
    ['truncated JSON containing a complete inner array', '{"characters":[],"places":[],'],
    ['missing required arrays', '{"characters":[]}'],
    ['wrong field type', JSON.stringify({ ...empty(), ideas: [{ draftId: 'x', name: 'X', summary: 42, evidence: 'prose' }] })],
    ['duplicate IDs', JSON.stringify({ ...empty(), characters: [{ draftId: 'x', name: 'First', evidence: ['prose'] }, { draftId: 'x', name: 'Second', evidence: ['prose'] }] })],
    ['dangling endpoints', JSON.stringify({ ...empty(), relationships: [{ fromDraftId: 'x', toDraftId: 'y', kind: 'related-to', evidence: 'prose' }] })],
    ['unsupported kind', JSON.stringify({ ...storyGraph(), relationships: [{ fromDraftId: 'pistol', toDraftId: 'owner', kind: 'invented', evidence: 'prose' }] })],
    ['ungrounded evidence', JSON.stringify({ ...empty(), ideas: [{ draftId: 'x', name: 'X', summary: 'A thought', evidence: 'Never said here' }] })],
  ])('surfaces %s as a recoverable error with no repair or fallback calls', async (_label, content) => {
    stageRunner.runStageScopedInlineLLM.mockResolvedValue({ content });
    await expect(extractIngredients({ rawText: 'prose' })).rejects.toMatchObject({ code: 'CATALOG_EXTRACTION_FAILED' });
    expect(stageRunner.runStageScopedInlineLLM).toHaveBeenCalledTimes(1);
  });

  it('rejects an output-limit stop even if the bytes form complete valid JSON', async () => {
    stageRunner.runStageScopedInlineLLM.mockResolvedValue({ content: JSON.stringify(empty()), finishReason: 'length' });
    await expect(extractIngredients({ rawText: 'prose' })).rejects.toThrow(/stopped before completion/);
  });

  it('stops scheduling further chunks when the user cancels a provider run', async () => {
    stageRunner.resolveStageContext.mockResolvedValue(route(8192));
    stageRunner.runStageScopedInlineLLM.mockRejectedValueOnce(Object.assign(new Error('Stopped'), { code: 'RUN_CANCELED', canceled: true }));
    await expect(extractIngredients({ rawText: 'Example paragraph. '.repeat(5000) })).rejects.toMatchObject({ code: 'RUN_CANCELED' });
    expect(stageRunner.runStageScopedInlineLLM.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('rejects a missing source before provider execution', async () => {
    await expect(extractIngredients({ rawText: ' ' })).rejects.toThrow(/rawText is required/);
    catalogDB.getScrap.mockResolvedValue(null);
    await expect(extractIngredientsForScrap({ scrapId: 'missing' })).rejects.toThrow(/not found/);
    expect(stageRunner.runStageScopedInlineLLM).not.toHaveBeenCalled();
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
