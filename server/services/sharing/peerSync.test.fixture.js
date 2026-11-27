// Stub peer discovery, record services and the network. Subscription storage,
// cursors and asset files still use the real implementation on a test data root.

import { beforeEach, afterEach, vi } from 'vitest';
import { mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { PATHS } from '../../lib/fileUtils.js';
import { allSyncCategoriesOn } from '../../lib/instanceSyncCategories.js';
import { PORTOS_SCHEMA_VERSIONS } from '../../lib/schemaVersions.js';
import {
  applyIncomingPush,
  __resetForTests,
  __drainForTests,
} from './peerSync.js';
import { getPeers } from '../instances.js';
import { getInstanceId } from '../instanceIdentity.js';
import { getUniverse, mergeUniversesFromSync, listUniverses } from '../universeBuilder.js';
import { getSeries, mergeSeriesFromSync, listSeries } from '../pipeline/series.js';
import { getIssue, listAllIssues, listIssues, listIssuesForSeries, mergeIssuesFromSync } from '../pipeline/issues.js';
import { getReview, mergeReviewFromSync } from '../pipeline/manuscriptReview.js';
import { getStoredOutline, mergeOutlineFromSync } from '../pipeline/reverseOutline.js';
import {
  getCollection,
  listCollections,
  findCollectionByUniverseId,
  findCollectionBySeriesId,
  mergeMediaCollectionsFromSync,
} from '../mediaCollections.js';
import { getArtist, listArtists, mergeArtistsFromSync } from '../artists/index.js';
import { getAlbum, listAlbums, mergeAlbumsFromSync } from '../albums/index.js';
import { getTrack, listTracks, mergeTracksFromSync } from '../tracks/index.js';
import {
  getProject as getMusicVideoProject,
  listProjects as listMusicVideoProjects,
  mergeProjectsFromSync as mergeMusicVideoProjectsFromSync,
} from '../musicVideo/projects.js';
import { listAuthors, } from '../authors/index.js';
import { listProjects as listCreativeDirectorProjects } from '../creativeDirector/local.js';
import { listBoards, } from '../moodBoard/index.js';
import { getLoom, listLooms, mergeLoomsFromSync } from '../fableLoom/records.js';
import {
  listWorksForSync,
  listFoldersForSync,
  listExercisesForSync,
} from '../writersRoom/sync.js';
import { listCommissionFeedbackForSync, } from '../creativeCommissions/feedbackStore.js';
import { listCommissionsForSync, } from '../creativeCommissions/store.js';
import { peerFetch } from '../../lib/peerHttpClient.js';
import { getBackendName } from '../memoryBackend.js';
import { getCatalogBundleForRef } from '../catalog/catalogDB.js';
import { applyRemoteChanges as applyCatalogRemoteChanges } from '../catalog/catalogSync.js';
import { __drainForTests as __drainCursors } from './peerTombstoneCursors.js';
import { __resetBaseHashCacheForTests } from '../../lib/conflictJournal.js';

// instances.js / instanceIdentity.js mocks: align with mockNoPeers() /
// mockTestIdentity() (#6836 split identity out of instances.js) while keeping
// vi.fn() wrappers so per-test overrides via vi.mocked(getPeers)
// .mockResolvedValue([...]) still work. A plain mockNoPeers()/mockTestIdentity()
// call would return static functions that vi.mocked() cannot spy on — so we
// construct vi.fn() variants here and match the same defaults.
vi.mock('../instances.js', () => ({
  DEFAULT_SYNC_CATEGORIES: {},
  getPeers: vi.fn().mockResolvedValue([]),
  peerLogLabel: () => 'peer',
  enqueueReciprocalSync: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock('../instanceIdentity.js', () => ({
  UNKNOWN_INSTANCE_ID: 'unknown',
  getInstanceId: vi.fn().mockResolvedValue('test-instance'),
}));

vi.mock('../universeBuilder.js', async () => ({
  getUniverse: vi.fn(),
  mergeUniversesFromSync: vi.fn(),
  listUniverses: vi.fn(),
}));

vi.mock('../pipeline/series.js', async () => ({
  getSeries: vi.fn(),
  mergeSeriesFromSync: vi.fn(),
  listSeries: vi.fn(),
  SERIES_ID_RE: /^ser-[A-Za-z0-9-]+$/,
}));

vi.mock('../pipeline/issues.js', async () => ({
  getIssue: vi.fn(),
  listAllIssues: vi.fn(),
  listIssues: vi.fn(),
  listIssuesForSeries: vi.fn(),
  mergeIssuesFromSync: vi.fn(),
}));

// manuscriptReview is dynamic-imported inside the series push/receive helpers;
// mock both entry points so the review bundle path is exercisable.
vi.mock('../pipeline/manuscriptReview.js', async () => ({
  getReview: vi.fn(),
  mergeReviewFromSync: vi.fn(),
}));

// reverseOutline is dynamic-imported inside the series push/receive helpers (and
// statically by exporter.js, which peerSync.js imports) — mock both entry points
// so the outline bundle path is exercisable without loading the arcPlanner graph.
vi.mock('../pipeline/reverseOutline.js', async () => ({
  getStoredOutline: vi.fn(),
  mergeOutlineFromSync: vi.fn(),
}));

vi.mock('../mediaCollections.js', async () => ({
  getCollection: vi.fn(),
  listCollections: vi.fn(),
  findCollectionByUniverseId: vi.fn(),
  findCollectionBySeriesId: vi.fn(),
  mergeMediaCollectionsFromSync: vi.fn(),
}));

vi.mock('../videoGen/history.js', async (importOriginal) => ({
  ...(await importOriginal()),
  loadCompactHistory: async () => {
    const { PATHS, readJSONFile } = await import('../../lib/fileUtils.js');
    return readJSONFile(join(PATHS.data, 'video-history.json'), []);
  },
}));

// #1566 — the media-library sweep dynamic-imports this to rebuild the derived
// media_assets index after bytes land. Mock it to a no-op spy so the sweep tests
// don't touch Postgres and can assert the reconcile fired.
vi.mock('../mediaAssetIndex/index.js', () => ({
  reconcileMediaAssets: vi.fn().mockResolvedValue({ ok: true, skippedPrune: [] }),
}));

vi.mock('../artists/index.js', async () => {
  const imageBasename = (url) => {
    if (typeof url !== 'string' || !url.trim()) return null;
    if (/^(https?:|data:|blob:)/i.test(url)) return null;
    const prefix = '/data/images/';
    const value = url.startsWith(prefix) ? url.slice(prefix.length) : url;
    if (value.startsWith('/')) return null;
    return value.split(/[?#]/)[0].split('/').pop() || null;
  };
  return {
    getArtist: vi.fn(),
    listArtists: vi.fn(),
    mergeArtistsFromSync: vi.fn(),
    portraitImageFilename: vi.fn(imageBasename),
  };
});

vi.mock('../albums/index.js', async () => {
  const imageBasename = (url) => {
    if (typeof url !== 'string' || !url.trim()) return null;
    if (/^(https?:|data:|blob:)/i.test(url)) return null;
    const prefix = '/data/images/';
    const value = url.startsWith(prefix) ? url.slice(prefix.length) : url;
    if (value.startsWith('/')) return null;
    return value.split(/[?#]/)[0].split('/').pop() || null;
  };
  return {
    getAlbum: vi.fn(),
    listAlbums: vi.fn(),
    mergeAlbumsFromSync: vi.fn(),
    coverImageFilename: vi.fn(imageBasename),
  };
});

vi.mock('../tracks/index.js', async () => ({
  getTrack: vi.fn(),
  listTracks: vi.fn(),
  mergeTracksFromSync: vi.fn(),
  trackAudioFilename: vi.fn((name) => {
    if (typeof name !== 'string' || !name.trim()) return null;
    const value = name.trim();
    return value.includes('/') || value.includes('\\') || value.includes('..') ? null : value;
  }),
}));

vi.mock('../musicVideo/projects.js', async () => ({
  getProject: vi.fn(),
  listProjects: vi.fn(),
  mergeProjectsFromSync: vi.fn(),
}));

// #1964 — getFullSyncCoverageForPeer walks EVERY PEER_SUBSCRIBABLE_KIND and
// calls listRecordsForKind for each. These four backends were previously left
// unmocked, so on a developer machine with a populated `portos` Postgres the
// coverage `total` counted REAL author / CD-project / mood-board / writers-room
// rows instead of the fixture — the order-dependent flake tracked in #1964
// (`expected 3 to be 1`). Partially mock them (spread the real module via
// importOriginal so the merge/get/tombstone/asset surface other sharing modules
// import stays intact) and override ONLY the DB-reading list functions, so
// coverage is driven purely by the per-test fixture, hermetic regardless of
// suite order or DB contents.
vi.mock('../authors/index.js', async (importOriginal) => ({
  ...(await importOriginal()),
  listAuthors: vi.fn().mockResolvedValue([]),
  // #6843: getAuthor/mergeAuthorsFromSync stubbed (not spread from the real
  // module) so the all-kinds parity suite can drive/assert push+receive for
  // this kind the same way universe/series/etc. already are, without hitting
  // the real file-backed store.
  getAuthor: vi.fn(),
  mergeAuthorsFromSync: vi.fn().mockResolvedValue({ applied: true, count: 1 }),
}));

vi.mock('../creativeDirector/local.js', async (importOriginal) => ({
  ...(await importOriginal()),
  listProjects: vi.fn().mockResolvedValue([]),
  getProject: vi.fn(),
  mergeProjectsFromSync: vi.fn().mockResolvedValue({ applied: true, count: 1 }),
}));

vi.mock('../moodBoard/index.js', async (importOriginal) => ({
  ...(await importOriginal()),
  listBoards: vi.fn().mockResolvedValue([]),
  getBoard: vi.fn(),
  mergeBoardsFromSync: vi.fn().mockResolvedValue({ applied: true, count: 1 }),
}));

vi.mock('../fableLoom/records.js', () => ({
  getLoom: vi.fn(),
  listLooms: vi.fn().mockResolvedValue([]),
  mergeLoomsFromSync: vi.fn().mockResolvedValue({ applied: true, count: 1 }),
}));

vi.mock('../writersRoom/bibleSync.js', async (importOriginal) => ({
  ...(await importOriginal()),
  diffWorkBibleManifest: vi.fn().mockResolvedValue([]),
}));

vi.mock('../writersRoom/sync.js', async (importOriginal) => ({
  ...(await importOriginal()),
  listWorksForSync: vi.fn().mockResolvedValue([]),
  listFoldersForSync: vi.fn().mockResolvedValue([]),
  listExercisesForSync: vi.fn().mockResolvedValue([]),
  getWorkForSync: vi.fn(),
  mergeWorksFromSync: vi.fn().mockResolvedValue({ applied: true, count: 1 }),
  getFolderForSync: vi.fn(),
  mergeFoldersFromSync: vi.fn().mockResolvedValue({ applied: true, count: 1 }),
  getExerciseForSync: vi.fn(),
  mergeExercisesFromSync: vi.fn().mockResolvedValue({ applied: true, count: 1 }),
}));

// #2686: commissionFeedback is a per-record store peerSync's getFullSyncCoverageForPeer
// iterates via PEER_SUBSCRIBABLE_KINDS. Mock the lister so the zero-records
// coverage assertions don't read the real (dev-Postgres) backend.
vi.mock('../creativeCommissions/feedbackStore.js', async (importOriginal) => ({
  ...(await importOriginal()),
  listCommissionFeedbackForSync: vi.fn().mockResolvedValue([]),
  getCommissionFeedbackForSync: vi.fn(),
  mergeCommissionFeedbackFromSync: vi.fn().mockResolvedValue({ applied: true, count: 1 }),
}));

vi.mock('../creativeCommissions/store.js', async (importOriginal) => ({
  ...(await importOriginal()),
  listCommissionsForSync: vi.fn().mockResolvedValue([]),
  getCommissionForSync: vi.fn(),
  mergeCommissionsFromSync: vi.fn().mockResolvedValue({ applied: true, count: 1 }),
}));

vi.mock('../storyboards/index.js', () => ({
  listStoryboardsForSync: vi.fn().mockResolvedValue([]),
  listStoryboardIdsForSync: vi.fn().mockResolvedValue([]),
  getStoryboardForSync: vi.fn(),
  mergeStoryboardsFromSync: vi.fn().mockResolvedValue({ applied: true, count: 1 }),
  pruneTombstonedStoryboards: vi.fn().mockResolvedValue({ pruned: 0 }),
}));

vi.mock('../decks.js', () => ({
  listDecksForSync: vi.fn().mockResolvedValue([]),
  listDeckIdsForSync: vi.fn().mockResolvedValue([]),
  getDeckForSync: vi.fn(),
  mergeDecksFromSync: vi.fn().mockResolvedValue({ applied: true, count: 1 }),
  pruneTombstonedDecks: vi.fn().mockResolvedValue({ pruned: 0, ids: [] }),
}));

vi.mock('../../lib/peerHttpClient.js', async (importOriginal) => ({
  ...(await importOriginal()),
  peerFetch: vi.fn(),
  peerSocketOptions: {},
}));

// Catalog bundle deps are dynamic-imported inside the universe push/apply
// helpers; mock the backend + DB + sync so the bundle path is exercisable
// without Postgres. Default backend is non-postgres so existing tests see no
// bundle; the catalog-bundle suite overrides getBackendName per-test.
vi.mock('../memoryBackend.js', async () => ({
  getBackendName: vi.fn(() => 'file'),
}));

vi.mock('../catalog/catalogDB.js', async () => ({
  getCatalogBundleForRef: vi.fn(),
  getLocalIngredientRefOwnership: vi.fn().mockResolvedValue({ existing: new Set(), linked: new Set() }),
}));

vi.mock('../catalog/catalogSync.js', async () => ({
  applyRemoteChanges: vi.fn(),
}));

// A chunked body with no Content-Length that never ends; only the streaming
// cap in readPeerBody can stop it.
const endlessChunkedRes = () => {
  const chunk = new Uint8Array(8 * 1024 * 1024);
  return new Response(new ReadableStream({ pull(controller) { controller.enqueue(chunk); } }));
};

const peerToken = 'synthetic-federation-test-secret-32';

const pairedPeer = (overrides = {}) => ({
  id: 'configured-peer-a',
  instanceId: 'peer-a',
  name: 'Peer A',
  host: null,
  address: '10.0.0.2',
  port: 5555,
  syncSecret: peerToken,
  enabled: true,
  syncEnabled: true,
  directions: ['outbound', 'inbound'],
  syncCategories: allSyncCategoriesOn(),
  ...overrides,
});

const pushFromPairedPeer = (payload) => applyIncomingPush(payload, { peerToken });

let originalDataPath;
let originalImagesPath;
let originalImageRefsPath;
let originalVideosPath;
let originalMusicPath;
let tmp;

const acceptsPush = (body = {}) => ({ ok: true, status: 200, json: async () => body });

const CURRENT_PORTOS_META = { schemaVersions: PORTOS_SCHEMA_VERSIONS };

// Exercise music-video delivery to a peer that opted into projects only.
const enableMusicVideoPeer = () => {
  vi.mocked(getPeers).mockResolvedValue([pairedPeer({ syncCategories: { musicVideoProjects: true } })]);
};

const sampleOutline = (generatedAt = '2026-06-02T00:00:00Z') => ({
  schemaVersion: 1, status: 'complete', generatedAt,
  plotlines: [{ id: 'a', label: 'A', kind: 'main' }],
  scenes: [{ id: 'scene-001', sequence: 0, summary: 'opening', plotlineId: 'a' }],
});

function installPeerSyncHooks() {
  beforeEach(async () => {
    // Capture EVERY PATHS field we (or any test in this file) might mutate so
    // the afterEach restoration is total. The sha-mismatch-for-all-kinds test
    // points PATHS.imageRefs / PATHS.videos at the per-test tmpdir; without
    // restoring them here, later tests in unrelated files inherit the deleted
    // tmpdir and get ENOENT on real asset reads.
    originalDataPath = PATHS.data;
    originalImagesPath = PATHS.images;
    originalImageRefsPath = PATHS.imageRefs;
    originalVideosPath = PATHS.videos;
    originalMusicPath = PATHS.music;
    tmp = join(tmpdir(), `portos-peer-sync-${Date.now()}-${Math.random()}`);
    await mkdir(join(tmp, 'sharing'), { recursive: true });
    await mkdir(join(tmp, 'images'), { recursive: true });
    await mkdir(join(tmp, 'music'), { recursive: true });
    PATHS.data = tmp;
    PATHS.images = join(tmp, 'images');
    PATHS.music = join(tmp, 'music');

    // Reset mocks. The default peer fixture INTENTIONALLY INVERTS production
    // defaults: `addPeer` in instances.js creates peers with `syncEnabled:
    // false`, every `syncCategories.*` false, and `directions: ['outbound']`
    // (the user has to explicitly opt them in via the Instances page).
    // Tests in this file pre-enable everything so the new outbound/category
    // gates in pushRecordToPeer don't short-circuit the broader push-pipeline
    // assertions. Tests that exercise the gating paths explicitly override
    // these mocks with the relevant flag flipped off.
    vi.mocked(getInstanceId).mockResolvedValue('local-instance');
    vi.mocked(getPeers).mockResolvedValue([
      pairedPeer(),
      pairedPeer({
        id: 'configured-peer-b', instanceId: 'peer-b-inbound-only', name: 'Peer B', address: '10.0.0.3',
        directions: ['inbound'], syncCategories: { universe: true, pipeline: true },
      }),
    ]);
    vi.mocked(peerFetch).mockReset();
    vi.mocked(mergeUniversesFromSync).mockResolvedValue({ applied: true, count: 1 });
    vi.mocked(mergeSeriesFromSync).mockResolvedValue({ applied: true, count: 1 });
    vi.mocked(mergeIssuesFromSync).mockResolvedValue({ applied: true, count: 1 });
    // Default getUniverse / getSeries / issue-service mocks to resolved promises
    // so any callsite that doesn't override (e.g. the receiver-side
    // `isLocalRecordEphemeral` lookup in maybeCreateReverseSubscription)
    // doesn't blow up on `.catch` against a `vi.fn()` non-Promise return.
    // The real service functions are `async` so they always
    // return Promises; production code can assume this, but the test mock
    // has to match, including listIssuesForSeries so a buildPushPayload path
    // that bundles child issues doesn't choke on an un-overridden mock.
    vi.mocked(listUniverses).mockReset().mockResolvedValue([]);
    vi.mocked(listSeries).mockReset().mockResolvedValue([]);
    vi.mocked(getUniverse).mockReset().mockResolvedValue(undefined);
    vi.mocked(getSeries).mockReset().mockResolvedValue(undefined);
    vi.mocked(getIssue).mockReset().mockResolvedValue(undefined);
    vi.mocked(listAllIssues).mockReset().mockResolvedValue([]);
    vi.mocked(listIssues).mockReset().mockResolvedValue([]);
    vi.mocked(listIssuesForSeries).mockReset().mockResolvedValue([]);
    // Default: no manuscript review for any series. Tests that exercise the
    // review-bundle path override getReview per-call.
    vi.mocked(getReview).mockReset().mockResolvedValue({ schemaVersion: 1, comments: [] });
    vi.mocked(mergeReviewFromSync).mockReset().mockResolvedValue({ schemaVersion: 1, comments: [] });
    // Default: no stored reverse outline for any series. Tests that exercise the
    // outline-bundle path override getStoredOutline per-call.
    vi.mocked(getStoredOutline).mockReset().mockResolvedValue(null);
    vi.mocked(mergeOutlineFromSync).mockReset().mockResolvedValue(null);
    // Default: no linked collection for any record. Tests that exercise the
    // bundle path override these per-call.
    vi.mocked(getCollection).mockReset().mockRejectedValue(Object.assign(new Error('Collection not found'), { code: 'NOT_FOUND' }));
    vi.mocked(listCollections).mockReset().mockResolvedValue([]);
    vi.mocked(findCollectionByUniverseId).mockReset().mockResolvedValue(null);
    vi.mocked(findCollectionBySeriesId).mockReset().mockResolvedValue(null);
    vi.mocked(mergeMediaCollectionsFromSync).mockReset().mockResolvedValue({ applied: false, count: 0 });
    vi.mocked(getArtist).mockReset().mockResolvedValue(null);
    vi.mocked(listArtists).mockReset().mockResolvedValue([]);
    vi.mocked(mergeArtistsFromSync).mockReset().mockResolvedValue({ applied: true, count: 1 });
    vi.mocked(getAlbum).mockReset().mockResolvedValue(null);
    vi.mocked(listAlbums).mockReset().mockResolvedValue([]);
    vi.mocked(mergeAlbumsFromSync).mockReset().mockResolvedValue({ applied: true, count: 1 });
    vi.mocked(getTrack).mockReset().mockResolvedValue(null);
    vi.mocked(listTracks).mockReset().mockResolvedValue([]);
    vi.mocked(mergeTracksFromSync).mockReset().mockResolvedValue({ applied: true, count: 1 });
    vi.mocked(getMusicVideoProject).mockReset().mockResolvedValue(null);
    vi.mocked(listMusicVideoProjects).mockReset().mockResolvedValue([]);
    vi.mocked(mergeMusicVideoProjectsFromSync).mockReset().mockResolvedValue({ applied: true, count: 1 });
    // #1964 — default the remaining coverage list backends to empty so the full-
    // sync coverage `total` is fixture-driven, never leaking real Postgres rows.
    vi.mocked(listAuthors).mockReset().mockResolvedValue([]);
    vi.mocked(listCreativeDirectorProjects).mockReset().mockResolvedValue([]);
    vi.mocked(listBoards).mockReset().mockResolvedValue([]);
    vi.mocked(getLoom).mockReset().mockResolvedValue(null);
    vi.mocked(listLooms).mockReset().mockResolvedValue([]);
    vi.mocked(mergeLoomsFromSync).mockReset().mockResolvedValue({ applied: true, count: 1 });
    vi.mocked(listWorksForSync).mockReset().mockResolvedValue([]);
    vi.mocked(listFoldersForSync).mockReset().mockResolvedValue([]);
    vi.mocked(listExercisesForSync).mockReset().mockResolvedValue([]);
    vi.mocked(listCommissionFeedbackForSync).mockReset().mockResolvedValue([]);
    vi.mocked(listCommissionsForSync).mockReset().mockResolvedValue([]);
    // Catalog bundle defaults: non-postgres backend (no bundle), empty DB read,
    // no-op apply. The catalog-bundle suite overrides these per-test.
    vi.mocked(getBackendName).mockReset().mockReturnValue('file');
    vi.mocked(getCatalogBundleForRef).mockReset().mockResolvedValue({ ingredients: [], refs: [] });
    vi.mocked(applyCatalogRemoteChanges).mockReset().mockResolvedValue({ errors: [] });

    // The conflict-journal base-hash side store caches `_baseHashes` against the
    // first PATHS.data it loaded; reset it so each test's fresh tmpdir starts
    // with an empty map (and stamps from a prior test don't bleed in).
    __resetBaseHashCacheForTests();

    await __resetForTests();
  });

  afterEach(async () => {
    try {
      // The peer-sync drain owns every fire-and-forget push/listener promise;
      // cursor writes are serialized on a separate tail. One deterministic pass
      // replaces the former fixed sleeps and prevents late writes racing rm.
      await __drainForTests();
      await __drainCursors();
      await __resetForTests();
      await rm(tmp, { recursive: true, force: true });
    } finally {
      // Restore shared PATHS even when teardown itself fails so one test cannot
      // leak its temporary data root into the rest of the suite.
      PATHS.data = originalDataPath;
      PATHS.images = originalImagesPath;
      PATHS.imageRefs = originalImageRefsPath;
      PATHS.videos = originalVideosPath;
      PATHS.music = originalMusicPath;
    }
  });
}

export {
  tmp,
  installPeerSyncHooks,
  acceptsPush,
  enableMusicVideoPeer,
  endlessChunkedRes,
  pairedPeer,
  pushFromPairedPeer,
  CURRENT_PORTOS_META,
  sampleOutline,
};
