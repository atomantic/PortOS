import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the only side-effecting dependency before importing the module under test.
vi.mock('./mediaCollections.js', () => ({
  findOrCreateUniverseCollection: vi.fn(),
}));

import { buildUniverseRunTag } from './universeRunTag.js';
import { findOrCreateUniverseCollection } from './mediaCollections.js';

describe('buildUniverseRunTag', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('provisions the collection and mints a runId when none is supplied (probe/character-sheet path)', async () => {
    findOrCreateUniverseCollection.mockResolvedValue({ id: 'col-1' });

    const tag = await buildUniverseRunTag({
      universeId: 'u1',
      universeName: 'Nebula',
      label: 'Hero',
      category: 'characters',
    });

    expect(findOrCreateUniverseCollection).toHaveBeenCalledWith({
      universeId: 'u1',
      universeName: 'Nebula',
      description: 'Universe Builder renders for "Nebula"',
    });
    expect(tag).toMatchObject({
      universeId: 'u1',
      collectionId: 'col-1',
      label: 'Hero',
      category: 'characters',
    });
    expect(typeof tag.runId).toBe('string');
    expect(tag.runId.length).toBeGreaterThan(0);
    expect(tag).not.toHaveProperty('entryRef');
  });

  it('omits falsy label/category instead of emitting empty keys', async () => {
    findOrCreateUniverseCollection.mockResolvedValue({ id: 'col-1' });

    const tag = await buildUniverseRunTag({ universeId: 'u1', universeName: 'Nebula' });

    expect(tag).not.toHaveProperty('label');
    expect(tag).not.toHaveProperty('category');
  });

  it('drops the collection portion but preserves entryRef when provisioning fails (probe #1395 path)', async () => {
    findOrCreateUniverseCollection.mockRejectedValue(new Error('db down'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const entryRef = { kind: 'canon', kindKey: 'origin' };
    const tag = await buildUniverseRunTag({
      universeId: 'u1',
      universeName: 'Nebula',
      entryRef,
      errorContext: 'image-gen → universe collection provision failed',
    });

    expect(tag).toEqual({ universeId: 'u1', entryRef });
    expect(tag).not.toHaveProperty('runId');
    expect(tag).not.toHaveProperty('collectionId');
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('image-gen → universe collection provision failed: db down'),
    );
    errSpy.mockRestore();
  });

  it('returns undefined when provisioning fails and there is no entryRef (character-sheet path)', async () => {
    findOrCreateUniverseCollection.mockRejectedValue(new Error('db down'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const tag = await buildUniverseRunTag({ universeId: 'u1', universeName: 'Nebula' });

    expect(tag).toBeUndefined();
    errSpy.mockRestore();
  });

  it('reuses a caller-supplied collection + runId without re-provisioning (batch-render path)', async () => {
    const collection = { id: 'col-batch' };

    const tag = await buildUniverseRunTag({
      universeId: 'u1',
      collection,
      runId: 'shared-run',
      category: 'concept',
      label: 'Item 3',
      entryRef: { kind: 'variation', kindKey: 'v3' },
    });

    expect(findOrCreateUniverseCollection).not.toHaveBeenCalled();
    expect(tag).toEqual({
      universeId: 'u1',
      runId: 'shared-run',
      collectionId: 'col-batch',
      label: 'Item 3',
      category: 'concept',
      entryRef: { kind: 'variation', kindKey: 'v3' },
    });
  });

  it('treats an explicit null collection as "resolved, none" (skips provisioning)', async () => {
    const tag = await buildUniverseRunTag({
      universeId: 'u1',
      collection: null,
      entryRef: { kind: 'sheet' },
    });

    expect(findOrCreateUniverseCollection).not.toHaveBeenCalled();
    expect(tag).toEqual({ universeId: 'u1', entryRef: { kind: 'sheet' } });
  });

  it('returns undefined when collection is explicitly null and there is no entryRef', async () => {
    const tag = await buildUniverseRunTag({ universeId: 'u1', collection: null });
    expect(findOrCreateUniverseCollection).not.toHaveBeenCalled();
    expect(tag).toBeUndefined();
  });
});
