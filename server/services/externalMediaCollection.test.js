import { describe, it, expect, vi, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { mockNoPeerSync } from '../lib/mockPathsDataRoot.js';

const ROOT = mkdtempSync(join(tmpdir(), 'external-collection-test-'));
const IMAGES = join(ROOT, 'images');
const VIDEOS = join(ROOT, 'videos');
mkdirSync(IMAGES, { recursive: true });
mkdirSync(VIDEOS, { recursive: true });

vi.mock('../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, PATHS: { ...actual.PATHS, data: ROOT, images: IMAGES, videos: VIDEOS } };
});
vi.mock('./sharing/peerSync.js', () => mockNoPeerSync());
vi.mock('./videoGen/history.js', () => ({
  loadHistory: async () => [
    { id: 'dl-1', source: 'download', filename: 'downloaded-dl-1.mp4' },
    { id: 'gen-1', filename: 'gen-1.mp4' },
  ],
}));

const { fileExternalMedia, backfillExternalMediaCollection } = await import('./externalMediaCollection.js');
const { getCollection, EXTERNAL_COLLECTION_ID, bulkUpdateCollectionItems } = await import('./mediaCollections.js');

afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const keys = async () => (await getCollection(EXTERNAL_COLLECTION_ID)).items.map((it) => `${it.kind}:${it.ref}`).sort();

describe('External media collection', () => {
  it('creates the External collection on first filing and is idempotent', async () => {
    await fileExternalMedia([{ kind: 'image', ref: 'pinterest-0123456789abcdef.jpg' }]);
    await fileExternalMedia([{ kind: 'image', ref: 'pinterest-0123456789abcdef.jpg' }]);
    const c = await getCollection(EXTERNAL_COLLECTION_ID);
    expect(c.name).toBe('External');
    expect(await keys()).toEqual(['image:pinterest-0123456789abcdef.jpg']);
  });

  it('backfills existing downloads once, then leaves user removals alone', async () => {
    writeFileSync(join(IMAGES, 'x-0123456789abcdef.png'), 'x');
    writeFileSync(join(IMAGES, 'board-0123456789abcdef.webp'), 'x');
    writeFileSync(join(IMAGES, 'render-123.png'), 'x');
    writeFileSync(join(VIDEOS, 'x-fedcba9876543210.mp4'), 'x');
    const first = await backfillExternalMediaCollection();
    expect(first.added).toBe(4);
    expect(await keys()).toEqual([
      'image:board-0123456789abcdef.webp',
      'image:pinterest-0123456789abcdef.jpg',
      'image:x-0123456789abcdef.png',
      'video:dl-1',
      'video:x-fedcba9876543210.mp4',
    ]);
    expect(existsSync(join(ROOT, 'external-collection-backfill.json'))).toBe(true);

    await bulkUpdateCollectionItems(EXTERNAL_COLLECTION_ID, { remove: ['video:dl-1'] });
    expect((await backfillExternalMediaCollection()).skipped).toBe(true);
    expect(await keys()).not.toContain('video:dl-1');
  });

  it('never throws when filing fails', async () => {
    await expect(fileExternalMedia([{ kind: 'bogus', ref: 'a' }])).resolves.toBeNull();
  });
});

describe('mood board collection', () => {
  it('is named like the board and follows a rename', async () => {
    const { findOrCreateMoodBoardCollection } = await import('./mediaCollections.js');
    const first = await findOrCreateMoodBoardCollection({ boardId: 'mb-1', boardName: 'Neon Study' });
    expect(first).toMatchObject({ id: 'mbc-mb-1', name: 'Neon Study' });
    const renamed = await findOrCreateMoodBoardCollection({ boardId: 'mb-1', boardName: 'Neon Study II' });
    expect(renamed).toMatchObject({ id: 'mbc-mb-1', name: 'Neon Study II' });
  });
});
