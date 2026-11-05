import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ getIngredient: vi.fn(), setIngredientPayloadKey: vi.fn() }));
vi.mock('./catalogDB.js', () => db);

const { draftPhotorealLook, previewPhotorealLookPrompt, savePhotorealLook, __setPhotorealLookDepsForTests } = await import('./catalogPhotorealLook.js');

const scene = {
  zones: [{ id: 'floor', label: 'Skate floor', color: '#334455' }],
  parts: [{ id: 'rink', type: 'box', zone: 'floor', size: [30, 0.1, 14] }, { id: 'booth', label: 'DJ booth', type: 'box', size: [3, 2, 2], position: [10, 1, 0] }],
  shots: [{ id: 'wide', label: 'Wide', position: [0, 4, 14], target: [0, 1, 0] }],
};
const place = (payload = {}) => ({ id: 'plc-1', type: 'place', name: 'Example Rink', payload: { description: 'A roller rink', greybox: scene, ...payload } });
const look = { materials: [{ id: 'maple', zone: 'floor', preset: 'wood-floor', color: '#c89a5a', wear: 0.3 }], lights: [{ id: 'panel', type: 'area', position: [0, 6, 0], target: [0, 0, 0], watts: 600 }], atmosphere: { haze: 0.2 } };
const runPrompt = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  db.getIngredient.mockResolvedValue(place());
  __setPhotorealLookDepsForTests({ resolveProvider: async () => ({ provider: { id: 'p1', enabled: true }, selectedModel: 'm1' }), runPrompt });
});

describe('photoreal look drafts', () => {
  it('sends the user words as written beside visible blocks, and returns a validated preview without storing it', async () => {
    runPrompt.mockResolvedValue({ text: `Here you go:\n\`\`\`json\n${JSON.stringify(look)}\n\`\`\`` });
    const preview = await previewPhotorealLookPrompt('plc-1', { instruction: '  warm 80s rink, light haze  ' });
    const draft = await draftPhotorealLook('plc-1', { instruction: '  warm 80s rink, light haze  ', providerId: 'p1', effort: 'low' });
    expect(draft.sentPrompt).toBe(preview.sentPrompt);
    expect(draft.sentPrompt).toContain('Request:\n  warm 80s rink, light haze  ');
    expect(draft.promptAdditions.map((a) => a.id)).toEqual(expect.arrayContaining(['photoreal-contract', 'greybox-place', 'photoreal-greybox']));
    expect(draft.look).toMatchObject({ materials: [{ id: 'maple', emission: 0 }], atmosphere: { haze: 0.2, sun: false, exposure: 0 } });
    expect(runPrompt).toHaveBeenCalledWith(expect.objectContaining({ effort: 'low', source: 'catalog-photoreal-look' }));
    expect(db.setIngredientPayloadKey).not.toHaveBeenCalled();
  });

  it('edits the current look and refuses an answer naming geometry the greybox lacks', async () => {
    db.getIngredient.mockResolvedValue(place({ photoreal: look }));
    runPrompt.mockResolvedValue({ text: JSON.stringify({ ...look, materials: [{ id: 'x', part: 'snack-bar', preset: 'tile', color: '#ffffff' }] }) });
    await expect(draftPhotorealLook('plc-1', { instruction: 'tile the snack bar' })).rejects.toMatchObject({ status: 422, code: 'PHOTOREAL_LOOK_UNREADABLE', message: expect.stringContaining('unknown part "snack-bar"') });
    expect(runPrompt.mock.calls[0][0].prompt).toContain('Current look (JSON)');
  });

  it('keeps the user\'s photo textures through a draft, even from scratch, and never shows them to the model', async () => {
    db.getIngredient.mockResolvedValue(place({ photoreal: { ...look, textures: { 'wood-floor': 'example_planks', 'future-preset': 'x' } } }));
    runPrompt.mockResolvedValue({ text: JSON.stringify({ ...look, textures: { 'wood-floor': 'model_pick' } }) });
    const draft = await draftPhotorealLook('plc-1', { instruction: 'start over', useCurrent: false });
    expect(draft.look.textures).toEqual({ 'wood-floor': 'example_planks' });
    await draftPhotorealLook('plc-1', { instruction: 'warmer' });
    expect(runPrompt.mock.calls[1][0].prompt).toContain('Current look (JSON)');
    expect(runPrompt.mock.calls[1][0].prompt).not.toContain('example_planks');
  });

  it('refuses a place without a parts greybox before calling a provider', async () => {
    db.getIngredient.mockResolvedValue(place({ greybox: { ...scene, source: 'glb' } }));
    await expect(draftPhotorealLook('plc-1', { instruction: 'dress it' })).rejects.toMatchObject({ code: 'GREYBOX_NOT_RENDERABLE' });
    expect(runPrompt).not.toHaveBeenCalled();
  });
});

describe('savePhotorealLook', () => {
  it('rejects a look whose zones or parts no longer exist on the saved greybox', async () => {
    db.setIngredientPayloadKey.mockImplementation(async (_id, _key, value, { guard }) => { guard(place()); return { id: 'plc-1', payload: { photoreal: value } }; });
    await expect(savePhotorealLook('plc-1', { ...look, materials: [{ id: 'm', zone: 'gone', preset: 'carpet', color: '#222222', wear: 0, emission: 0 }] }))
      .rejects.toMatchObject({ status: 409, code: 'PHOTOREAL_LOOK_STALE' });
    await expect(savePhotorealLook('plc-1', look, { source: 'refine' })).resolves.toMatchObject({ payload: { photoreal: look } });
    expect(db.setIngredientPayloadKey).toHaveBeenLastCalledWith('plc-1', 'photoreal', look, expect.objectContaining({ source: 'refine' }));
  });
});
