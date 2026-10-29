import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = vi.hoisted(() => ({ project: null, beforeLock: null }));
vi.mock('./projects.js', () => ({
  getProject: async () => structuredClone(store.project),
  mutateProjectRecord: async (_id, transform) => {
    store.beforeLock?.(store.project);
    const outcome = await transform(structuredClone(store.project));
    if (!outcome.skipPersist) store.project = outcome.project;
    return { ...outcome, project: structuredClone(store.project) };
  },
}));

const { labelProjectReferences } = await import('./referenceLabels.js');

const owners = new Map([
  ['nora-sheet.png', { ingredientId: 'cat-nora', name: 'Nora Example', preferredId: 'cat-nora-alias' }],
  ['rink.png', { ingredientId: 'cat-rink', name: 'Example Rink', preferredId: null }],
  ['erin.png', { ingredientId: 'cat-erin', name: 'Erin Example', preferredId: null }],
]);
const findOwners = vi.fn(async () => owners);
const ref = (id, imageId, label = '') => ({ id, imageId, role: 'character', label, condition: false });

beforeEach(() => {
  findOwners.mockClear();
  store.beforeLock = null;
  store.project = {
    id: 'mv-1',
    concept: { subjects: [{ id: 's1', kind: 'character', name: 'Nora', ingredientId: 'cat-nora-alias' }] },
    visualSpec: { references: [
      ref('r1', 'nora-sheet.png'), ref('r2', 'rink.png', '   '), ref('r3', 'erin.png', 'Mom'), ref('r4', 'gallery.png'),
    ] },
  };
});

describe('labelProjectReferences', () => {
  it('names unlabeled references as the video names its linked cast, else by catalog name', async () => {
    const result = await labelProjectReferences('mv-1', { findOwners });

    expect(findOwners).toHaveBeenCalledWith(['nora-sheet.png', 'rink.png', 'gallery.png'], { preferIds: ['cat-nora-alias'] });
    expect(result.labels).toEqual({ r1: 'Nora', r2: 'Example Rink' });
    expect(store.project.visualSpec.references.map((r) => r.label)).toEqual(['Nora', 'Example Rink', 'Mom', '']);
  });

  it('keeps a label the director typed while the catalog was being read', async () => {
    store.beforeLock = (project) => { project.visualSpec.references[0].label = 'Lead'; };
    const result = await labelProjectReferences('mv-1', { findOwners });

    expect(result.labels).toEqual({ r2: 'Example Rink' });
    expect(store.project.visualSpec.references[0].label).toBe('Lead');
  });

  it('leaves an approved project alone on backfill but names a director\'s own addition', async () => {
    store.project.productionReview = { approvals: { art: { approvedAt: '2026-01-01T00:00:00.000Z' } } };

    expect(await labelProjectReferences('mv-1', { backfill: true, findOwners })).toBeNull();
    expect(findOwners).not.toHaveBeenCalled();
    expect((await labelProjectReferences('mv-1', { findOwners })).labels).toEqual({ r1: 'Nora', r2: 'Example Rink' });
  });

  it('writes nothing when no image belongs to the catalog, and survives a failed lookup', async () => {
    store.project.visualSpec.references = [ref('r4', 'gallery.png')];
    const before = store.project;
    expect(await labelProjectReferences('mv-1', { findOwners })).toBeNull();
    expect(store.project).toBe(before);

    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await labelProjectReferences('mv-1', { findOwners: async () => { throw new Error('db down'); } })).toBeNull();
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });
});
