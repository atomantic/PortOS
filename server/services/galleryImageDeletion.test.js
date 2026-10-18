import { describe, it, expect, vi } from 'vitest';

const calls = vi.hoisted(() => ({ purge: vi.fn() }));
vi.mock('../lib/backupSnapshotBoundary.js', () => ({ withBackupAssetPublication: (fn) => fn() }));
vi.mock('./imageGen/local.js', () => ({ deleteImage: async (f) => ({ deleted: f }) }));
vi.mock('./universeCanon.js', () => ({ purgeImageRefFromAllUniverses: async () => ({ removed: 1 }) }));
vi.mock('./mediaCollections.js', () => ({ removeItemFromAllCollections: calls.purge }));

const { deleteGalleryImage } = await import('./galleryImageDeletion.js');

describe('deleteGalleryImage', () => {
  it('purges the filename from media collections and reports the count', async () => {
    calls.purge.mockResolvedValueOnce(2);
    const result = await deleteGalleryImage('a.png', { forgetInMusicVideos: false });
    expect(calls.purge).toHaveBeenCalledWith('image', 'a.png');
    expect(result).toMatchObject({ canonRefsRemoved: 1, collectionsPurged: 2 });
  });

  it('still completes the delete when the collection purge fails', async () => {
    calls.purge.mockRejectedValueOnce(new Error('disk'));
    const result = await deleteGalleryImage('b.png', { forgetInMusicVideos: false });
    expect(result).toMatchObject({ deleted: 'b.png', collectionsPurged: 0 });
  });
});
