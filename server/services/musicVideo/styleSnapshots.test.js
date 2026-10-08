import { describe, it, expect, vi, beforeEach } from 'vitest';

const getUniverse = vi.fn();
const getBoard = vi.fn();
vi.mock('../universeBuilder/crud.js', () => ({ getUniverse: (...a) => getUniverse(...a) }));
vi.mock('../moodBoard/index.js', () => ({ getBoard: (...a) => getBoard(...a) }));
const getCharacterStyleReferenceImage = vi.fn();
vi.mock('./characterStyles.js', () => ({ getCharacterStyleReferenceImage: (...a) => getCharacterStyleReferenceImage(...a) }));

const { withStyleSnapshots } = await import('./styleSnapshots.js');

const UNIVERSE = { name: 'Example universe', styleNotes: 'Ink silhouettes', influences: { embrace: ['noir'], avoid: ['neon'] } };
const BOARD = { name: 'Painted style', description: 'Watercolor', items: [{ type: 'text', text: 'Loose brush strokes' }] };

describe('withStyleSnapshots (#9105)', () => {
  beforeEach(() => {
    getUniverse.mockReset().mockResolvedValue(UNIVERSE);
    getBoard.mockReset().mockResolvedValue(BOARD);
    getCharacterStyleReferenceImage.mockReset().mockResolvedValue(null);
  });

  it('derives both snapshots on create from ids alone', async () => {
    const out = await withStyleSnapshots({ name: 'MV', concept: { universeId: 'u1' }, visualSpec: { moodBoardId: 'b1' } });
    expect(out.concept.universeStyle).toBe('Example universe\nInk silhouettes\nEmbrace: noir\nAvoid: neon');
    expect(out.concept.moodBoardStyle).toContain('Loose brush strokes');
    expect(out.visualSpec).toEqual({ moodBoardId: 'b1' });
  });

  it('snapshots a board\'s synthesized style and avoid list instead of its item captions', async () => {
    getBoard.mockResolvedValue({ ...BOARD, style: { prompt: 'Teal and red neon, 35mm grain', negativePrompt: 'daylight, cartoon' } });
    const out = await withStyleSnapshots({ name: 'MV', visualSpec: { moodBoardId: 'b1' }, concept: {} });
    expect(out.concept.moodBoardStyle).toBe('Teal and red neon, 35mm grain\nAvoid: daylight, cartoon');
    expect(out.concept.moodBoardStyle).not.toContain('Loose brush strokes');
  });

  it('keeps an explicit snapshot and does not refetch an unchanged, already-snapshotted source', async () => {
    const existing = { concept: { universeId: 'u1', universeStyle: 'kept', moodBoardStyle: 'kept' }, visualSpec: { moodBoardId: 'b1' } };
    const patch = { concept: { universeId: 'u1', subjects: [] }, visualSpec: { moodBoardId: 'b1' } };
    expect(await withStyleSnapshots(patch, existing)).toBe(patch);
    const explicit = { concept: { universeId: 'u2', universeStyle: 'mine' } };
    expect((await withStyleSnapshots(explicit, existing)).concept.universeStyle).toBe('mine');
    expect(getUniverse).not.toHaveBeenCalled();
    expect(getBoard).not.toHaveBeenCalled();
  });

  it('re-derives on a changed id, clears on deselection, and derives a legacy project missing a snapshot', async () => {
    const existing = { concept: { universeId: 'u1', universeStyle: 'old', moodBoardStyle: 'old' }, visualSpec: { moodBoardId: 'b1' } };
    const changed = await withStyleSnapshots({ concept: { universeId: 'u2' } }, existing);
    expect(getUniverse).toHaveBeenCalledWith('u2');
    expect(changed.concept.universeStyle).toContain('Ink silhouettes');
    const cleared = await withStyleSnapshots({ concept: { universeId: null }, visualSpec: { moodBoardId: null } }, existing);
    expect(cleared.concept).toMatchObject({ universeStyle: '', moodBoardStyle: '' });
    const legacy = await withStyleSnapshots({ visualSpec: { moodBoardId: 'b1' } }, { concept: { universeId: 'u1' }, visualSpec: { moodBoardId: 'b1' } });
    expect(legacy.concept.moodBoardStyle).toContain('Watercolor');
  });

  it('yields an empty snapshot for a missing source instead of failing the save', async () => {
    getUniverse.mockRejectedValue(new Error('Universe not found'));
    const out = await withStyleSnapshots({ concept: { universeId: 'gone' } });
    expect(out.concept.universeStyle).toBe('');
  });

  it('casts a character style: snapshot, protagonist and this install\'s sheet as a conditioning reference', async () => {
    getCharacterStyleReferenceImage.mockResolvedValue('sheet.png');
    const director = { id: 'mvc-1', kind: 'character', name: 'Example lead', role: 'protagonist' };
    const conditioned = [1, 2, 3, 4].map((n) => ({ id: `r${n}`, imageId: `r${n}.png`, condition: true }));
    const out = await withStyleSnapshots({ concept: { characterStyleId: 'claudia-slopcore', subjects: [director] } },
      { concept: {}, visualSpec: { references: conditioned } });
    expect(out.concept.characterStyle).toContain('one clay-orange streak through the bangs');
    expect(out.concept.subjects.map((s) => [s.id, s.role])).toEqual([['mvc-style-claudia-slopcore', 'protagonist'], ['mvc-1', 'supporting']]);
    // Four references already condition frames, so the sheet joins as a described reference only.
    expect(out.visualSpec.references.at(-1)).toMatchObject({ id: 'mvr-style-claudia-slopcore', imageId: 'sheet.png', role: 'character', condition: false });

    const picked = { concept: { characterStyleId: 'claudia-slopcore', characterStyle: out.concept.characterStyle, subjects: out.concept.subjects }, visualSpec: out.visualSpec };
    const cleared = await withStyleSnapshots({ concept: { characterStyleId: null } }, picked);
    expect(cleared.concept.characterStyle).toBe('');
    // The director's lead gets the protagonist role back.
    expect(cleared.concept.subjects).toEqual([director]);
    expect(cleared.visualSpec.references).toEqual(conditioned);
  });

  it('adds a sheet chosen after the style was first saved, and marks a sheet already referenced instead of duplicating it', async () => {
    const first = await withStyleSnapshots({ concept: { characterStyleId: 'claudia-slopcore' } });
    expect(first.visualSpec).toBeUndefined();
    const saved = { concept: first.concept, visualSpec: { references: [{ id: 'mine', imageId: 'sheet.png', role: 'mood' }] } };
    const patch = { concept: { characterStyleId: 'claudia-slopcore', subjects: first.concept.subjects } };
    expect(await withStyleSnapshots(patch, saved)).toBe(patch);

    getCharacterStyleReferenceImage.mockResolvedValue('sheet.png');
    const resaved = await withStyleSnapshots(patch, saved);
    expect(resaved.concept.subjects).toEqual(first.concept.subjects);
    expect(resaved.visualSpec.references).toEqual([{ id: 'mine', imageId: 'sheet.png', role: 'character', condition: true }]);

    getCharacterStyleReferenceImage.mockResolvedValue('new-sheet.png');
    const replaced = await withStyleSnapshots(patch, { ...saved, visualSpec: resaved.visualSpec });
    expect(replaced.visualSpec.references.map((r) => [r.id, r.imageId])).toEqual([['mine', 'sheet.png'], ['mvr-style-claudia-slopcore', 'new-sheet.png']]);
  });

  it('casts without a reference when this install has no sheet for the style', async () => {
    const out = await withStyleSnapshots({ concept: { characterStyleId: 'claudia-slopcore' } });
    expect(out.concept.subjects).toHaveLength(1);
    expect(out.visualSpec).toBeUndefined();
  });
});
