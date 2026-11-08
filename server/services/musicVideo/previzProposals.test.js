import { beforeEach, describe, expect, it, vi } from 'vitest';

const world = { version: 1, seed: 1, sets: [{ id: 's1', ingredientId: 'env-street', position: [0, 0], rotationDegrees: 0 }], paths: [] };
const project = {
  id: 'p',
  concept: { prompt: 'Two teens ride at night', subjects: [
    { id: 'ada', kind: 'character', name: 'Ada' }, { id: 'cal', kind: 'character', name: 'Cal' },
    { id: 'street', kind: 'place', name: 'Street', ingredientId: 'env-street' },
  ] },
  cameras: [{ id: 'vhs', name: 'VHS', kind: 'in-world' }],
  scenes: [{ sceneId: 'a', startSec: 0, endSec: 4, shotSheet: { action: 'They ride' } }],
  previz: { worldId: 'world-1', cuts: [{ id: 'c1', sceneId: 'a', placeSubjectId: 'street', holderSubjectId: 'k' }], tracks: [] },
};
vi.mock('./requireProject.js', () => ({ requireProject: vi.fn(async () => project) }));
const { proposePrevizEdit, __setPrevizProposalDepsForTests } = await import('./previzProposals.js');

const provider = { id: 'prov', enabled: true, type: 'api' };
const run = vi.fn();
const entries = { 'world-1': { id: 'world-1', payload: { world } }, 'env-street': { id: 'env-street', name: 'Main street', payload: {} } };
const base = { providerId: 'prov', instruction: 'Have Cal turn to Ada in shot 1' };
beforeEach(() => {
  vi.clearAllMocks();
  __setPrevizProposalDepsForTests({ getIngredient: async (id) => entries[id] || null, resolve: async () => ({ provider, selectedModel: 'm' }), run });
});

describe('proposePrevizEdit', () => {
  // Catches the "Show full prompt" preview calling a provider, or hiding the world, cuts or request it would send (#11315).
  it('previews the exact prompt without calling the provider', async () => {
    const result = await proposePrevizEdit('p', { ...base, preview: true });
    expect(run).not.toHaveBeenCalled();
    expect(result.promptAdditions.map((entry) => entry.id)).toEqual(expect.arrayContaining(['previz-world', 'previz-cuts', 'previz-request']));
    for (const text of ['Main street', 'They ride', 'Have Cal turn to Ada']) expect(result.sentPrompt).toContain(text);
  });
  // Catches a valid part being lost, a world echoed with its shown names being refused, or invented ids reaching the review.
  it('keeps valid parts and reports the ones it leaves out', async () => {
    run.mockResolvedValue({ text: JSON.stringify({
      summary: 'Cal turns to Ada.',
      world: { ...world, sets: [{ ...world.sets[0], name: 'Main street', footprint: { w: 1 }, position: [10, 0] }] },
      cuts: [{ id: 'c1', aimSubjectId: 'ada', turnToAim: true }, { id: 'c1', aimSubjectId: 'ghost' }, { id: 'gone', turnToAim: true }],
      pawnColors: { nobody: { figure: 'red' } },
      cameraStyles: { vhs: 'handheld' },
    }) });
    const result = await proposePrevizEdit('p', base);
    expect(result.summary).toBe('Cal turns to Ada.');
    expect(result.proposal.world.sets[0]).toEqual({ id: 's1', ingredientId: 'env-street', position: [10, 0], rotationDegrees: 0 });
    expect(result.proposal.cuts).toEqual([{ id: 'c1', aimSubjectId: 'ada', turnToAim: true }]);
    expect(result.proposal.cameraStyles).toEqual({ vhs: 'handheld' });
    expect(result.proposal.pawnColors).toBeUndefined();
    expect(result.dropped.join(' ')).toMatch(/cuts:.*pawnColors/);
  });
  // Catches a set swapped for an environment the video never uses, or a night beat at a set that doesn't exist.
  it('refuses unknown environments and beats at missing sets', async () => {
    run.mockResolvedValue({ text: JSON.stringify({
      world: { ...world, sets: [{ id: 's9', ingredientId: 'env-other', position: [0, 0], rotationDegrees: 0 }] },
      night: { startClock: 1200, lengthMin: 60, beats: [{ id: 'b1', kind: 'stay', subjectIds: ['k'], startMin: 0, endMin: 10, setId: 'nowhere' }] },
    }) });
    const result = await proposePrevizEdit('p', base);
    expect(result.proposal).toEqual({});
    expect(result.dropped).toHaveLength(2);
  });
  // Catches unusable output reaching the review as an empty success.
  it('refuses an unreadable reply', async () => {
    run.mockResolvedValue({ text: 'no json here' });
    await expect(proposePrevizEdit('p', base)).rejects.toMatchObject({ status: 502 });
  });
});
