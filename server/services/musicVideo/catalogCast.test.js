import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/pgFileFacade.js', () => ({ isFileBackend: () => false }));

import { createHash } from 'crypto';

const { saveCheckinCastToCatalog, previewCatalogCastImport, commitCatalogCastImport } = await import('./catalogCast.js');

// The deterministic catalog id two synced machines both derive for a subject.
const PREFIX = { character: 'chr', place: 'plc', object: 'obj' };
const musicVideoCastIngredientId = (projectId, { id, kind }) =>
  `cat-${PREFIX[kind]}-mv-${createHash('sha256').update(`music-video:${projectId}:${kind}:${id}`).digest('hex').slice(0, 32)}`;

// In-memory catalog + project store behind the injected deps.
function makeDeps({ projects, universes = {}, rows = [], universeLinks = {} }) {
  const ingredients = new Map(rows.map((r) => [r.id, { deleted: false, ...r }]));
  const media = [];
  const catalogDB = {
    getIngredient: vi.fn(async (id) => { const r = ingredients.get(id); return r && !r.deleted ? r : null; }),
    createIngredient: vi.fn(async (input) => {
      if (ingredients.has(input.id)) throw Object.assign(new Error('duplicate key'), { code: '23505' });
      ingredients.set(input.id, { ...input, deleted: false });
      return input;
    }),
    attachMedia: vi.fn(async (id, key, kind, opts) => { media.push({ id, key, kind, caption: opts?.caption }); }),
    listIngredientsForRef: vi.fn(async (kind, refId) => (universeLinks[refId] || []).map((id) => ({ ingredient: ingredients.get(id), role: 'cast' }))),
  };
  const deps = {
    catalogDB,
    getUniverse: vi.fn(async (id) => { if (!universes[id]) throw Object.assign(new Error('Universe not found'), { code: 'NOT_FOUND' }); return universes[id]; }),
    getProject: vi.fn(async (id) => projects.find((p) => p.id === id) || null),
    listProjects: vi.fn(async () => projects.filter((p) => !p.deleted)),
    mutateProjectRecord: vi.fn(async (id, transform) => {
      const i = projects.findIndex((p) => p.id === id);
      const { project } = transform(projects[i]);
      projects[i] = project;
      return { project };
    }),
    queueProjectCatalogLinkSync: vi.fn(),
  };
  return { deps, ingredients, media };
}

const approvedStage = {
  status: 'approved',
  direction: { protagonist: { name: 'Ada' }, cast: [{ id: 'bo', name: 'Bo' }], sets: [{ id: 'diner', name: 'Night diner' }] },
  images: {
    character: { status: 'done', imageId: 'ada-sheet.png' },
    'cast:bo': { status: 'failed', imageId: null },
    'set:diner': { status: 'done', imageId: 'diner-plate.png' },
  },
};

const videoProject = () => ({
  id: 'mv-1',
  name: 'Example Video',
  castAndSets: approvedStage,
  visualSpec: { references: [{ id: 'r1', imageId: 'guitar.png', role: 'prop', label: 'Glass guitar' }] },
  concept: {
    universeId: 'u-1',
    subjects: [
      { id: 'cs-protagonist', kind: 'character', name: 'Ada', description: 'Red scarf' },
      { id: 'cs-cast-bo', kind: 'character', name: 'Bo' },
      { id: 'cs-set-diner', kind: 'place', name: 'Night diner', description: 'Chrome booths' },
      { id: 'mvc-1', kind: 'object', name: 'Glass guitar' },
      { id: 'mvc-2', kind: 'character', name: 'Cal', canonId: 'c-cal' },
      { id: 'mvc-3', kind: 'place', name: 'Linked', ingredientId: 'cat-plc-9' },
      { id: 'mvc-4', kind: 'object', name: 'Private', localOnly: true },
    ],
  },
});

describe('which subjects are offered', () => {
  it('offers uncatalogued subjects with their sheet, plate or pulled reference image, and saves only check-in ones on approval', async () => {
    const projects = [videoProject()];
    const { deps } = makeDeps({ projects });
    const [preview] = await previewCatalogCastImport(deps);
    expect(preview.items.map((i) => [i.subjectId, i.imageId])).toEqual([
      ['cs-protagonist', 'ada-sheet.png'],
      ['cs-cast-bo', null],
      ['cs-set-diner', 'diner-plate.png'],
      ['mvc-1', 'guitar.png'],
      ['mvc-2', null],
    ]);
    await saveCheckinCastToCatalog('mv-1', deps);
    expect(projects[0].concept.subjects.filter((s) => s.ingredientId && s.id !== 'mvc-3').map((s) => s.id)).toEqual(['cs-protagonist', 'cs-cast-bo', 'cs-set-diner']);
  });
});

describe('saving approved Cast & Sets cast', () => {
  let projects;
  beforeEach(() => { projects = [videoProject()]; });

  it('creates check-in cast and sets with their images, reusing a same-named universe record', async () => {
    const { deps, ingredients, media } = makeDeps({
      projects,
      universes: { 'u-1': { id: 'u-1', characters: [] } },
      rows: [{ id: 'cat-chr-bo', type: 'character', name: 'bo' }],
      universeLinks: { 'u-1': ['cat-chr-bo'] },
    });

    const result = await saveCheckinCastToCatalog('mv-1', deps);

    expect(result).toMatchObject({ created: 2, linked: 1, kept: 0 });
    const leadId = musicVideoCastIngredientId('mv-1', { id: 'cs-protagonist', kind: 'character' });
    expect(leadId).toMatch(/^cat-chr-mv-[0-9a-f]{32}$/);
    expect(ingredients.get(leadId)).toMatchObject({ type: 'character', name: 'Ada', payload: { physicalDescription: 'Red scarf' }, tags: ['Example Video'] });
    expect(media).toEqual([
      { id: leadId, key: 'ada-sheet.png', kind: 'reference', caption: 'From Example Video' },
      expect.objectContaining({ key: 'diner-plate.png', kind: 'reference' }),
    ]);
    const subjects = projects[0].concept.subjects;
    expect(subjects.find((s) => s.id === 'cs-protagonist').ingredientId).toBe(leadId);
    expect(subjects.find((s) => s.id === 'cs-cast-bo').ingredientId).toBe('cat-chr-bo');
    expect(subjects.find((s) => s.id === 'mvc-1').ingredientId).toBeUndefined();
    expect(deps.queueProjectCatalogLinkSync).toHaveBeenCalledWith('mv-1');
  });

  it('links to the row a synced machine already saved, and leaves a subject whose record was deleted in the video', async () => {
    const leadId = musicVideoCastIngredientId('mv-1', { id: 'cs-protagonist', kind: 'character' });
    const dinerId = musicVideoCastIngredientId('mv-1', { id: 'cs-set-diner', kind: 'place' });
    const { deps } = makeDeps({
      projects,
      rows: [{ id: leadId, type: 'character', name: 'Ada' }, { id: dinerId, type: 'place', name: 'Night diner', deleted: true }],
    });

    const result = await saveCheckinCastToCatalog('mv-1', deps);

    expect(result).toMatchObject({ created: 1, linked: 1, kept: 1 });
    const subjects = projects[0].concept.subjects;
    expect(subjects.find((s) => s.id === 'cs-protagonist').ingredientId).toBe(leadId);
    expect(subjects.find((s) => s.id === 'cs-set-diner')).toMatchObject({ localOnly: true });
    expect(subjects.find((s) => s.id === 'cs-set-diner').ingredientId).toBeUndefined();
  });
});

describe('music video cast import', () => {
  it('previews every video with a proposal, then applies the reviewed decisions', async () => {
    const projects = [videoProject(), { id: 'mv-2', name: 'Done', concept: { subjects: [{ id: 'a', kind: 'place', name: 'X', ingredientId: 'cat-plc-1' }] } }];
    const { deps, ingredients } = makeDeps({
      projects,
      universes: { 'u-1': { id: 'u-1', characters: [{ id: 'c-cal', name: 'Cal', ingredientId: 'cat-chr-cal' }] } },
      rows: [{ id: 'cat-chr-cal', type: 'character', name: 'Cal' }],
    });

    const preview = await previewCatalogCastImport(deps);
    expect(preview).toHaveLength(1);
    expect(preview[0]).toMatchObject({ projectId: 'mv-1', name: 'Example Video' });
    expect(preview[0].items.find((i) => i.subjectId === 'mvc-2')).toMatchObject({ action: 'link', ingredientId: 'cat-chr-cal', ingredientName: 'Cal' });
    expect(preview[0].items.find((i) => i.subjectId === 'mvc-1')).toMatchObject({ action: 'create' });

    const totals = await commitCatalogCastImport([
      { projectId: 'mv-1', subjectId: 'mvc-2', action: 'link', ingredientId: 'cat-chr-cal' },
      { projectId: 'mv-1', subjectId: 'mvc-1', action: 'create' },
      { projectId: 'mv-1', subjectId: 'cs-cast-bo', action: 'local' },
      { projectId: 'mv-1', subjectId: 'cs-set-diner', action: 'link', ingredientId: 'cat-chr-cal' },
    ], deps);

    expect(totals).toEqual({ projects: 1, created: 1, linked: 1, kept: 1 });
    const subjects = projects[0].concept.subjects;
    expect(subjects.find((s) => s.id === 'mvc-2').ingredientId).toBe('cat-chr-cal');
    expect(ingredients.get(subjects.find((s) => s.id === 'mvc-1').ingredientId)).toMatchObject({ type: 'object', name: 'Glass guitar' });
    expect(subjects.find((s) => s.id === 'cs-cast-bo').localOnly).toBe(true);
    // A link to a record of another type is refused.
    expect(subjects.find((s) => s.id === 'cs-set-diner').ingredientId).toBeUndefined();

    // Committing again changes nothing.
    expect(await commitCatalogCastImport([{ projectId: 'mv-1', subjectId: 'mvc-1', action: 'create' }], deps)).toEqual({ projects: 0, created: 0, linked: 0, kept: 0 });
  });
});

describe('re-approving Cast & Sets', () => {
  it('keeps each regenerated subject\'s catalog link and keep-local choice', async () => {
    const { castAndSetsSubjects } = await import('./castAndSetsPlan.js');
    const project = { concept: { subjects: [
      { id: 'cs-protagonist', kind: 'character', name: 'Ada', ingredientId: 'cat-chr-ada' },
      { id: 'cs-set-diner', kind: 'place', name: 'Night diner', localOnly: true },
    ] } };
    const stage = { direction: { protagonist: { name: 'Ada', face: 'Freckles' }, sets: [{ id: 'diner', name: 'Night diner' }, { id: 'roof', name: 'Rooftop' }] } };
    expect(castAndSetsSubjects(project, stage)).toEqual([
      expect.objectContaining({ id: 'cs-protagonist', description: 'Freckles', ingredientId: 'cat-chr-ada' }),
      expect.objectContaining({ id: 'cs-set-diner', localOnly: true }),
      expect.not.objectContaining({ ingredientId: expect.anything() }),
    ]);
  });
});
