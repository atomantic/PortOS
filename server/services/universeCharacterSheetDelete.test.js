import { describe, it, expect, vi, beforeEach } from 'vitest';

// `deleteCharacterReferenceSheet` orchestrates: getUniverse → fs.unlink → purge.
// Stub each collaborator so the orchestration is testable without spinning
// up the universe store or touching disk. Heavy deps the renderer pulls in
// (mediaJobQueue, mediaCollections) are stubbed to noops since the delete
// path doesn't exercise them.

const unlinkMock = vi.fn();
vi.mock('fs/promises', async () => {
  const actual = await vi.importActual('fs/promises');
  return { ...actual, unlink: (...args) => unlinkMock(...args) };
});

const fakeUniverseStore = new Map();
vi.mock('./universeBuilder.js', () => ({
  getUniverse: vi.fn(async (id) => {
    const u = fakeUniverseStore.get(id);
    if (!u) throw Object.assign(new Error(`Not found`), { status: 404, code: 'UNIVERSE_NOT_FOUND' });
    return u;
  }),
  updateUniverse: vi.fn(async (id, mutatorOrPatch) => {
    const cur = fakeUniverseStore.get(id);
    const patch = typeof mutatorOrPatch === 'function' ? mutatorOrPatch(cur) : mutatorOrPatch;
    if (!patch) return cur;
    const next = { ...cur, ...patch };
    fakeUniverseStore.set(id, next);
    return next;
  }),
  listUniverses: vi.fn(async () => Array.from(fakeUniverseStore.values())),
  joinInfluenceList: vi.fn(() => ''),
}));

vi.mock('../lib/fileUtils.js', () => ({
  PATHS: { imageRefs: '/mock/data/image-refs', images: '/mock/data/images', data: '/mock/data' },
  ensureDir: vi.fn().mockResolvedValue(undefined),
  shortId: (id, n = 8) => (id == null ? '' : String(id).slice(0, n)),
  // Real basename-only validator behavior the helper relies on as defense-in-depth.
  assertSafeFilename: vi.fn((filename) => {
    if (!filename || typeof filename !== 'string') {
      throw Object.assign(new Error('Filename required'), { status: 400, code: 'VALIDATION_ERROR' });
    }
    if (filename.includes('/') || filename.includes('\\') || filename === '.' || filename === '..') {
      throw Object.assign(new Error('Invalid filename'), { status: 400, code: 'VALIDATION_ERROR' });
    }
  }),
}));

// Stubs for the heavy deps the renderer pulls in. The delete helper doesn't
// touch any of these, but the module loader will pull them in unless we stub.
vi.mock('./mediaJobQueue/index.js', () => ({
  enqueueJob: vi.fn(),
  mediaJobEvents: { on: vi.fn(), off: vi.fn() },
}));
vi.mock('./mediaCollections.js', () => ({ findOrCreateUniverseCollection: vi.fn() }));
vi.mock('./settings.js', () => ({ getSettings: vi.fn().mockResolvedValue({}) }));
vi.mock('../lib/mediaModels.js', () => ({ getImageModels: vi.fn(() => []) }));
vi.mock('../lib/canonPrompt.js', () => ({
  flattenStats: vi.fn(() => ''),
  flattenPalette: vi.fn(() => ''),
  flattenWardrobes: vi.fn(() => ''),
  flattenProps: vi.fn(() => ''),
  flattenNamedList: vi.fn(() => ''),
}));

const { deleteCharacterReferenceSheet } = await import('./universeCharacterSheet.js');

const seedUniverse = (id, characters) => {
  fakeUniverseStore.set(id, { id, name: 'Test', characters });
};

beforeEach(() => {
  fakeUniverseStore.clear();
  unlinkMock.mockReset();
  unlinkMock.mockResolvedValue(undefined);
});

describe('universeCharacterSheet — deleteCharacterReferenceSheet', () => {
  it('unlinks the file and nulls the pointer on success', async () => {
    seedUniverse('uni-1', [
      { id: 'char-1', name: 'Alex', referenceSheetImageRef: 'sheet-X.png' },
    ]);

    const result = await deleteCharacterReferenceSheet('uni-1', 'char-1');
    expect(result).toEqual({ filename: 'sheet-X.png', fileDeleted: true, cleared: 1 });
    expect(unlinkMock).toHaveBeenCalledWith('/mock/data/image-refs/sheet-X.png');
    expect(fakeUniverseStore.get('uni-1').characters[0].referenceSheetImageRef).toBeNull();
  });

  it('treats ENOENT (file already gone) as benign — pointer still clears', async () => {
    seedUniverse('uni-1', [
      { id: 'char-1', name: 'Alex', referenceSheetImageRef: 'sheet-X.png' },
    ]);
    unlinkMock.mockRejectedValueOnce(Object.assign(new Error('not found'), { code: 'ENOENT' }));

    const result = await deleteCharacterReferenceSheet('uni-1', 'char-1');
    expect(result).toEqual({ filename: 'sheet-X.png', fileDeleted: false, cleared: 1 });
    expect(fakeUniverseStore.get('uni-1').characters[0].referenceSheetImageRef).toBeNull();
  });

  it('propagates non-ENOENT unlink errors instead of swallowing', async () => {
    seedUniverse('uni-1', [
      { id: 'char-1', name: 'Alex', referenceSheetImageRef: 'sheet-X.png' },
    ]);
    unlinkMock.mockRejectedValueOnce(Object.assign(new Error('permission denied'), { code: 'EACCES' }));

    await expect(deleteCharacterReferenceSheet('uni-1', 'char-1'))
      .rejects.toMatchObject({ code: 'EACCES' });
    // Pointer is NOT cleared when the unlink fails for a non-ENOENT reason —
    // a half-cleared state where the file is still on disk would leave the
    // gallery showing a sheet that no character knows about.
    expect(fakeUniverseStore.get('uni-1').characters[0].referenceSheetImageRef).toBe('sheet-X.png');
  });

  it('no-ops when character has no sheet pointer', async () => {
    seedUniverse('uni-1', [
      { id: 'char-1', name: 'Alex', referenceSheetImageRef: null },
    ]);

    const result = await deleteCharacterReferenceSheet('uni-1', 'char-1');
    expect(result).toEqual({ filename: null, fileDeleted: false, cleared: 0 });
    expect(unlinkMock).not.toHaveBeenCalled();
  });

  it('throws 404 when character is missing from the universe', async () => {
    seedUniverse('uni-1', [
      { id: 'char-1', name: 'Alex', referenceSheetImageRef: 'sheet-X.png' },
    ]);

    await expect(deleteCharacterReferenceSheet('uni-1', 'char-missing'))
      .rejects.toMatchObject({ status: 404, code: 'UNIVERSE_CANON_NOT_FOUND' });
    expect(unlinkMock).not.toHaveBeenCalled();
  });

  it('throws 409 when the character is locked (mirrors the render path)', async () => {
    seedUniverse('uni-1', [
      { id: 'char-1', name: 'Alex', referenceSheetImageRef: 'sheet-X.png', locked: true },
    ]);

    await expect(deleteCharacterReferenceSheet('uni-1', 'char-1'))
      .rejects.toMatchObject({ status: 409, code: 'UNIVERSE_CANON_LOCKED' });
    expect(unlinkMock).not.toHaveBeenCalled();
    expect(fakeUniverseStore.get('uni-1').characters[0].referenceSheetImageRef).toBe('sheet-X.png');
  });

  it('rejects a sheet pointer that smuggles a path separator (defense in depth)', async () => {
    seedUniverse('uni-1', [
      { id: 'char-1', name: 'Alex', referenceSheetImageRef: '../escape.png' },
    ]);

    await expect(deleteCharacterReferenceSheet('uni-1', 'char-1'))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(unlinkMock).not.toHaveBeenCalled();
  });

  it('clears the pointer on every other character whose sheet matches the same filename', async () => {
    // Renames can leave two universes pointing at the same on-disk PNG. Purge
    // must hit them all so the gallery delete is the single source of truth.
    seedUniverse('uni-1', [
      { id: 'char-1', name: 'Alex', referenceSheetImageRef: 'sheet-Z.png' },
    ]);
    seedUniverse('uni-2', [
      { id: 'char-99', name: 'Cara', referenceSheetImageRef: 'sheet-Z.png' },
    ]);

    const result = await deleteCharacterReferenceSheet('uni-1', 'char-1');
    expect(result.cleared).toBe(2);
    expect(fakeUniverseStore.get('uni-1').characters[0].referenceSheetImageRef).toBeNull();
    expect(fakeUniverseStore.get('uni-2').characters[0].referenceSheetImageRef).toBeNull();
  });
});
