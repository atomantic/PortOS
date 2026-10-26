import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  getIngredient: vi.fn(), setIngredientPayloadKey: vi.fn(), listMediaForIngredient: vi.fn(), detachMedia: vi.fn(),
}));
const upload = vi.hoisted(() => vi.fn());
vi.mock('./catalogDB.js', () => db);
vi.mock('./catalogMedia.js', () => ({ uploadIngredientMediaFile: upload }));

const { draftGreybox, previewGreyboxPrompt, saveGreybox, captureGreyboxShot, __setGreyboxDepsForTests } = await import('./catalogGreybox.js');

const scene = {
  parts: [{ id: 'floor', type: 'box', size: [30, 0.1, 14] }],
  shots: [{ id: 'wide', label: 'Wide', position: [0, 4, 14], target: [0, 1, 0] }],
};
const place = { id: 'plc-1', type: 'place', name: 'Rink', payload: { description: 'Roller rink', greybox: scene } };
const runPrompt = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  db.getIngredient.mockResolvedValue(place);
  __setGreyboxDepsForTests({
    resolveProvider: async () => ({ provider: { id: 'p1', enabled: true }, selectedModel: 'm1' }),
    runPrompt,
  });
});

describe('draftGreybox', () => {
  it('runs the picked provider/model/effort and previews without storing', async () => {
    runPrompt.mockResolvedValue({ text: JSON.stringify(scene) });
    const out = await draftGreybox('plc-1', { instruction: 'Add a booth', providerId: 'p1', model: 'm1', effort: 'high' });
    expect(runPrompt).toHaveBeenCalledWith(expect.objectContaining({ model: 'm1', effort: 'high', source: 'catalog-greybox' }));
    expect(out.edited).toBe(true);
    expect(out.sentPrompt).toContain('Add a booth');
    expect(out.promptAdditions.map((a) => a.id)).toEqual(expect.arrayContaining(['greybox-contract', 'greybox-place', 'greybox-current']));
    expect(db.setIngredientPayloadKey).not.toHaveBeenCalled();
  });

  it('refuses an unreadable answer and a non-place', async () => {
    runPrompt.mockResolvedValue({ text: 'sorry' });
    await expect(draftGreybox('plc-1', { instruction: 'x' })).rejects.toMatchObject({ code: 'GREYBOX_UNREADABLE' });
    db.getIngredient.mockResolvedValue({ ...place, type: 'character' });
    await expect(draftGreybox('plc-1', { instruction: 'x' })).rejects.toMatchObject({ code: 'GREYBOX_NOT_A_PLACE' });
  });
});

describe('previewGreyboxPrompt', () => {
  it('returns the exact prompt a draft sends without calling a provider', async () => {
    runPrompt.mockResolvedValue({ text: JSON.stringify(scene) });
    const preview = await previewGreyboxPrompt('plc-1', { instruction: 'Add a booth' });
    expect(runPrompt).not.toHaveBeenCalled();
    const draft = await draftGreybox('plc-1', { instruction: 'Add a booth' });
    expect(draft.sentPrompt).toBe(preview.sentPrompt);
    expect(draft.promptAdditions).toEqual(preview.promptAdditions);
  });
});

describe('saveGreybox', () => {
  it('writes only the greybox key under the row lock, restricted to places', async () => {
    db.setIngredientPayloadKey.mockResolvedValue(place);
    await saveGreybox('plc-1', scene, { source: 'refine' });
    const [id, key, value, options] = db.setIngredientPayloadKey.mock.calls[0];
    expect([id, key, value, options.source]).toEqual(['plc-1', 'greybox', scene, 'refine']);
    expect(() => options.guard({ type: 'character' })).toThrow(/belongs to a place/);
    expect(() => options.guard({ type: 'place' })).not.toThrow();
  });

  it('refuses a scene that would push the payload past the catalog cap', async () => {
    db.setIngredientPayloadKey.mockResolvedValue(place);
    const huge = { ...scene, parts: Array.from({ length: 400 }, (_, i) => ({ id: `p${i}`, type: 'box', size: [1, 1, 1], label: 'x'.repeat(600) })) };
    await saveGreybox('plc-1', huge);
    await saveGreybox('plc-1', scene);
    const [{ 3: bigOptions }, { 3: smallOptions }] = db.setIngredientPayloadKey.mock.calls;
    expect(() => bigOptions.guard({ type: 'place', payload: { description: 'Roller rink' } })).toThrow(/too large/);
    expect(() => smallOptions.guard({ type: 'place', payload: { description: 'Roller rink' } })).not.toThrow();
  });

  it('clears the greybox with null', async () => {
    db.setIngredientPayloadKey.mockResolvedValue(place);
    await saveGreybox('plc-1', null);
    expect(db.setIngredientPayloadKey.mock.calls[0].slice(1, 3)).toEqual(['greybox', null]);
  });

  it('404s a missing place', async () => {
    db.setIngredientPayloadKey.mockResolvedValue(null);
    await expect(saveGreybox('gone', scene)).rejects.toMatchObject({ status: 404 });
  });
});

describe('captureGreyboxShot', () => {
  it('attaches a tagged reference and detaches the shot\'s previous capture', async () => {
    db.listMediaForIngredient.mockResolvedValue([
      { mediaKey: 'old.png', kind: 'reference', role: 'greybox-shot:wide', deleted: false },
      { mediaKey: 'other.png', kind: 'reference', role: 'greybox-shot:other', deleted: false },
    ]);
    upload.mockResolvedValue({ mediaKey: 'new.png', kind: 'reference' });
    await captureGreyboxShot('plc-1', 'wide', { dataBase64: 'AAAA' });
    expect(upload).toHaveBeenCalledWith(expect.objectContaining({ role: 'greybox-shot:wide', mimeType: 'image/png' }));
    expect(db.detachMedia).toHaveBeenCalledTimes(1);
    expect(db.detachMedia).toHaveBeenCalledWith('plc-1', 'old.png', 'reference');
  });

  it('serializes overlapping captures of one shot so only the newest stays attached', async () => {
    const live = [{ mediaKey: 'old.png', kind: 'reference', role: 'greybox-shot:wide', deleted: false }];
    db.listMediaForIngredient.mockImplementation(async () => live.map((m) => ({ ...m })));
    db.detachMedia.mockImplementation(async (_id, key) => { live.splice(live.findIndex((m) => m.mediaKey === key), 1); });
    let n = 0;
    upload.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      const row = { mediaKey: `new${++n}.png`, kind: 'reference', role: 'greybox-shot:wide', deleted: false };
      live.push(row);
      return row;
    });
    await Promise.all([
      captureGreyboxShot('plc-1', 'wide', { dataBase64: 'AAAA' }),
      captureGreyboxShot('plc-1', 'wide', { dataBase64: 'BBBB' }),
    ]);
    expect(live.map((m) => m.mediaKey)).toEqual(['new2.png']);
  });

  it('refuses a shot that is not saved', async () => {
    await expect(captureGreyboxShot('plc-1', 'ghost', { dataBase64: 'AAAA' })).rejects.toMatchObject({ code: 'GREYBOX_SHOT_UNKNOWN' });
    expect(upload).not.toHaveBeenCalled();
  });
});
