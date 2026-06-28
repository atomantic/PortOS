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

describe('listCatalogIngredients filter passthrough (#1762)', () => {
  let listCatalogIngredients;
  beforeEach(async () => {
    ({ listCatalogIngredients } = await import('./apiCatalog.js'));
    request.mockResolvedValue({ items: [], nextOffset: 0 });
  });

  it('encodes a universe/series ref filter as refKind + refId', async () => {
    await listCatalogIngredients({ refKind: 'universe', refId: 'u-1', type: 'character' });
    const [path] = request.mock.calls[0];
    expect(decodeURIComponent(path)).toContain('refKind=universe');
    expect(decodeURIComponent(path)).toContain('refId=u-1');
    expect(decodeURIComponent(path)).toContain('type=character');
  });

  it('sends unlinked=true for the Raw album view', async () => {
    await listCatalogIngredients({ unlinked: true });
    const [path] = request.mock.calls[0];
    expect(path).toContain('unlinked=true');
  });

  it('sends orphaned=true for the Orphaned album view', async () => {
    await listCatalogIngredients({ orphaned: true });
    const [path] = request.mock.calls[0];
    expect(path).toContain('orphaned=true');
  });

  it('prefers the ref filter over unlinked/orphaned when both are passed', async () => {
    await listCatalogIngredients({ refKind: 'series', refId: 's-1', unlinked: true, orphaned: true });
    const [path] = request.mock.calls[0];
    expect(decodeURIComponent(path)).toContain('refKind=series');
    expect(path).not.toContain('unlinked');
    expect(path).not.toContain('orphaned');
  });
});

describe('getCatalogFacets (#1762)', () => {
  it('GETs the facets endpoint', async () => {
    const { getCatalogFacets } = await import('./apiCatalog.js');
    request.mockResolvedValue({ types: [], universes: [], series: [], tags: [], total: 0 });
    await getCatalogFacets();
    expect(request).toHaveBeenCalledWith('/catalog/facets', undefined);
  });
});
