import { describe, expect, it, vi } from 'vitest';
import { resolveCatalogCheckin, withCatalogCheckin, assertCatalogCheckinReady, assertLegacyCheckin, dropStaleCatalogPicks } from './catalogCheckin.js';
import { musicVideoCatalogReferenceId as refId } from '../../lib/musicVideoConditioning.js';
import { musicVideoReferenceChoices, musicVideoCatalogPickPlans } from '../../lib/musicVideoConditioning.js';

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

describe('automatic clean-up of stale catalog shot picks (#15317)', () => {
  const lamp = { id: 'subject-lamp', ingredientId: 'object-lamp', kind: 'object', name: 'Pocket lamp' };
  const items = [
    { subjectId: subject.id, name: 'Example actor', images: ['actor.png'], retiredImages: ['actor-old.png'] },
    { subjectId: lamp.id, name: 'Pocket lamp', images: ['lamp.png'], retiredImages: [] },
  ];
  const current = (problems = []) => ({ concept: { subjects: [subject, lamp] }, castAndSets: { source: 'catalog', catalogCheckin: { items, problems } } });
  const shot = { sceneId: 'shot-a', frameReferenceIds: [refId(subject.id, 'actor.png'), refId(lamp.id, 'lamp.png'), 'palette'], clipReferenceIds: [refId(lamp.id, 'lamp.png')] };
  const next = (subjects, scenes = [shot]) => ({ ...current(), concept: { subjects }, scenes });

  // Uniquely catches a removed subject's image staying picked on a shot after the subject goes.
  it('drops a removed subject\'s picks from every shot in the same write', () => {
    const cleaned = dropStaleCatalogPicks(current(), next([subject]));
    expect(cleaned.scenes[0]).toEqual({ sceneId: 'shot-a', frameReferenceIds: [refId(subject.id, 'actor.png'), 'palette'], clipReferenceIds: [] });
    // Even when another subject has an open check-in problem.
    expect(dropStaleCatalogPicks(current([{ subjectId: subject.id, code: 'CATALOG_UNAVAILABLE' }]), next([subject])).scenes[0].frameReferenceIds)
      .toEqual([refId(subject.id, 'actor.png'), 'palette']);
  });

  it('clears picks no record holds, keeps a still-listed image, and changes nothing with an unresolved check-in', () => {
    const gone = refId('subject-removed-earlier', 'old.png');
    const retired = refId(subject.id, 'actor-old.png');
    const scenes = [{ sceneId: 'shot-b', frameReferenceIds: [gone, retired] }];
    expect(dropStaleCatalogPicks(current(), next([subject, lamp], scenes)).scenes[0].frameReferenceIds).toEqual([retired]);
    const unresolved = next([subject, lamp], scenes);
    expect(dropStaleCatalogPicks(current([{ subjectId: lamp.id, code: 'CATALOG_UNAVAILABLE' }]), unresolved)).toBe(unresolved);
  });

  it('lists still-on-record images it does not offer without changing the approval basis', async () => {
    const offered = await resolve(fixture());
    const db = catalog({}, [{ kind: 'portrait', mediaKey: 'catalog.png' }, { kind: 'audio', mediaKey: 'theme.mp3' }]);
    const withRetired = await resolve(fixture(), db);
    expect(withRetired.items[0]).toMatchObject({ images: ['catalog.png'], retiredImages: ['theme.mp3'] });
    expect(withRetired.basis).toBe(offered.basis);
  });
});

describe('environment picks beyond the Auto set (#15544)', () => {
  const place = { id: 'subject-house', ingredientId: 'env-house', kind: 'place', name: 'Example house' };
  const stamp = (n) => `2026-01-0${n}T00:00:00.000Z`;
  const views = (count) => Array.from({ length: count }, (_, i) => ({ kind: 'reference', mediaKey: `view-${i + 1}.png`, createdAt: stamp(i + 1) }));
  const db = (media) => ({ getIngredient: vi.fn(async () => ({ id: place.ingredientId, type: 'place', name: 'House', payload: {} })), listMediaForIngredient: vi.fn(async () => media) });
  const project = (pick) => ({ concept: { subjects: [place] }, castAndSets: { source: 'catalog', status: 'review' },
    scenes: [{ sceneId: 'shot-a', frameReferenceIds: [refId(place.id, pick)] }] });
  const withReport = async (media, pick) => {
    const resolved = await resolveCatalogCheckin(project(pick), { catalog: db(media), exists: () => true });
    return { resolved, choices: musicVideoReferenceChoices({ ...project(pick), castAndSets: { source: 'catalog', catalogCheckin: resolved } }) };
  };

  // Uniquely catches the 4-image cap hiding older views from explicit shot picks.
  it('offers every non-rejected view as a pick while Auto keeps the capped set, and a 7th image keeps the pick', async () => {
    for (const count of [6, 7]) {
      const { resolved, choices } = await withReport(views(count), 'view-1.png');
      expect(resolved.items[0].images).toHaveLength(4);
      expect(resolved.items[0].pickableImages).toHaveLength(count - 4);
      expect(choices.map(ref => ref.imageId)).toContain('view-1.png');
      expect(choices.find(ref => ref.imageId === 'view-1.png').condition).toBe(false);
      expect(resolved.items[0].retiredImages).toEqual([]);
      expect(musicVideoCatalogPickPlans({ ...project('view-1.png'), castAndSets: { source: 'catalog', catalogCheckin: resolved } })).toEqual([]);
    }
  });

  it('does not change the approval basis when images are added', async () => {
    const six = await resolveCatalogCheckin(project('view-1.png'), { catalog: db(views(6)), exists: () => true });
    const sixPlusOlder = await resolveCatalogCheckin(project('view-1.png'), { catalog: db([...views(6), { kind: 'reference', mediaKey: 'ancient.png', createdAt: '2025-01-01T00:00:00.000Z' }]), exists: () => true });
    expect(sixPlusOlder.basis).toBe(six.basis);
  });
});
