import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./stageRunner.js', () => ({
  runStagedLLM: vi.fn(),
}));

const stageRunner = await import('./stageRunner.js');
const { extractBible } = await import('./bibleExtractor.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('bibleExtractor — extractBible (characters)', () => {
  it('passes draftBody + trimmed existingCharactersJson into the stage prompt', async () => {
    stageRunner.runStagedLLM.mockResolvedValue({
      content: { characters: [{ name: 'Aria', physicalDescription: 'tall' }] },
      runId: 'r1', providerId: 'p1', model: 'm1',
    });
    const existing = [{ id: 'c1', name: 'Aria', aliases: [], role: 'lead', physicalDescription: 'tall', personality: '', background: '', notes: 'private', createdAt: 't', updatedAt: 't' }];
    await extractBible({ kind: 'character', corpus: 'long prose...', existing, context: { work: { id: 'w1' } } });

    const [stageName, variables] = stageRunner.runStagedLLM.mock.calls[0];
    expect(stageName).toBe('writers-room-characters');
    expect(variables.draftBody).toBe('long prose...');
    expect(variables.work).toEqual({ id: 'w1' });
    const trimmed = JSON.parse(variables.existingCharactersJson);
    // notes/createdAt/updatedAt stripped before the prompt sees them
    expect(trimmed[0]).not.toHaveProperty('notes');
    expect(trimmed[0]).not.toHaveProperty('createdAt');
    expect(trimmed[0].name).toBe('Aria');
    expect(trimmed[0].role).toBe('lead');
  });

  it('routes the response through sanitizeBibleList — caps fields and drops malformed rows', async () => {
    stageRunner.runStagedLLM.mockResolvedValue({
      content: {
        characters: [
          { name: 'Aria', physicalDescription: 'X'.repeat(5000) },
          { name: '' },              // dropped (blank name)
          null,                      // dropped (non-object)
          { name: 'Marcus', aliases: ['Marc'], personality: 'taciturn' },
        ],
      },
      runId: 'r2', providerId: 'p2', model: 'm2',
    });
    const out = await extractBible({ kind: 'character', corpus: 'prose' });
    expect(out.extracted).toHaveLength(2);
    expect(out.extracted[0].physicalDescription.length).toBeLessThanOrEqual(2000);
    expect(out.extracted[1].name).toBe('Marcus');
    expect(out.extracted[1].aliases).toEqual(['Marc']);
  });

  it('returns runId/providerId/model from the stage runner', async () => {
    stageRunner.runStagedLLM.mockResolvedValue({
      content: { characters: [] }, runId: 'r3', providerId: 'p3', model: 'm3',
    });
    const out = await extractBible({ kind: 'character', corpus: 'prose' });
    expect(out).toMatchObject({ runId: 'r3', providerId: 'p3', model: 'm3' });
  });

  it('forwards source + providerOverride to runStagedLLM', async () => {
    stageRunner.runStagedLLM.mockResolvedValue({ content: { characters: [] }, runId: '', providerId: '', model: '' });
    await extractBible({ kind: 'character', corpus: 'prose', source: 'pipeline-bible-character', providerOverride: 'override-id' });
    const opts = stageRunner.runStagedLLM.mock.calls[0][2];
    expect(opts.source).toBe('pipeline-bible-character');
    expect(opts.providerOverride).toBe('override-id');
    expect(opts.returnsJson).toBe(true);
  });

  it('returns empty array when LLM envelope is missing the expected key', async () => {
    stageRunner.runStagedLLM.mockResolvedValue({ content: { totally: 'wrong shape' }, runId: '', providerId: '', model: '' });
    const out = await extractBible({ kind: 'character', corpus: 'prose' });
    expect(out.extracted).toEqual([]);
  });
});

describe('bibleExtractor — extractBible (places + objects)', () => {
  it('places: pulls inner array, sanitizes via place shape', async () => {
    stageRunner.runStagedLLM.mockResolvedValue({
      content: { places: [{ slugline: 'INT. BAR — NIGHT', description: 'cramped chrome bar', palette: 'amber' }] },
      runId: '', providerId: '', model: '',
    });
    const out = await extractBible({ kind: 'place', corpus: 'prose' });
    expect(out.extracted).toHaveLength(1);
    expect(out.extracted[0].slugline).toBe('INT. BAR — NIGHT');
    expect(out.extracted[0].palette).toBe('amber');
  });

  it('objects: pulls inner array, sanitizes via object shape', async () => {
    stageRunner.runStagedLLM.mockResolvedValue({
      content: { objects: [{ name: 'The Locket', significance: "mother's" }] },
      runId: '', providerId: '', model: '',
    });
    const out = await extractBible({ kind: 'object', corpus: 'prose' });
    expect(out.extracted[0].name).toBe('The Locket');
    expect(out.extracted[0].significance).toBe("mother's");
  });
});

describe('bibleExtractor — guards', () => {
  it('rejects unknown kinds', async () => {
    await expect(extractBible({ kind: 'cheese', corpus: 'prose' })).rejects.toThrow(/unknown kind/);
  });

  it('rejects empty corpus', async () => {
    await expect(extractBible({ kind: 'character', corpus: '' })).rejects.toThrow(/corpus is required/);
    await expect(extractBible({ kind: 'character', corpus: '   ' })).rejects.toThrow(/corpus is required/);
    await expect(extractBible({ kind: 'character', corpus: null })).rejects.toThrow(/corpus is required/);
  });
});
