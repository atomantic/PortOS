import { describe, it, expect, vi, beforeEach } from 'vitest';

const runPromptThroughProvider = vi.fn();
vi.mock('./promptRunner.js', () => ({
  runPromptThroughProvider,
  resolveProviderAndModel: vi.fn(async () => ({ provider: { id: 'p1', type: 'api' }, selectedModel: 'm1' })),
  assertProvider: vi.fn(),
}));

const {
  castDeckFromUniverse, generateDeckCardPrompts, buildCardPromptsPrompt, PROMPTS_PER_CALL, salvagePromptPairs, __testing,
} = await import('./deckPrompts.js');

const deck = { name: 'Deck', kind: 'tarot', description: 'A lighthouse deck', styleNotes: 'engraved', influences: { embrace: ['sepia'], avoid: [] }, layoutPrompt: 'Full card' };
const universe = {
  logline: 'Keepers vs the swarm',
  characters: [{ id: 'c1', name: 'The Keeper', role: 'protagonist', physicalDescription: 'weathered, lantern in hand' }],
  places: [{ id: 'pl1', name: 'The Lighthouse', description: 'a tower on a crag' }],
  objects: [{ id: 'o1', name: 'The Lens', significance: 'focuses the beam' }],
};
const cards = [
  { id: 'id-0', key: 'major-0', name: '0 · The Fool', motif: 'a traveler' },
  { id: 'id-16', key: 'major-16', name: 'XVI · The Tower', motif: 'lightning' },
  { id: 'id-back', key: 'back', name: 'Card back' },
];

describe('castDeckFromUniverse', () => {
  // Braces matter: a hook that RETURNS the mock hands vitest a "teardown" it
  // then calls with no arguments.
  beforeEach(() => { runPromptThroughProvider.mockReset(); });

  it('maps canon ids onto cards, drops unknown ids/keys, and never offers the back', async () => {
    runPromptThroughProvider.mockResolvedValueOnce({
      text: '```json\n{"assignments":[{"key":"major-0","id":"c1"},{"key":"major-16","id":"pl1"},{"key":"back","id":"o1"},{"key":"nope","id":"c1"},{"key":"major-16","id":"ghost"}]}\n```',
      model: 'm1', provider: { id: 'p1' },
    });
    const { assignments, llm } = await castDeckFromUniverse({ deck, cards, universe });
    expect(assignments).toEqual([
      { cardId: 'id-0', canonRef: { kind: 'character', id: 'c1', name: 'The Keeper' } },
      { cardId: 'id-16', canonRef: { kind: 'place', id: 'pl1', name: 'The Lighthouse' } },
      { cardId: 'id-16', canonRef: null },
    ]);
    expect(llm).toEqual({ provider: 'p1', model: 'm1' });
    const prompt = runPromptThroughProvider.mock.calls[0][0];
    expect(prompt.source).toBe('deck-cast');
    expect(prompt.prompt).toContain('[c1] The Keeper [protagonist]');
    expect(prompt.prompt).not.toMatch(/^\s+- back:/m);
  });

  it('rejects a response with no assignments object as LLM_INVALID_JSON', async () => {
    runPromptThroughProvider.mockResolvedValueOnce({ text: 'Sure! Here you go.', model: 'm1', provider: { id: 'p1' } });
    await expect(castDeckFromUniverse({ deck, cards, universe })).rejects.toMatchObject({ code: 'LLM_INVALID_JSON', status: 502 });
    expect(runPromptThroughProvider).toHaveBeenCalledTimes(1);
  });
});

describe('generateDeckCardPrompts', () => {
  // Braces matter: a hook that RETURNS the mock hands vitest a "teardown" it
  // then calls with no arguments.
  beforeEach(() => { runPromptThroughProvider.mockReset(); });

  it('chunks the targets, keeps the full roster in every call, and drops empty or unknown prompts', async () => {
    const targets = Array.from({ length: PROMPTS_PER_CALL + 1 }, (_, i) => ({ id: `id-${i}`, key: `k-${i}`, name: `Card ${i}` }));
    runPromptThroughProvider.mockImplementation(async ({ prompt }) => {
      // Only the "write these" section names the chunk — the roster above it lists every card.
      const section = prompt.split('# Write prompts for THESE cards only')[1].split('# Output contract')[0];
      const keys = [...section.matchAll(/^ {2}- (k-\d+): Card/gm)].map((m) => m[1]);
      // Echo a prompt for every listed target, plus noise the parser must ignore.
      const prompts = keys.map((key) => ({ key, prompt: key === 'k-1' ? '   ' : `subject for ${key}` }));
      prompts.push({ key: 'k-999', prompt: 'stray' });
      return { text: JSON.stringify({ prompts }), model: 'm1', provider: { id: 'p1' } };
    });
    const { prompts } = await generateDeckCardPrompts({ deck, roster: targets, targets, universe: null });
    expect(runPromptThroughProvider).toHaveBeenCalledTimes(2);
    expect(prompts).toHaveLength(PROMPTS_PER_CALL); // k-1 blank, k-999 unknown
    expect(prompts.find((p) => p.cardId === 'id-0')).toEqual({ cardId: 'id-0', prompt: 'subject for k-0' });
    expect(prompts.some((p) => p.cardId === 'id-1')).toBe(false);
    const secondCall = runPromptThroughProvider.mock.calls[1][0].prompt;
    expect(secondCall).toContain('k-0: Card 0'); // roster stays complete for consistency
    expect(runPromptThroughProvider.mock.calls[1][0].source).toBe('deck-card-prompts');
  });

  it('hands the runner the shape predicate + a repair that appends the strict-JSON reminder and surfaces a schema failure as LLM_INVALID_JSON', async () => {
    const targets = [{ id: 'id-0', key: 'k-0', name: 'Card 0' }];
    runPromptThroughProvider.mockResolvedValueOnce({ text: '{"prompts": [{"key": "k-0", "prompt": "fixed"}]}', model: 'm1', provider: { id: 'p1' } });
    await generateDeckCardPrompts({ deck, roster: targets, targets });
    const args = runPromptThroughProvider.mock.calls[0][0];
    expect(args.responseSchema({ prompts: [] })).toBe(true);
    expect(args.repair({ phase: 'request', prompt: 'P' })).toEqual({ prompt: expect.stringMatching(/^P\n\n# Your previous reply was not valid JSON/) });

    const schemaErr = Object.assign(new Error('bad shape'), { schemaFailure: true });
    runPromptThroughProvider.mockRejectedValueOnce(schemaErr);
    await expect(generateDeckCardPrompts({ deck, roster: targets, targets })).rejects.toMatchObject({ code: 'LLM_INVALID_JSON' });
    runPromptThroughProvider.mockRejectedValueOnce(new Error('transport down'));
    await expect(generateDeckCardPrompts({ deck, roster: targets, targets })).rejects.toThrow('transport down');
  });

  it('the response repair extracts clean JSON first and salvages key/prompt pairs from a structurally broken reply', () => {
    // Observed in the wild: the model dropped the "prompt" key on one entry and
    // left a raw quote inside another — JSON.parse fails, the prose is intact.
    const broken = '```json\n{"prompts":[{"key":"k-0","prompt":"a winged herald over the "real experts" crag"},{"key":"k-1":"a single tower thrust up like a wand"}]}\n```';
    expect(salvagePromptPairs(broken)).toEqual({ prompts: [
      { key: 'k-0', prompt: 'a winged herald over the ' },
      { key: 'k-1', prompt: 'a single tower thrust up like a wand' },
    ] });
    expect(salvagePromptPairs('no pairs here')).toBeNull();
    const repair = __testing.jsonRepair({ shapePredicate: (o) => o && Array.isArray(o.prompts), salvage: salvagePromptPairs });
    expect(JSON.parse(repair({ phase: 'response', text: broken }).text).prompts.map((p) => p.key)).toEqual(['k-0', 'k-1']);
    expect(repair({ phase: 'response', text: '```json\n{"prompts": [{"key": "k-0", "prompt": "clean"}]}\n```' })).toEqual({ text: '{"prompts":[{"key":"k-0","prompt":"clean"}]}' });
    expect(repair({ phase: 'response', text: 'nothing usable' })).toBeNull();
  });

  it('threads the cast canon entry into the prompt and the deck style stays out of the subject', () => {
    const text = buildCardPromptsPrompt({
      deck,
      roster: [{ ...cards[0], canonRef: { kind: 'character', id: 'c1', name: 'The Keeper' } }],
      targets: [{ ...cards[0], canonRef: { kind: 'character', id: 'c1', name: 'The Keeper' } }],
      universe,
    });
    expect(text).toContain('→ depict The Keeper (character)');
    expect(text).toContain('STYLE TOKENS (prepended automatically at render time): sepia');
    expect(text).toContain('do NOT repeat style');
  });
});
