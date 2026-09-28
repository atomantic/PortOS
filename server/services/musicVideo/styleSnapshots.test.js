import { describe, it, expect, vi, beforeEach } from 'vitest';

const getUniverse = vi.fn();
const getBoard = vi.fn();
vi.mock('../universeBuilder/crud.js', () => ({ getUniverse: (...a) => getUniverse(...a) }));
vi.mock('../moodBoard/index.js', () => ({ getBoard: (...a) => getBoard(...a) }));

const { withStyleSnapshots } = await import('./styleSnapshots.js');

const UNIVERSE = { name: 'Example universe', styleNotes: 'Ink silhouettes', influences: { embrace: ['noir'], avoid: ['neon'] } };
const BOARD = { name: 'Painted style', description: 'Watercolor', items: [{ type: 'text', text: 'Loose brush strokes' }] };

describe('withStyleSnapshots (#9105)', () => {
  beforeEach(() => {
    getUniverse.mockReset().mockResolvedValue(UNIVERSE);
    getBoard.mockReset().mockResolvedValue(BOARD);
  });

  it('derives both snapshots on create from ids alone', async () => {
    const out = await withStyleSnapshots({ name: 'MV', concept: { universeId: 'u1' }, visualSpec: { moodBoardId: 'b1' } });
    expect(out.concept.universeStyle).toBe('Example universe\nInk silhouettes\nEmbrace: noir\nAvoid: neon');
    expect(out.concept.moodBoardStyle).toContain('Loose brush strokes');
    expect(out.visualSpec).toEqual({ moodBoardId: 'b1' });
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
});
