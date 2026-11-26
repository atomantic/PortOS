import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  client: { query: vi.fn() },
  createScrapIngredients: vi.fn(),
  linkIngredientRelation: vi.fn(),
  withTransaction: vi.fn(),
}));

vi.mock('../universeBuilder.js', () => ({ updateUniverse: vi.fn(async (_id, mutate) =>
  mocks.withTransaction((client) => mutate({ objects: [{ ingredientId: 'existing-object' }] }, { client }))) }));
vi.mock('./catalogPrimitives.js', () => ({ canonEntryFor: ({ id }) => ({ ingredientId: id }) }));
vi.mock('../catalogDB/identityAccess.js', () => ({ assertCatalogIdentitiesWritable: vi.fn() }));

vi.mock('../../lib/db.js', () => ({
  withTransaction: mocks.withTransaction,
  afterTransactionCommit: vi.fn(),
}));

vi.mock('../catalogDB/ingredients.js', () => ({
  createScrapIngredients: mocks.createScrapIngredients,
}));

vi.mock('../catalogDB/refs.js', () => ({
  linkIngredientRelation: mocks.linkIngredientRelation,
  // Real implementation — a small pure lookup, not worth mocking away from
  // the type→role contract the tests below assert against.
  universeRefRoleForType: (type) => ({ character: 'canon-character', place: 'canon-place', object: 'canon-object' }[type] || 'reference'),
}));

import { commitScrap } from '../catalogDB/commit.js';
import { updateUniverse } from '../universeBuilder.js';

const statement = (table) => mocks.client.query.mock.calls.find(([sql]) => sql.startsWith(`INSERT INTO ${table} `));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.withTransaction.mockImplementation((fn) => fn(mocks.client));
  mocks.client.query.mockImplementation(async (sql) => ({
    rows: sql.startsWith('SELECT ingredient_id, role')
      ? [{ ingredient_id: 'cat-chr-example', role: 'canon-character' }]
      : [{ id: 'universe-1' }],
  }));
  mocks.createScrapIngredients.mockImplementation(async (drafts) => drafts.map(({ name, type }) => ({
    id: `stored-${name}`, name, type,
  })));
  mocks.linkIngredientRelation.mockResolvedValue(undefined);
});

describe('explicit graph commits', () => {
  const accepted = Array.from({ length: 26 }, (_, i) => ({
    draftId: 'draft-' + i, type: 'idea', name: 'Renamed Idea ' + i,
  }));
  const edge = { fromDraftId: 'draft-25', toDraftId: 'draft-0', kind: 'references', evidence: 'The final idea references the first.' };

  it('maps reordered draft IDs and writes only requested directed edges above the legacy cap', async () => {
    await commitScrap({ scrapId: 'example-scrap', accepted: [...accepted].reverse(), relationships: [edge] });
    expect(mocks.linkIngredientRelation).toHaveBeenCalledExactlyOnceWith(
      'stored-Renamed Idea 25', 'stored-Renamed Idea 0', 'references', { client: mocks.client },
    );
    expect(mocks.createScrapIngredients.mock.calls[0][0][0]).not.toHaveProperty('draftId');
    expect(mocks.createScrapIngredients.mock.calls[0][0][0].payload).not.toHaveProperty('draftId');
  });

  it('never creates pairs for explicit [] and validates direct callers before opening a transaction', async () => {
    await commitScrap({ scrapId: 'example-scrap', accepted: accepted.slice(0, 2), relationships: [] });
    expect(mocks.linkIngredientRelation).not.toHaveBeenCalled();
    mocks.withTransaction.mockClear();
    await expect(commitScrap({ accepted, relationships: [{ ...edge, toDraftId: 'missing' }] })).rejects.toThrow();
    expect(mocks.withTransaction).not.toHaveBeenCalled();
  });

  it('propagates a relation-write failure to the transaction owner', async () => {
    const failure = new Error('relation write failed');
    mocks.linkIngredientRelation.mockRejectedValue(failure);
    await expect(commitScrap({ scrapId: 'example-scrap', accepted, relationships: [edge], universeRef: 'example-universe' }))
      .rejects.toBe(failure);
  });
});

describe('commitScrap', () => {
  it('creates accepted ingredients and source links on one transaction client', async () => {
    const expected = [
      { id: 'cat-chr-example', name: 'Example Character' },
      { id: 'cat-plc-example', name: 'Example Place' },
    ];
    mocks.createScrapIngredients.mockResolvedValueOnce(expected);

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
    expect(mocks.createScrapIngredients).toHaveBeenCalledExactlyOnceWith([{
      type: 'character',
      name: 'Example Character',
      payload: { role: 'lead' },
      tags: ['hero'],
      embedding: [0.1, 0.2],
      embeddingModel: 'example-model',
    }, {
      type: 'place',
      name: 'Example Place',
      payload: {},
      tags: [],
      embedding: null,
      embeddingModel: null,
    }], { client: mocks.client });
    expect(statement('catalog_ingredient_sources')?.[1]).toEqual([
      ['cat-chr-example', 'cat-plc-example'], ['{"start":1,"end":4}', null], 'cat-scrap-example',
    ]);
    expect(created).toEqual(expected);
  });

  it('does not swallow a failed transaction step', async () => {
    const failure = new Error('source link failed');
    mocks.client.query.mockRejectedValueOnce(failure);

    await expect(commitScrap({
      scrapId: 'cat-scrap-example',
      accepted: [{ type: 'idea', name: 'Example Idea' }],
    })).rejects.toBe(failure);
  });

  it('links every ingredient to universeRef with the type-derived role, in the transaction client (#7615)', async () => {
    mocks.createScrapIngredients.mockResolvedValueOnce([
      { id: 'cat-chr-example', type: 'character' },
      { id: 'cat-idea-example', type: 'idea' },
    ]);

    await commitScrap({
      scrapId: 'cat-scrap-example',
      accepted: [
        { type: 'character', name: 'Example Character' },
        { type: 'idea', name: 'Example Idea' },
      ],
      universeRef: 'universe-1',
    });

    expect(statement('catalog_ingredient_refs')).toEqual([
      expect.stringContaining("'owner'"), [['cat-chr-example', 'cat-idea-example'], ['canon-character', 'reference'], 'universe-1'],
    ]);
    expect(await updateUniverse.mock.results[0].value).toEqual({ characters: [{ ingredientId: 'cat-chr-example' }] });
    expect(new Set(updateUniverse.mock.calls[0][2].canonProjectionIdentityIds)).toEqual(new Set([
      'cat-chr-example', 'existing-object',
    ]));
  });

  it('an explicit role overrides the type-derived default', async () => {
    await commitScrap({
      scrapId: 'cat-scrap-example',
      accepted: [{ type: 'idea', name: 'Example Idea' }],
      universeRef: 'universe-1',
      role: 'canon-idea',
    });

    expect(statement('catalog_ingredient_refs')?.[1]).toEqual([['stored-Example Idea'], ['canon-idea'], 'universe-1']);
  });

  it('links no universe ref when universeRef is omitted — prior behavior preserved', async () => {
    await commitScrap({ scrapId: 'cat-scrap-example', accepted: [{ type: 'idea', name: 'Example Idea' }] });

    expect(statement('catalog_ingredient_refs')).toBeUndefined();
  });

  it('mints one related-to edge per unordered pair, from_id = lexicographically smaller id', async () => {
    await commitScrap({
      scrapId: 'cat-scrap-example',
      accepted: [
        { type: 'idea', name: 'B' },
        { type: 'idea', name: 'A' },
        { type: 'idea', name: 'C' },
      ],
    });

    expect(statement('catalog_ingredient_relations')).toEqual([
      expect.stringContaining("'related-to'"), [['stored-A', 'stored-A', 'stored-B'], ['stored-B', 'stored-C', 'stored-C']],
    ]);
  });

  it('mints no relation edges for a single-item batch', async () => {
    await commitScrap({ scrapId: 'cat-scrap-example', accepted: [{ type: 'idea', name: 'Solo' }] });

    expect(statement('catalog_ingredient_relations')).toBeUndefined();
  });

  it('mints no relation edges for a batch over the 25-row bound', async () => {
    const accepted = Array.from({ length: 26 }, (_, i) => ({ type: 'idea', name: `Idea ${i}` }));
    await commitScrap({ scrapId: 'cat-scrap-example', accepted });

    expect(statement('catalog_ingredient_relations')).toBeUndefined();
  });
});
