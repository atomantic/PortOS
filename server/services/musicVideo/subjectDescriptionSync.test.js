import { describe, expect, it, vi } from 'vitest';
import { preserveUnchangedDescriptionSnapshots, resolveProjectCatalogDescriptions, syncEditedSubjectDescriptions } from './subjectDescriptionSync.js';
import { changedMusicVideoDescriptionOverLimit } from '../../lib/musicVideoSubjectLimits.js';

const project = (subjects) => ({ id: 'mv-example', concept: { subjects } });
const object = (description) => ({ id: 'prop', kind: 'object', name: 'Lantern', ingredientId: 'cat-obj-example', description });
const character = (description) => ({ id: 'cast', kind: 'character', name: 'Example', ingredientId: 'cat-chr-example', castForm: { id: 'teen', label: 'Teen' }, description });

function catalogFixture() {
  const rows = new Map([
    ['cat-obj-example', { id: 'cat-obj-example', type: 'object', payload: { description: 'Old lantern', color: 'blue' } }],
    ['cat-chr-example', { id: 'cat-chr-example', type: 'character', payload: { physicalDescription: 'Adult look', forms: [{ id: 'teen', description: 'Old teen look', hair: 'dark' }] } }],
  ]);
  return { rows, catalogDB: {
    getIngredient: vi.fn(async (id) => rows.get(id)),
    getIngredientDescriptionsByRequestedIds: vi.fn(async (ids) => new Map(ids.filter((id) => rows.has(id)).map((id) => [id, rows.get(id)]))),
    updateIngredientPayloadKeys: vi.fn(async (id, update) => {
      const record = rows.get(id);
      record.payload = { ...record.payload, ...update(record.payload) };
      return { ingredient: record };
    }),
  } };
}

describe('editing catalog-linked descriptions in a music video', () => {
  it('updates the right catalog field or age form without overwriting another subject snapshot', async () => {
    const { rows, catalogDB } = catalogFixture();
    const before = project([object('Old lantern'), { ...object('Old lantern'), id: 'prop-copy' }, character('Old teen look')]);
    const after = project([object('New lantern'), { ...object('Old lantern'), id: 'prop-copy' }, character('New teen look')]);
    const result = await syncEditedSubjectDescriptions(before, after, { client: {}, catalogDB, bases: [
      { subjectId: 'prop', description: 'Old lantern' }, { subjectId: 'cast', description: 'Old teen look' },
    ] });
    expect(rows.get('cat-obj-example').payload).toEqual({ description: 'New lantern', color: 'blue' });
    expect(rows.get('cat-chr-example').payload).toEqual({ physicalDescription: 'Adult look', forms: [{ id: 'teen', description: 'New teen look', hair: 'dark' }] });
    expect(result.project.concept.subjects.map((subject) => subject.description)).toEqual(['New lantern', 'Old lantern', 'New teen look']);
    expect(result.records).toHaveLength(2);
  });

  it('refuses a stale catalog edit rather than overwriting it', async () => {
    const { rows, catalogDB } = catalogFixture();
    rows.get('cat-obj-example').payload.description = 'Newer catalog edit';
    await expect(syncEditedSubjectDescriptions(project([object('Old lantern')]), project([object('Video edit')]), {
      client: {}, catalogDB, bases: [{ subjectId: 'prop', description: 'Old lantern' }],
    })).rejects.toMatchObject({ code: 'CATALOG_DESCRIPTION_CONFLICT', status: 409 });
    expect(rows.get('cat-obj-example').payload.description).toBe('Newer catalog edit');
  });

  it('keeps a newly imported overlong description intact until the user supplies a shorter value', async () => {
    const { rows, catalogDB } = catalogFixture();
    const long = 'x'.repeat(1001);
    rows.get('cat-obj-example').payload.description = long;
    const result = await syncEditedSubjectDescriptions(project([]), project([object('Short lantern')]), {
      client: {}, catalogDB, includeNewLinks: true, bases: [{ subjectId: 'prop', description: long }],
    });
    expect(result.project.concept.subjects[0].description).toBe('Short lantern');
    expect(rows.get('cat-obj-example').payload.description).toBe('Short lantern');
  });

  it('reads the latest catalog value while preserving the previous snapshot on unrelated writes', async () => {
    const { rows, catalogDB } = catalogFixture();
    rows.get('cat-obj-example').payload.description = 'New catalog description';
    const stored = project([object('Previous video description')]);
    const resolved = await resolveProjectCatalogDescriptions(stored, { catalogDB });
    expect(resolved.concept.subjects[0].description).toBe('New catalog description');
    expect(stored.concept.subjects[0].description).toBe('Previous video description');
    const unrelated = { ...resolved, name: 'Changed project title' };
    const saved = preserveUnchangedDescriptionSnapshots(stored, resolved, unrelated);
    expect(saved.concept.subjects[0].description).toBe('Previous video description');
    expect(preserveUnchangedDescriptionSnapshots(stored, resolved, unrelated, ['prop']).concept.subjects[0].description).toBe('New catalog description');
  });

  it('keeps the stored snapshot when the linked catalog description exceeds the video limit', async () => {
    const { rows, catalogDB } = catalogFixture();
    rows.get('cat-obj-example').payload.description = 'x'.repeat(1001);
    const resolved = await resolveProjectCatalogDescriptions(project([object('Existing snapshot')]), { catalogDB });
    expect(resolved.concept.subjects[0].description).toBe('Existing snapshot');
  });

  it('allows unrelated edits to a long legacy description but flags a new overlong main or look description', () => {
    const long = 'x'.repeat(1001);
    const previous = { physicalDescription: long, forms: [{ id: 'teen', description: 'Short' }] };
    expect(changedMusicVideoDescriptionOverLimit('character', previous, { ...previous, role: 'Updated' })).toBeNull();
    expect(changedMusicVideoDescriptionOverLimit('character', previous, { ...previous, physicalDescription: `${long}x` })).toMatchObject({ field: 'physicalDescription', length: 1002 });
    expect(changedMusicVideoDescriptionOverLimit('character', previous, { ...previous, forms: [{ id: 'teen', description: long }] })).toMatchObject({ field: 'forms', formId: 'teen', length: 1001 });
  });
});
