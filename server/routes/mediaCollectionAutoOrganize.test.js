import { afterAll, expect, it, vi } from 'vitest';
import express from 'express';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

const fixtures = vi.hoisted(() => ({
  decks: [
    { id: 'deck-a', name: 'Match', cards: [{ imageRefs: ['kept.png', 'missing.png'], primaryImageRef: 'kept.png' }] },
    { id: 'deck-b', name: 'Match', cards: [{ primaryImageRef: 'different.png' }] },
    { id: 'deck-removed', name: 'Removed', deleted: true, cards: [{ primaryImageRef: 'deleted-deck.png' }] },
  ],
  board: { id: 'board-a', name: 'Palette', posterImageRef: 'poster.png', items: [
    { type: 'image', mediaKey: 'image:rendered.png', renderedAt: '2026-01-01' },
    { type: 'image', mediaKey: 'image:reference.png' },
  ] },
}));

vi.mock('../lib/fileUtils.js', async importOriginal =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-auto-organize-') }));
vi.mock('../services/decks.js', () => ({
  listDecksForIntegrity: async () => fixtures.decks,
  getDeck: async id => fixtures.decks.find(deck => deck.id === id),
  attachCardRender: async () => null,
}));
vi.mock('../services/moodBoard/db.js', () => ({ listBoards: async () => [fixtures.board] }));
vi.mock('../services/musicVideo/projects.js', () => ({ listProjects: async () => [{ id: 'mv-a', name: 'Clip project', scenes: [{ referenceImageId: 'frame.png' }] }] }));
vi.mock('../services/storyboards/index.js', () => ({ listStoryboards: async () => [] }));
vi.mock('../services/fableLoom/records.js', () => ({ listLooms: async () => [] }));
vi.mock('../services/creativeDirector/local.js', () => ({ listProjects: async () => [] }));
vi.mock('../services/videoTimeline/local.js', () => ({ listProjects: async () => [] }));
vi.mock('../services/writersRoom/local.js', () => ({ listWorks: async () => [] }));
vi.mock('../services/sprites/records.js', () => ({ listRecords: async () => [] }));
vi.mock('../services/externalMediaCollection.js', () => ({ collectExistingExternalMedia: async () => [] }));
vi.mock('../services/videoGen/history.js', () => ({ loadHistory: async () => [
  { id: 'clip-id', filename: 'actual-name.mp4', musicVideoProjectId: 'mv-a' },
] }));
vi.mock('../services/peerHostedMedia.js', () => ({
  resolveMediaLocations: vi.fn(async items => items.map(item => ({
    location: item.ref === 'missing.png' || item.ref === 'clip-id' ? 'missing' : 'remote',
  }))),
  findHostPeer: vi.fn(),
  unmarkHosted: vi.fn(),
}));
vi.mock('../services/sharing/peerSyncAssets.js', () => ({
  collectionVideoRefToFilename: vi.fn(),
  pullMissingAssetsFromPeer: vi.fn(),
}));

afterAll(cleanupTempDataRoots);

const { default: router } = await import('./mediaCollections.js');
const { createMediaJobHookLoader } = await import('../services/mediaJobQueue/hookRegistry.js');
const { archive, mediaJobEvents } = await import('../services/mediaJobQueue/queueState.js');
const collections = await import('../services/mediaCollections.js');

const app = express();
app.use('/api/media/collections', router);
app.use(errorMiddleware);
const organize = () => request(app).post('/api/media/collections/auto-organize');
const refs = collection => collection.items.map(item => item.ref).sort();

it('repairs deck, mood board and project collections idempotently, preserving removals', async () => {
  const liveJob = {
    id: 'live', kind: 'image', status: 'completed', params: { deckCard: { deckId: 'deck-a', cardId: 'card-a' } },
    result: { filename: 'live.png', finishedVariant: { filename: 'live-finished.png' } },
  };
  await createMediaJobHookLoader()(liveJob);
  mediaJobEvents.emit('completed', liveJob);
  await vi.waitFor(async () => {
    expect(refs(await collections.getCollection('deck-deck-a'))).toEqual(['live-finished.png', 'live.png']);
  });
  await collections.removeItem('deck-deck-a', 'image:live.png');
  archive.push(liveJob);

  const first = await organize();
  expect(first.status).toBe(200);
  expect(first.body).toEqual({ added: 6, updatedCollections: 4, missingAssets: 1, failedCollections: 0 });
  const deck = await collections.getCollection('deck-deck-a');
  expect(deck).toMatchObject({ name: 'Deck: Match', source: 'auto' });
  expect(refs(deck)).toEqual(['kept.png', 'live-finished.png']);
  expect(refs(await collections.getCollection('deck-deck-b'))).toEqual(['different.png']);
  expect(refs(await collections.getCollection('mbc-board-a'))).toEqual(['poster.png', 'rendered.png']);
  expect(refs(await collections.getCollection('mvc-mv-a'))).toEqual(['clip-id', 'frame.png']);
  expect((await collections.listCollectionIds())).not.toContain('deck-deck-removed');

  const second = await organize();
  expect(second.body).toEqual({ added: 0, updatedCollections: 0, missingAssets: 1, failedCollections: 0 });
  expect((await collections.getCollection('deck-deck-a')).updatedAt).toBe(deck.updatedAt);
});
