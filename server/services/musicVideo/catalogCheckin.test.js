import { describe, expect, it, vi } from 'vitest';
import { resolveCatalogCheckin, withCatalogCheckin, assertCatalogCheckinReady, assertLegacyCheckin } from './catalogCheckin.js';

const subject = { id: 'subject-example', ingredientId: 'character-example', kind: 'character', name: 'Example actor' };
const fixture = (extra = {}) => ({ concept: { subjects: [subject] }, castAndSets: { source: 'catalog', status: 'review',
  images: { character: { imageId: 'historical.png', submittedReferences: ['original.png'] } } }, ...extra });
const catalog = (payload = {}, media = [{ kind: 'portrait', mediaKey: 'catalog.png' }]) => ({
  getIngredient: vi.fn(async () => ({ id: subject.ingredientId, type: 'character', name: 'Catalog actor', payload })),
  listMediaForIngredient: vi.fn(async () => media),
});
const resolve = (project, db = catalog()) => resolveCatalogCheckin(project, { catalog: db, exists: () => true });

describe('catalog check-in projection', () => {
  it('resolves live images without changing generated history and invalidates approval after catalog changes', async () => {
    const project = fixture();
    const before = structuredClone(project);
    const first = await resolve(project);
    expect(first.items[0]).toMatchObject({ name: 'Catalog actor', images: ['catalog.png'] });
    project.castAndSets.status = 'approved';
    project.castAndSets.catalogApprovedBasis = first.basis;
    expect((await resolve(project)).approved).toBe(true);
    const changed = await resolve(project, catalog({}, [{ kind: 'portrait', mediaKey: 'new-catalog.png' }]));
    expect(changed.approved).toBe(false);
    expect(changed.items[0].images).toEqual(['new-catalog.png']);
    expect(project.castAndSets.images).toEqual(before.castAndSets.images);
  });

  it('keeps unresolved subjects visible and never substitutes historical images', async () => {
    const project = fixture({ concept: { subjects: [{ ...subject, ingredientId: null }, { ...subject, id: 'other', ingredientId: 'missing' }] } });
    const db = catalog();
    db.getIngredient.mockResolvedValue(null);
    const result = await resolve(project, db);
    expect(result.items).toHaveLength(2);
    expect(result.items.every(item => item.images.length === 0)).toBe(true);
    expect(result.problems.map(problem => problem.code)).toEqual(['CATALOG_LINK_REQUIRED', 'CATALOG_RECORD_MISSING']);
    expect(() => assertCatalogCheckinReady(result)).toThrow('Link Example actor');
  });

  it('requires the selected form own image, not another age or canonical portrait', async () => {
    const project = fixture({ concept: { subjects: [{ ...subject, castForm: { id: 'child' } }] } });
    const db = catalog({ forms: [{ id: 'child', label: 'Childhood', description: 'Young actor' }] });
    expect((await resolve(project, db)).problems[0].code).toBe('CATALOG_IMAGES_REQUIRED');
    db.listMediaForIngredient.mockResolvedValue([{ kind: 'reference', mediaKey: 'child.png', library: { variant: { formId: 'child' } } }]);
    expect((await resolve(project, db)).items[0]).toMatchObject({ description: 'Young actor', formLabel: 'Childhood', images: ['child.png'] });
    db.getIngredient.mockResolvedValue({ id: subject.ingredientId, type: 'character', payload: { forms: [] } });
    expect((await resolve(project, db)).problems[0].code).toBe('CATALOG_FORM_MISSING');
  });

  it('does not let a canonical guide hide the selected form own catalog image', async () => {
    const project = fixture({ concept: { subjects: [{ ...subject, castForm: { id: 'child' } }] } });
    const db = catalog({ forms: [{ id: 'child', label: 'Childhood', description: 'Young actor' }] }, [
      { kind: 'portrait', mediaKey: 'canonical.png', library: { guide: true } },
      { kind: 'reference', mediaKey: 'child.png', library: { variant: { formId: 'child' } } },
    ]);
    const result = await resolve(project, db);
    expect(result.problems).toEqual([]);
    expect(result.items[0].images).toEqual(['child.png']);
  });

  it('fails closed for unavailable catalog, missing files, wrong kinds and empty casts', async () => {
    const db = catalog();
    db.getIngredient.mockRejectedValue(new Error('offline'));
    expect((await resolve(fixture(), db)).problems[0].code).toBe('CATALOG_UNAVAILABLE');
    expect((await resolveCatalogCheckin(fixture(), { catalog: catalog(), exists: () => false })).problems[0].code).toBe('CATALOG_IMAGES_REQUIRED');
    db.getIngredient.mockResolvedValue({ id: subject.ingredientId, type: 'place' });
    expect((await resolve(fixture(), db)).problems[0].code).toBe('CATALOG_RECORD_MISSING');
    expect((await resolve(fixture({ concept: { subjects: [] } }))).problems[0].code).toBe('CATALOG_SUBJECTS_REQUIRED');
  });

  it('approves code-only catalog identities without requiring or injecting images', async () => {
    const project = fixture({ mediaMode: 'code-only' });
    const db = catalog({ primaryImageRef: 'catalog.png', physicalDescription: 'A procedural character' });
    db.listMediaForIngredient.mockRejectedValue(new Error('Image store not required'));
    const first = await resolve(project, db);
    expect(first.problems).toEqual([]);
    expect(first.items[0]).toMatchObject({ description: 'A procedural character', images: [] });
    expect(db.listMediaForIngredient).not.toHaveBeenCalled();
    project.castAndSets.status = 'approved';
    project.castAndSets.catalogApprovedBasis = first.basis;
    expect((await resolve(project, db)).approved).toBe(true);
    db.getIngredient.mockResolvedValue(null);
    expect((await resolve(project, db)).problems[0].code).toBe('CATALOG_RECORD_MISSING');
  });

  it('hydrates catalog projects only, and refuses legacy operations for them', async () => {
    const legacy = { castAndSets: { images: {} } };
    expect(await withCatalogCheckin(legacy)).toBe(legacy);
    expect(() => assertLegacyCheckin(legacy)).not.toThrow();
    expect(() => assertLegacyCheckin(fixture())).toThrow('links directly');
    const project = fixture();
    expect((await withCatalogCheckin(project, { catalog: catalog(), exists: () => true })).castAndSets.catalogCheckin.items[0].images).toEqual(['catalog.png']);
    expect(project.castAndSets.catalogCheckin).toBeUndefined();
  });
});
