import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/pgFileFacade.js', () => ({ isFileBackend: () => false }));
const catalogDB = vi.hoisted(() => ({
  listIngredientsForRef: vi.fn(),
  linkIngredientToRef: vi.fn(),
  unlinkIngredientFromRef: vi.fn(),
  musicVideoRefRoleForType: (type) => ({ character: 'cast', place: 'set', object: 'prop' })[type] || 'mentioned',
}));
vi.mock('../catalogDB.js', () => catalogDB);
const getProject = vi.hoisted(() => vi.fn());
vi.mock('./projects.js', () => ({ getProject }));

const { queueProjectCatalogLinkSync: syncProjectCatalogLinks } = await import('./catalogLinks.js');

const subject = (id, kind, ingredientId) => ({ id, kind, name: id, ...(ingredientId ? { ingredientId } : {}) });

describe('syncProjectCatalogLinks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    catalogDB.linkIngredientToRef.mockResolvedValue();
    catalogDB.unlinkIngredientFromRef.mockResolvedValue();
  });

  it('links newly cast catalog records, keeps existing links, and unlinks dropped or re-typed ones', async () => {
    getProject.mockResolvedValue({ id: 'mv-1', concept: { subjects: [
      subject('s1', 'character', 'cat-chr-1'),
      subject('s2', 'place', 'cat-plc-1'),
      subject('s3', 'object'),
      subject('s4', 'object', 'cat-obj-1'),
    ] } });
    catalogDB.listIngredientsForRef.mockResolvedValue([
      { ingredient: { id: 'cat-chr-1' }, role: 'cast' },
      { ingredient: { id: 'cat-chr-9' }, role: 'cast' },
      { ingredient: { id: 'cat-obj-1' }, role: 'set' },
    ]);

    const stats = await syncProjectCatalogLinks('mv-1');

    expect(catalogDB.listIngredientsForRef).toHaveBeenCalledWith('music-video', 'mv-1');
    expect(catalogDB.unlinkIngredientFromRef.mock.calls).toEqual([
      ['cat-chr-9', 'music-video', 'mv-1', 'cast'],
      ['cat-obj-1', 'music-video', 'mv-1', 'set'],
    ]);
    expect(catalogDB.linkIngredientToRef.mock.calls).toEqual([
      ['cat-plc-1', 'music-video', 'mv-1', 'set'],
      ['cat-obj-1', 'music-video', 'mv-1', 'prop'],
    ]);
    expect(stats).toEqual({ linked: 2, unlinked: 2 });
  });

  it('unlinks everything for a deleted project', async () => {
    getProject.mockResolvedValue(null);
    catalogDB.listIngredientsForRef.mockResolvedValue([{ ingredient: { id: 'cat-chr-1' }, role: 'cast' }]);
    await syncProjectCatalogLinks('mv-2');
    expect(catalogDB.unlinkIngredientFromRef).toHaveBeenCalledWith('cat-chr-1', 'music-video', 'mv-2', 'cast');
    expect(catalogDB.linkIngredientToRef).not.toHaveBeenCalled();
  });

  it('re-syncs once when a save lands mid-sync instead of running two syncs at once', async () => {
    let release;
    getProject
      .mockImplementationOnce(() => new Promise((r) => { release = () => r({ concept: { subjects: [] } }); }))
      .mockResolvedValue({ concept: { subjects: [subject('s1', 'character', 'cat-chr-1')] } });
    catalogDB.listIngredientsForRef.mockResolvedValue([]);

    const first = syncProjectCatalogLinks('mv-3');
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const second = syncProjectCatalogLinks('mv-3');
    release();
    await Promise.all([first, second]);

    expect(getProject).toHaveBeenCalledTimes(2);
    expect(catalogDB.linkIngredientToRef).toHaveBeenCalledTimes(1);
  });
});
