import { describe, expect, it, vi } from 'vitest';
import { createCatalogReads, resolveCatalogCheckin, withCatalogCheckin, assertCatalogCheckinReady, assertLegacyCheckin, dropStaleCatalogPicks } from './catalogCheckin.js';
import { musicVideoCatalogReferenceId as refId } from '../../lib/musicVideo/musicVideoConditioning.js';
import { musicVideoReferenceChoices, musicVideoCatalogPickPlans } from '../../lib/musicVideo/musicVideoConditioning.js';

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

describe('look-around angle plates in shots (#16145)', () => {
  const place = { id: 'subject-quay', ingredientId: 'env-quay', kind: 'place', name: 'Example quay' };
  const angle = (n, bearingDeg, label) => ({ kind: 'reference', role: 'plate', mediaKey: `angle-${n}.png`, createdAt: `2026-02-0${n}T00:00:00.000Z`,
    library: { variant: { label }, angle: { clipId: 'clip-1', atSec: n, sourceMediaKey: 'plate.png', bearingDeg, motion: 'full-turn' } } });
  const media = [{ kind: 'reference', role: 'plate', mediaKey: 'plate.png', createdAt: '2026-01-01T00:00:00.000Z' }, angle(1, 90, '90° right'), angle(2, 180, '180° behind')];
  const db = { getIngredient: vi.fn(async () => ({ id: place.ingredientId, type: 'place', name: 'Quay', payload: {} })), listMediaForIngredient: vi.fn(async () => media) };
  const shot = (sceneId, file) => ({ sceneId, takes: [], frameReferenceIds: [refId(place.id, file)] });
  const project = (scenes) => ({ concept: { subjects: [place] }, castAndSets: { source: 'catalog', status: 'review' }, scenes });

  // Catches angle plates reaching the picker unlabelled, or a new angle staling an approval.
  it('offers each angle labelled by its bearing with its shared-geometry lineage', async () => {
    const resolved = await resolveCatalogCheckin(project([shot('a', 'plate.png')]), { catalog: db, exists: () => true });
    const choices = musicVideoReferenceChoices({ ...project([]), castAndSets: { source: 'catalog', catalogCheckin: resolved } });
    expect(choices.find(ref => ref.imageId === 'angle-1.png')).toMatchObject({ role: 'set', label: 'Quay · 90° right',
      angle: { clipId: 'clip-1', sourceMediaKey: 'plate.png', bearingDeg: 90 } });
    expect(choices.find(ref => ref.imageId === 'plate.png').label).toBe('Quay');
    expect(resolved.items[0].angles['angle-1.png']).toMatchObject({ label: '90° right', clipId: 'clip-1' });
    const unlabelled = media.map(({ library: _library, ...row }) => row);
    const plain = await resolveCatalogCheckin(project([shot('a', 'plate.png')]), { catalog: { ...db, listMediaForIngredient: async () => unlabelled }, exists: () => true });
    expect(plain.items[0].angles).toBeUndefined();
    expect(plain.basis).toBe(resolved.basis);
  });

  // Catches cutting between angles of one clip being reported as "different plates", and a long
  // run on one view going unnoticed.
  it('treats angles of one clip as one plate and warns on three consecutive shots from the same view', async () => {
    const scenes = [shot('s1', 'plate.png'), shot('s2', 'angle-1.png'), shot('s3', 'angle-1.png'), shot('s4', 'angle-1.png'), shot('s5', 'angle-2.png')];
    const resolved = await resolveCatalogCheckin(project(scenes), { catalog: db, exists: () => true });
    expect(resolved.shotReferenceProblems.map(({ sceneId, code }) => [sceneId, code])).toEqual([['s4', 'same-angle']]);
    expect(resolved.shotReferenceProblems[0].message).toMatch(/3 shots in a row at Quay use the same view/);
    expect(resolved.shotReferenceProblems[0].fix).toBeUndefined();
  });
});

describe('videos above the old 24-subject cap (#16205)', () => {
  const COUNT = 60;
  const places = Array.from({ length: COUNT }, (_, i) => ({ id: `subject-p${i}`, ingredientId: `env-${i}`, kind: 'place', name: `Place ${i}` }));
  const db = (imageFor = i => `plate-${i}.png`) => ({
    getIngredient: vi.fn(async id => ({ id, type: 'place', name: id, payload: {} })),
    listMediaForIngredient: vi.fn(async id => [{ kind: 'reference', role: 'plate', mediaKey: imageFor(Number(id.slice(4))), createdAt: '2026-01-01T00:00:00.000Z' }]),
  });
  const project = (scenes = []) => ({ concept: { subjects: places }, castAndSets: { source: 'catalog', status: 'review' }, scenes });
  const run = (p, catalog) => resolveCatalogCheckin(p, { catalog, exists: () => true });

  // Uniquely catches a cap silently truncating the check-in or leaving the last subject out of the basis hash.
  it('checks in every subject and stales the basis when only the last one changes', async () => {
    const first = await run(project(), db());
    expect(first.items).toHaveLength(COUNT);
    expect(first.problems).toEqual([]);
    const changed = await run(project(), db(i => (i === COUNT - 1 ? 'new-plate.png' : `plate-${i}.png`)));
    expect(changed.basis).not.toBe(first.basis);
  });

  // Uniquely catches the shot reference picker dropping choices past the old cap.
  it('offers a shot pick for every subject, including those past the old cap', async () => {
    const resolved = await run(project([{ sceneId: 'a', takes: [] }]), db());
    const choices = musicVideoReferenceChoices({ ...project([]), castAndSets: { source: 'catalog', catalogCheckin: resolved } });
    expect(choices.find(ref => ref.imageId === 'plate-59.png')).toMatchObject({ role: 'set', label: 'env-59' });
    expect(resolved.shotReferenceProblems).toEqual([]);
  });
});

describe('catalog reads per check-in (#16210)', () => {
  const linked = Array.from({ length: 6 }, (_, i) => ({ id: `subject-${i}`, ingredientId: `character-${i}`, kind: 'character', name: `Actor ${i}` }));
  const gatedCatalog = () => {
    let inFlight = 0;
    let peak = 0;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const track = async (value) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await gate;
      inFlight -= 1;
      return value;
    };
    const db = {
      getIngredient: vi.fn((id) => track({ id, type: 'character', name: id, payload: {} })),
      listMediaForIngredient: vi.fn((id) => track([{ kind: 'portrait', mediaKey: `${id}.png` }])),
    };
    return { db, release, peak: () => peak };
  };

  // Uniquely catches the check-in going back to one catalog round trip per subject in turn,
  // which made a many-subject video wait on every reply in a row on each read and write.
  it('asks for every linked record before waiting on any reply', async () => {
    const { db, release, peak } = gatedCatalog();
    const pending = resolveCatalogCheckin(fixture({ concept: { subjects: linked } }), { catalog: db, exists: () => true });
    await vi.waitFor(() => expect(peak()).toBe(linked.length * 2));
    release();
    const result = await pending;
    expect(result.items.map(item => item.images)).toEqual(linked.map(subject => [`${subject.ingredientId}.png`]));
    expect(result.problems).toEqual([]);
  });

  // Uniquely catches a read route that resolves the light and the full check-in paying for the catalog twice.
  it('shares one request\'s reads between check-ins and answers the same as a fresh read', async () => {
    const project = fixture({ concept: { subjects: [...linked, { ...linked[0], id: 'same-record-again' }] } });
    const db = catalog();
    const reads = createCatalogReads();
    const light = await withCatalogCheckin(project, { catalog: db, exists: () => true, reads });
    const full = await resolveCatalogCheckin(project, { catalog: db, exists: () => true, reads });
    expect(db.getIngredient).toHaveBeenCalledTimes(linked.length);
    expect(db.listMediaForIngredient).toHaveBeenCalledTimes(linked.length);
    expect(full).toEqual(await resolveCatalogCheckin(project, { catalog: catalog(), exists: () => true }));
    expect(light.castAndSets.catalogCheckin.basis).toBe(full.basis);
    // Another catalog never answers from these reads.
    const other = catalog();
    await resolveCatalogCheckin(project, { catalog: other, exists: () => true, reads });
    expect(other.getIngredient).toHaveBeenCalledTimes(linked.length);
  });

  it('never overlaps catalog reads on a transaction client, but still overlaps pool reads', async () => {
    const project = fixture({ concept: { subjects: [subject, { ...subject, id: 'other', ingredientId: 'character-other' }] } });
    const run = async (client) => {
      let active = 0; let peak = 0;
      const guarded = (value) => vi.fn(async () => { active++; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 2)); active--; return value; });
      const db = { getIngredient: guarded({ id: subject.ingredientId, type: 'character', name: 'Actor', payload: {} }), listMediaForIngredient: guarded([{ kind: 'portrait', mediaKey: 'a.png' }]) };
      await resolveCatalogCheckin(project, { catalog: db, exists: () => true, ...(client ? { client } : {}) });
      return peak;
    };
    expect(await run({})).toBe(1);
    expect(await run(null)).toBeGreaterThan(1);
  });
});
