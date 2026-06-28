import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./apiCore.js', () => ({
  request: vi.fn(),
}));

let request;
let listCatalogIngredientsByIds;

beforeEach(async () => {
  vi.resetModules();
  ({ request } = await import('./apiCore.js'));
  ({ listCatalogIngredientsByIds } = await import('./apiCatalog.js'));
  request.mockReset();
});

describe('listCatalogIngredientsByIds', () => {
  it('unwraps the { items } envelope and re-orders to the requested ids', async () => {
    // Server returns created_at DESC (NOT request order) inside the paged envelope.
    request.mockResolvedValue({
      items: [
        { id: 'cat-b', name: 'B' },
        { id: 'cat-a', name: 'A' },
        { id: 'cat-c', name: 'C' },
      ],
      nextOffset: 3,
    });

    const out = await listCatalogIngredientsByIds(['cat-a', 'cat-b', 'cat-c']);
    // Restored to the user's pick order, as a plain array.
    expect(out.map((i) => i.id)).toEqual(['cat-a', 'cat-b', 'cat-c']);

    // The ids ride the normal list endpoint as a CSV query.
    const [path] = request.mock.calls[0];
    expect(path).toContain('/catalog/ingredients?');
    expect(decodeURIComponent(path)).toContain('ids=cat-a,cat-b,cat-c');
  });

  it('drops falsy ids and ids the server omits (missing / soft-deleted)', async () => {
    request.mockResolvedValue({ items: [{ id: 'cat-a', name: 'A' }], nextOffset: 1 });
    const out = await listCatalogIngredientsByIds(['cat-a', '', 'cat-missing', null]);
    expect(out.map((i) => i.id)).toEqual(['cat-a']);
  });

  it('tolerates a bare-array response shape', async () => {
    request.mockResolvedValue([{ id: 'cat-a', name: 'A' }]);
    const out = await listCatalogIngredientsByIds(['cat-a']);
    expect(out.map((i) => i.id)).toEqual(['cat-a']);
  });
});
