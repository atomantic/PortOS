import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  client: { query: vi.fn() },
  createIngredient: vi.fn(),
  linkIngredientToSource: vi.fn(),
  linkIngredientToRef: vi.fn(),
  linkIngredientRelation: vi.fn(),
  withTransaction: vi.fn(),
}));

vi.mock('../lib/db.js', () => ({
  withTransaction: mocks.withTransaction,
}));

vi.mock('./catalogDB/ingredients.js', () => ({
  createIngredient: mocks.createIngredient,
}));

vi.mock('./catalogDB/refs.js', () => ({
  linkIngredientToSource: mocks.linkIngredientToSource,
  linkIngredientToRef: mocks.linkIngredientToRef,
  linkIngredientRelation: mocks.linkIngredientRelation,
  // Real implementation — a small pure lookup, not worth mocking away from
  // the type→role contract the tests below assert against.
  universeRefRoleForType: (type) => ({ character: 'canon-character', place: 'canon-place', object: 'canon-object' }[type] || 'reference'),
}));

import { commitScrap } from './catalogDB/commit.js';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.withTransaction.mockImplementation((fn) => fn(mocks.client));
  // clearAllMocks resets call history but not a prior mockRejectedValue —
  // reset the default resolution so one test's induced failure can't bleed
  // into the next.
  mocks.linkIngredientToSource.mockResolvedValue(undefined);
  mocks.linkIngredientToRef.mockResolvedValue(undefined);
  mocks.linkIngredientRelation.mockResolvedValue(undefined);
});

describe('explicit graph commits', () => {
  const accepted = Array.from({ length: 26 }, (_, i) => ({
    draftId: 'draft-' + i, type: 'idea', name: 'Renamed Idea ' + i,
  }));
  const edge = { fromDraftId: 'draft-25', toDraftId: 'draft-0', kind: 'references', evidence: 'The final idea references the first.' };

  it('maps reordered draft IDs and writes only requested directed edges above the legacy cap', async () => {
    mocks.createIngredient.mockImplementation(async ({ name }) => ({ id: 'stored-' + name }));
    await commitScrap({ scrapId: 'example-scrap', accepted: [...accepted].reverse(), relationships: [edge] });
    expect(mocks.linkIngredientRelation).toHaveBeenCalledExactlyOnceWith(
      'stored-Renamed Idea 25', 'stored-Renamed Idea 0', 'references', { client: mocks.client },
    );
    expect(mocks.createIngredient.mock.calls[0][0]).not.toHaveProperty('draftId');
    expect(mocks.createIngredient.mock.calls[0][0].payload).not.toHaveProperty('draftId');
  });

  it('never creates pairs for explicit [] and validates direct callers before opening a transaction', async () => {
    mocks.createIngredient.mockImplementation(async ({ name }) => ({ id: 'stored-' + name }));
    await commitScrap({ scrapId: 'example-scrap', accepted: accepted.slice(0, 2), relationships: [] });
    expect(mocks.linkIngredientRelation).not.toHaveBeenCalled();
    mocks.withTransaction.mockClear();
    await expect(commitScrap({ accepted, relationships: [{ ...edge, toDraftId: 'missing' }] })).rejects.toThrow();
    expect(mocks.withTransaction).not.toHaveBeenCalled();
  });

  it('propagates a relation-write failure to the transaction owner', async () => {
    mocks.createIngredient.mockImplementation(async ({ name }) => ({ id: 'stored-' + name }));
    const failure = new Error('relation write failed');
    mocks.linkIngredientRelation.mockRejectedValue(failure);
    await expect(commitScrap({ scrapId: 'example-scrap', accepted, relationships: [edge], universeRef: 'example-universe' }))
      .rejects.toBe(failure);
  });
});

describe('commitScrap', () => {
  it('creates accepted ingredients and source links on one transaction client', async () => {
    mocks.createIngredient
      .mockResolvedValueOnce({ id: 'cat-chr-example', name: 'Example Character' })
      .mockResolvedValueOnce({ id: 'cat-plc-example', name: 'Example Place' });

    const created = await commitScrap({
      scrapId: 'cat-scrap-example',
      accepted: [
        { type: 'character', name: 'Example Character', payload: { role: 'lead' }, tags: ['hero'], span: { start: 1, end: 4 } },
        { type: 'place', name: 'Example Place' },
      ],
      embeds: [
        { embedding: [0.1, 0.2], model: 'example-model' },
        null,
      ],
    });

    expect(mocks.withTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.createIngredient).toHaveBeenNthCalledWith(1, {
      type: 'character',
      name: 'Example Character',
      payload: { role: 'lead' },
      tags: ['hero'],
      embedding: [0.1, 0.2],
      embeddingModel: 'example-model',
    }, { client: mocks.client, source: 'extract' });
    expect(mocks.createIngredient).toHaveBeenNthCalledWith(2, {
      type: 'place',
      name: 'Example Place',
      payload: {},
      tags: [],
      embedding: null,
      embeddingModel: null,
    }, { client: mocks.client, source: 'extract' });
    expect(mocks.linkIngredientToSource).toHaveBeenNthCalledWith(
      1,
      'cat-chr-example',
      'cat-scrap-example',
      { start: 1, end: 4 },
      { client: mocks.client },
    );
    expect(mocks.linkIngredientToSource).toHaveBeenNthCalledWith(
      2,
      'cat-plc-example',
      'cat-scrap-example',
      null,
      { client: mocks.client },
    );
    expect(created).toEqual([
      { id: 'cat-chr-example', name: 'Example Character' },
      { id: 'cat-plc-example', name: 'Example Place' },
    ]);
  });

  it('does not swallow a failed transaction step', async () => {
    const failure = new Error('source link failed');
    mocks.createIngredient.mockResolvedValue({ id: 'cat-idea-example' });
    mocks.linkIngredientToSource.mockRejectedValue(failure);

    await expect(commitScrap({
      scrapId: 'cat-scrap-example',
      accepted: [{ type: 'idea', name: 'Example Idea' }],
    })).rejects.toBe(failure);
  });

  it('links every ingredient to universeRef with the type-derived role, in the transaction client (#7615)', async () => {
    mocks.createIngredient
      .mockResolvedValueOnce({ id: 'cat-chr-example' })
      .mockResolvedValueOnce({ id: 'cat-idea-example' });

    await commitScrap({
      scrapId: 'cat-scrap-example',
      accepted: [
        { type: 'character', name: 'Example Character' },
        { type: 'idea', name: 'Example Idea' },
      ],
      universeRef: 'universe-1',
    });

    expect(mocks.linkIngredientToRef).toHaveBeenNthCalledWith(1, 'cat-chr-example', 'universe', 'universe-1', 'canon-character', { client: mocks.client });
    expect(mocks.linkIngredientToRef).toHaveBeenNthCalledWith(2, 'cat-idea-example', 'universe', 'universe-1', 'reference', { client: mocks.client });
  });

  it('an explicit role overrides the type-derived default', async () => {
    mocks.createIngredient.mockResolvedValueOnce({ id: 'cat-idea-example' });

    await commitScrap({
      scrapId: 'cat-scrap-example',
      accepted: [{ type: 'idea', name: 'Example Idea' }],
      universeRef: 'universe-1',
      role: 'canon-idea',
    });

    expect(mocks.linkIngredientToRef).toHaveBeenCalledWith('cat-idea-example', 'universe', 'universe-1', 'canon-idea', { client: mocks.client });
  });

  it('links no universe ref when universeRef is omitted — prior behavior preserved', async () => {
    mocks.createIngredient.mockResolvedValueOnce({ id: 'cat-idea-example' });

    await commitScrap({ scrapId: 'cat-scrap-example', accepted: [{ type: 'idea', name: 'Example Idea' }] });

    expect(mocks.linkIngredientToRef).not.toHaveBeenCalled();
  });

  it('mints one related-to edge per unordered pair, from_id = lexicographically smaller id', async () => {
    mocks.createIngredient
      .mockResolvedValueOnce({ id: 'cat-idea-b' })
      .mockResolvedValueOnce({ id: 'cat-idea-a' })
      .mockResolvedValueOnce({ id: 'cat-idea-c' });

    await commitScrap({
      scrapId: 'cat-scrap-example',
      accepted: [
        { type: 'idea', name: 'B' },
        { type: 'idea', name: 'A' },
        { type: 'idea', name: 'C' },
      ],
    });

    // 3 ingredients (created in order b, a, c) → 3 unordered pairs, each
    // oriented smaller-id-first regardless of creation order: cat-idea-a <
    // cat-idea-b < cat-idea-c lexicographically.
    expect(mocks.linkIngredientRelation).toHaveBeenCalledTimes(3);
    expect(mocks.linkIngredientRelation).toHaveBeenCalledWith('cat-idea-a', 'cat-idea-b', 'related-to', { client: mocks.client });
    expect(mocks.linkIngredientRelation).toHaveBeenCalledWith('cat-idea-b', 'cat-idea-c', 'related-to', { client: mocks.client });
    expect(mocks.linkIngredientRelation).toHaveBeenCalledWith('cat-idea-a', 'cat-idea-c', 'related-to', { client: mocks.client });
  });

  it('mints no relation edges for a single-item batch', async () => {
    mocks.createIngredient.mockResolvedValueOnce({ id: 'cat-idea-solo' });

    await commitScrap({ scrapId: 'cat-scrap-example', accepted: [{ type: 'idea', name: 'Solo' }] });

    expect(mocks.linkIngredientRelation).not.toHaveBeenCalled();
  });

  it('mints no relation edges for a batch over the 25-row bound', async () => {
    const accepted = Array.from({ length: 26 }, (_, i) => ({ type: 'idea', name: `Idea ${i}` }));
    for (let i = 0; i < 26; i++) mocks.createIngredient.mockResolvedValueOnce({ id: `cat-idea-${i}` });

    await commitScrap({ scrapId: 'cat-scrap-example', accepted });

    expect(mocks.linkIngredientRelation).not.toHaveBeenCalled();
  });
});
