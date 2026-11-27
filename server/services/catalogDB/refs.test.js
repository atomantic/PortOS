import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/db.js', () => ({
  query: vi.fn(),
  withTransaction: vi.fn(),
  afterTransactionCommit: vi.fn(),
}));
vi.mock('./identityAccess.js', () => ({
  assertCatalogIdentityWritable: vi.fn(async (id) => id),
}));
vi.mock('./ingredients.js', () => ({}));
vi.mock('../catalog/catalogRefResolver.js', () => ({}));

import { afterTransactionCommit, query, withTransaction } from '../../lib/db.js';
import { catalogEvents } from '../catalog/catalogEvents.js';
import { linkIngredientsToCreativeDirector, linkIngredientsToSeries } from './refs.js';

const ingredients = [
  { id: 'cat-chr-example', type: 'character' },
  { id: 'cat-place-example', type: 'place' },
];

describe.each([
  ['series', linkIngredientsToSeries, 'canon-place'],
  ['creative-director', linkIngredientsToCreativeDirector, 'location'],
])('%s batch ref links', (kind, linkBatch, placeRole) => {
  const committed = [];
  const notify = vi.fn();
  const failure = new Error('ref insert failed');
  let failOnId;

  beforeEach(() => {
    vi.clearAllMocks();
    committed.length = 0;
    failOnId = null;
    catalogEvents.on('assets-changed', notify);
    withTransaction.mockImplementation(async (work) => {
      const pending = [];
      const callbacks = [];
      const client = {
        async query(_sql, params) {
          expect(notify).not.toHaveBeenCalled();
          if (params[0] === failOnId) throw failure;
          pending.push(params);
        },
      };
      afterTransactionCommit.mockImplementation((owner, callback) => {
        expect(owner).toBe(client);
        callbacks.push(callback);
      });
      await work(client);
      committed.push(...pending);
      callbacks.forEach((callback) => callback());
    });
  });

  afterEach(() => catalogEvents.off('assets-changed', notify));

  it('commits all valid links and then announces them', async () => {
    expect(await linkBatch('target', [null, ...ingredients, {}])).toEqual(ingredients);
    expect(query).not.toHaveBeenCalled();
    expect(committed).toEqual([
      [ingredients[0].id, kind, 'target', 'cast'],
      [ingredients[1].id, kind, 'target', placeRole],
    ]);
    expect(notify.mock.calls).toEqual(ingredients.map(({ id }) => [{ ingredientId: id }]));
  });

  it('rejects a mid-batch failure without committing links or announcing changes', async () => {
    failOnId = ingredients[1].id;
    await expect(linkBatch('target', ingredients)).rejects.toBe(failure);
    expect(query).not.toHaveBeenCalled();
    expect(committed).toEqual([]);
    expect(notify).not.toHaveBeenCalled();
  });
});
