import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getCollectionPrimaryStatus, startCollectionPrimary } from './mediaCollectionPrimary.js';

const fixtures = vi.hoisted(() => ({
  getCollection: vi.fn(),
  setCollectionPrimaryMachine: vi.fn(),
  listMediaPrimaryMachines: vi.fn(),
  listMediaHolders: vi.fn(),
  prepareMediaConsolidation: vi.fn(),
  listUnsortedGalleryFiles: vi.fn(),
  emitCollectionPrimaryChanged: vi.fn(),
}));

vi.mock('./mediaCollections.js', () => ({
  getCollection: fixtures.getCollection,
  setCollectionPrimaryMachine: fixtures.setCollectionPrimaryMachine,
}));
vi.mock('./mediaHolders.js', () => ({
  listMediaPrimaryMachines: fixtures.listMediaPrimaryMachines,
  listMediaHolders: fixtures.listMediaHolders,
  prepareMediaConsolidation: fixtures.prepareMediaConsolidation,
}));
vi.mock('./mediaAssetIndex/gallery.js', () => ({ listUnsortedGalleryFiles: fixtures.listUnsortedGalleryFiles }));
vi.mock('./peerSyncEventBus.js', () => ({ emitCollectionPrimaryChanged: fixtures.emitCollectionPrimaryChanged }));

beforeEach(() => vi.resetAllMocks());

describe('shared media primary consolidation', () => {
  it('moves only files more than one machine holds, without touching a collection', async () => {
    const move = vi.fn().mockResolvedValue({ released: [{ instanceId: 'other' }], pending: [], kept: [] });
    fixtures.listMediaPrimaryMachines.mockResolvedValue([{ instanceId: 'test-peer' }]);
    fixtures.prepareMediaConsolidation.mockResolvedValue(move);
    fixtures.listMediaHolders.mockResolvedValue({
      self: 'self',
      items: {
        'image:shared.png': { kind: 'image', filename: 'shared.png', holders: [{ instanceId: 'self' }, { instanceId: 'other' }] },
        'video:shared.mp4': { kind: 'video', filename: 'shared.mp4', holders: [{ instanceId: 'self' }, { instanceId: 'other' }] },
        'image:elsewhere.png': { kind: 'image', filename: 'elsewhere.png', holders: [{ instanceId: 'other' }] },
      },
    });

    expect(await startCollectionPrimary('shared-media', 'test-peer')).toMatchObject({ run: { total: 2 } });
    await vi.waitFor(async () => {
      expect(await getCollectionPrimaryStatus('shared-media')).toMatchObject({ instanceId: null, run: { running: false, completed: 2, released: 2 } });
    });
    expect(move.mock.calls.map(([entry]) => `${entry.kind}:${entry.filename}`)).toEqual(['image:shared.png', 'video:shared.mp4']);
    expect(fixtures.getCollection).not.toHaveBeenCalled();
    expect(fixtures.setCollectionPrimaryMachine).not.toHaveBeenCalled();
  });
});

describe('Unsorted primary consolidation', () => {
  it('consolidates the server inventory once without persisting a collection or primary', async () => {
    const files = [{ kind: 'image', filename: 'example.png' }, { kind: 'video', filename: 'example.mp4' }];
    const move = vi.fn().mockResolvedValue({ released: [], pending: [], kept: [] });
    fixtures.listMediaPrimaryMachines.mockResolvedValue([{ instanceId: 'test-peer' }]);
    fixtures.prepareMediaConsolidation.mockResolvedValue(move);
    fixtures.listUnsortedGalleryFiles.mockResolvedValue(files);

    expect(await getCollectionPrimaryStatus('unsorted')).toMatchObject({ instanceId: null, machines: [{ instanceId: 'test-peer' }] });
    expect(fixtures.listUnsortedGalleryFiles).not.toHaveBeenCalled();
    expect(await startCollectionPrimary('unsorted', 'test-peer')).toMatchObject({ run: { total: 2 } });
    await vi.waitFor(async () => {
      const status = await getCollectionPrimaryStatus('unsorted');
      expect(status).toMatchObject({ instanceId: null, run: { running: false, completed: 2 } });
    });
    expect(fixtures.prepareMediaConsolidation).toHaveBeenCalledWith('test-peer');
    expect(move.mock.calls).toEqual(files.map(file => [file]));
    expect(fixtures.getCollection).not.toHaveBeenCalled();
    expect(fixtures.setCollectionPrimaryMachine).not.toHaveBeenCalled();
    expect(fixtures.emitCollectionPrimaryChanged.mock.calls).toEqual([['unsorted'], ['unsorted']]);
  });

  it('starts no transfer if membership inventory is unavailable', async () => {
    const move = vi.fn();
    fixtures.prepareMediaConsolidation.mockResolvedValue(move);
    fixtures.listUnsortedGalleryFiles.mockRejectedValue(new Error('Inventory unavailable'));
    await expect(startCollectionPrimary('unsorted', 'test-peer')).rejects.toThrow('Inventory unavailable');
    expect(move).not.toHaveBeenCalled();
    expect(fixtures.emitCollectionPrimaryChanged).not.toHaveBeenCalled();
  });
});
