import { describe, expect, it, vi } from 'vitest';
import { loadSceneCastMedia } from './castGuideMedia.js';

const project = { concept: { subjects: [
  { id: 'a', kind: 'character', ingredientId: 'cat-a' },
  { id: 'b', kind: 'character', ingredientId: 'cat-b' },
  { id: 'set', kind: 'place', ingredientId: 'cat-set' },
] } };

describe('loadSceneCastMedia', () => {
  it('reads nothing for a scene with no cast member or catalog pick', async () => {
    const listMedia = vi.fn();
    expect(await loadSceneCastMedia({ frameReferenceIds: ['own'] }, { listMedia, project })).toBeNull();
    expect(listMedia).not.toHaveBeenCalled();
  });

  // Uniquely catches a picked catalog sheet that shows on the card but is missing from the server's render.
  it('loads every linked character for a scene that picked a catalog asset', async () => {
    const listMedia = vi.fn(async (id) => [{ mediaKey: `${id}.png` }]);
    const media = await loadSceneCastMedia({ clipReferenceIds: ['mvr-linked-cat-b.png'] }, { listMedia, project });
    expect(Object.keys(media)).toEqual(['cat-a', 'cat-b']);
  });

  it('keeps the members that loaded when another read fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const listMedia = vi.fn(async (id) => { if (id === 'cat-a') throw new Error('down'); return []; });
    expect(await loadSceneCastMedia({ frameReferenceIds: ['mvr-linked-x.png'] }, { listMedia, project })).toEqual({ 'cat-b': [] });
    warn.mockRestore();
  });
});
