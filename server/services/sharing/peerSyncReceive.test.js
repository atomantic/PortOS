import { beforeEach, describe, expect, it, vi } from 'vitest';
import { timingSafeEqual } from 'node:crypto';
import { mockNoPeers, mockTestIdentity } from '../../lib/mockPathsDataRoot.js';
import { PORTOS_SCHEMA_VERSIONS } from '../../lib/schemaVersions.js';
import { getPeers } from '../instances.js';
import { getLocalIngredientRefOwnership } from '../catalog/catalogDB.js';
import { applyRemoteChanges } from '../catalog/catalogSync.js';
import { findPeerSubscription, subscribePeer } from './peerSubscriptions.js';
import { diffAssetManifestAgainstLocal, pullMissingAssetsFromPeer } from './peerSyncAssets.js';
import { RECORD_KINDS } from './recordKinds.js';
import { applyIncomingPush } from './peerSyncReceive.js';
import { ERR_SCHEMA_VERSION_AHEAD } from './peerSyncShared.js';

vi.mock('node:crypto', { spy: true });
vi.mock('../instances.js', () => mockNoPeers({}, { getPeers: vi.fn() }));
vi.mock('../instanceIdentity.js', () => mockTestIdentity());
vi.mock('../catalog/catalogDB.js', () => ({ getLocalIngredientRefOwnership: vi.fn() }));
vi.mock('../catalog/catalogSync.js', () => ({ applyRemoteChanges: vi.fn() }));
vi.mock('../memoryBackend.js', () => ({ getBackendName: () => 'postgres' }));
vi.mock('../pipeline/issues.js', () => ({ mergeIssuesFromSync: vi.fn() }));
vi.mock('../pipeline/series.js', () => ({ SERIES_ID_RE: /^ser-[A-Za-z0-9-]+$/ }));
vi.mock('../pipeline/manuscriptReview.js', () => ({ mergeReviewFromSync: vi.fn() }));
vi.mock('../pipeline/reverseOutline.js', () => ({ mergeOutlineFromSync: vi.fn() }));
vi.mock('../writersRoom/sync.js', () => ({ diffWorkBodyManifest: vi.fn(), getWorkForSync: vi.fn() }));
vi.mock('./peerSubscriptions.js', () => ({
  findPeerSubscription: vi.fn(),
  subscribePeer: vi.fn(),
}));
vi.mock('./peerSyncAssets.js', () => ({
  diffAssetManifestAgainstLocal: vi.fn(),
  pullMissingAssetsFromPeer: vi.fn(),
}));

// Stub the descriptor table's store and asset hooks so the receiver, authorization
// and category policy run together without opening the live data paths.
vi.mock('./recordKinds.js', () => ({
  RECORD_KINDS: {
    universe: { load: vi.fn(), merge: vi.fn(), referencedAssets: vi.fn(), hasEphemeral: true },
    series: { load: vi.fn(), merge: vi.fn(), hasEphemeral: true },
    mediaCollection: { load: vi.fn(), merge: vi.fn() },
    musicVideoProject: { load: vi.fn(), merge: vi.fn() },
    track: { load: vi.fn(), merge: vi.fn() },
  },
}));

const peerToken = 'synthetic-federation-receiver-secret';
const sourceInstanceId = 'peer-a';
const source = { via: 'peer-push', peerId: sourceInstanceId };
const portosMeta = { schemaVersions: PORTOS_SCHEMA_VERSIONS };
const configuredPeer = {
  id: 'configured-peer',
  instanceId: sourceInstanceId,
  syncSecret: peerToken,
  enabled: true,
  syncEnabled: true,
  directions: ['inbound'],
  syncCategories: { universe: true, pipeline: true, musicVideoProjects: true },
};

const payload = (overrides = {}) => ({
  kind: 'universe',
  record: { id: 'u1' },
  assetManifest: [],
  sourceInstanceId,
  portosMeta,
  ...overrides,
});
const authenticatedPush = (overrides) => applyIncomingPush(payload(overrides), { peerToken });
const image = { kind: 'image', filename: 'cover.png', sha256: 'a'.repeat(64) };
const withAsset = { record: { id: 'u1', imageRefs: [image.filename] }, assetManifest: [image] };

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getPeers).mockResolvedValue([configuredPeer]);
  vi.mocked(findPeerSubscription).mockResolvedValue(null);
  vi.mocked(diffAssetManifestAgainstLocal).mockResolvedValue([image]);
  vi.mocked(pullMissingAssetsFromPeer).mockResolvedValue(undefined);
  RECORD_KINDS.universe.referencedAssets.mockReturnValue([image]);
  for (const { load, merge } of Object.values(RECORD_KINDS)) {
    load.mockResolvedValue(null);
    merge.mockResolvedValue({ applied: true });
  }
});

function expectNoReceiveSideEffects() {
  for (const { load, merge } of Object.values(RECORD_KINDS)) {
    expect(load).not.toHaveBeenCalled();
    expect(merge).not.toHaveBeenCalled();
  }
  expect(getLocalIngredientRefOwnership).not.toHaveBeenCalled();
  expect(applyRemoteChanges).not.toHaveBeenCalled();
  expect(diffAssetManifestAgainstLocal).not.toHaveBeenCalled();
  expect(pullMissingAssetsFromPeer).not.toHaveBeenCalled();
  expect(findPeerSubscription).not.toHaveBeenCalled();
  expect(subscribePeer).not.toHaveBeenCalled();
}

describe('applyIncomingPush peer admission', () => {
  it('accepts a paired inbound peer using the timing-safe comparison', async () => {
    await expect(authenticatedPush(withAsset)).resolves.toMatchObject({ missingAssets: [image] });
    expect(timingSafeEqual).toHaveBeenCalledWith(Buffer.from(peerToken), Buffer.from(peerToken));
    expect(RECORD_KINDS.universe.merge).toHaveBeenCalledWith([withAsset.record], {
      source, senderSchemaVersions: PORTOS_SCHEMA_VERSIONS,
    });
    expect(pullMissingAssetsFromPeer).toHaveBeenCalledWith(sourceInstanceId, [image], { includeMismatched: true });
  });

  it.each([
    ['missing', undefined, false],
    ['shorter', peerToken.slice(1), false],
    ['wrong with the same byte length', 'x'.repeat(peerToken.length), true],
  ])('rejects a %s token before any receiver side effects', async (_name, token, compares) => {
    await expect(applyIncomingPush(payload(withAsset), { peerToken: token }))
      .rejects.toMatchObject({ status: 401, code: 'PEER_SYNC_AUTH_REQUIRED' });
    expect(timingSafeEqual).toHaveBeenCalledTimes(compares ? 1 : 0);
    expectNoReceiveSideEffects();
  });

  it.each([
    ['unknown peer', [], sourceInstanceId],
    ['announcement without pairing', [{ ...configuredPeer, syncSecret: undefined }], sourceInstanceId],
    ['another source identity', [configuredPeer], 'peer-other'],
  ])('rejects %s even when the token matches the configured peer', async (_name, peers, claimedSource) => {
    vi.mocked(getPeers).mockResolvedValue(peers);
    await expect(authenticatedPush({ ...withAsset, sourceInstanceId: claimedSource }))
      .rejects.toMatchObject({ status: 401, code: 'PEER_SYNC_AUTH_REQUIRED' });
    expectNoReceiveSideEffects();
  });

  it.each([
    ['disabled peer', { enabled: false }],
    ['sync off even with full sync', { syncEnabled: false, fullSync: true }],
    ['outbound-only direction', { directions: ['outbound'] }],
    ['category denied', { syncCategories: { universe: false } }],
  ])('refuses %s with valid proof', async (_name, overrides) => {
    vi.mocked(getPeers).mockResolvedValue([{ ...configuredPeer, ...overrides }]);
    await expect(authenticatedPush(withAsset)).rejects.toMatchObject({ status: 403, code: 'PEER_SYNC_NOT_ADMITTED' });
    expectNoReceiveSideEffects();
  });

  it('accepts an explicit local pull from the configured outbound peer without a token', async () => {
    vi.mocked(getPeers).mockResolvedValue([{ ...configuredPeer, directions: ['outbound'] }]);
    await applyIncomingPush(payload(), { pullPeerId: configuredPeer.id });
    expect(RECORD_KINDS.universe.merge).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['inbound-only peer', {}],
    ['disabled sync', { directions: ['outbound'], syncEnabled: false }],
  ])('refuses a local pull from a %s', async (_name, overrides) => {
    vi.mocked(getPeers).mockResolvedValue([{ ...configuredPeer, ...overrides }]);
    await expect(applyIncomingPush(payload(), { pullPeerId: configuredPeer.id }))
      .rejects.toMatchObject({ status: 403, code: 'PEER_SYNC_NOT_ADMITTED' });
    expectNoReceiveSideEffects();
  });

  it('requires the local pull context to match the configured peer ID', async () => {
    vi.mocked(getPeers).mockResolvedValue([{ ...configuredPeer, directions: ['outbound'] }]);
    await expect(applyIncomingPush(payload(), { pullPeerId: 'another-configured-peer' }))
      .rejects.toMatchObject({ status: 401, code: 'PEER_SYNC_AUTH_REQUIRED' });
    expectNoReceiveSideEffects();
  });
});

describe('applyIncomingPush schema gate', () => {
  const collection = { id: 'col-1', universeId: 'u1', items: [] };
  const receiverV = PORTOS_SCHEMA_VERSIONS.mediaCollections;
  const senderV = receiverV + 1;
  const ahead = {
    ...withAsset,
    linkedCollection: collection,
    portosMeta: { portosVersion: '999.0.0', schemaVersions: { ...PORTOS_SCHEMA_VERSIONS, mediaCollections: senderV } },
  };

  it('rejects a live companion schema ahead before loading or merging the parent or bundle', async () => {
    await expect(authenticatedPush(ahead)).rejects.toMatchObject({
      code: ERR_SCHEMA_VERSION_AHEAD,
      details: {
        ahead: [{ category: 'mediaCollections', senderV, receiverV }],
        behind: [],
        senderPortosVersion: '999.0.0',
        receiverSchemaVersions: PORTOS_SCHEMA_VERSIONS,
      },
    });
    expectNoReceiveSideEffects();
  });

  it('authenticates before returning version details for an ahead payload', async () => {
    const error = applyIncomingPush(payload(ahead));
    await expect(error).rejects.toMatchObject({ status: 401, code: 'PEER_SYNC_AUTH_REQUIRED' });
    await expect(error).rejects.not.toHaveProperty('details');
    expectNoReceiveSideEffects();
  });
});

describe('applyIncomingPush linked collection binding', () => {
  const collection = { id: 'col-1', universeId: 'u1', items: [] };

  it.each([
    ['universe', { id: 'u1' }, collection],
    ['series', { id: 'ser-1' }, { id: 'col-1', seriesId: 'ser-1', items: [] }],
  ])('merges a %s collection with the matching local owner', async (kind, record, linkedCollection) => {
    RECORD_KINDS.mediaCollection.load.mockResolvedValue(linkedCollection);
    await authenticatedPush({ kind, record, linkedCollection });
    expect(RECORD_KINDS.mediaCollection.load).toHaveBeenCalledWith(linkedCollection.id);
    expect(RECORD_KINDS.mediaCollection.merge).toHaveBeenCalledWith([linkedCollection], { source });
  });

  it('merges a correctly bound collection after a not-found result', async () => {
    RECORD_KINDS.mediaCollection.load.mockRejectedValue(Object.assign(new Error('Collection not found'), { status: 404 }));
    await authenticatedPush({ linkedCollection: collection });
    expect(RECORD_KINDS.mediaCollection.merge).toHaveBeenCalledExactlyOnceWith([collection], { source });
  });

  it.each([
    ['another parent', { ...collection, universeId: 'u-other' }],
    ['no parent', { id: collection.id }],
  ])('skips a submitted collection naming %s', async (_name, linkedCollection) => {
    await authenticatedPush({ linkedCollection });
    expect(RECORD_KINDS.universe.merge).toHaveBeenCalledTimes(1);
    expect(RECORD_KINDS.mediaCollection.load).not.toHaveBeenCalled();
    expect(RECORD_KINDS.mediaCollection.merge).not.toHaveBeenCalled();
  });

  it('skips a submitted collection for a kind that cannot own it', async () => {
    await authenticatedPush({
      kind: 'musicVideoProject', record: { id: 'mv-1' },
      linkedCollection: { ...collection, universeId: 'mv-1' },
    });
    expect(RECORD_KINDS.musicVideoProject.merge).toHaveBeenCalledTimes(1);
    expect(RECORD_KINDS.mediaCollection.load).not.toHaveBeenCalled();
    expect(RECORD_KINDS.mediaCollection.merge).not.toHaveBeenCalled();
  });

  it.each([
    ['another parent ID', { ...collection, universeId: 'u-other' }],
    ['another parent kind with the same ID', { id: collection.id, seriesId: 'u1' }],
  ])('keeps the local collection bound to %s', async (_name, localCollection) => {
    RECORD_KINDS.mediaCollection.load.mockResolvedValue(localCollection);
    await authenticatedPush({ linkedCollection: collection });
    expect(RECORD_KINDS.universe.merge).toHaveBeenCalledTimes(1);
    expect(RECORD_KINDS.mediaCollection.merge).not.toHaveBeenCalled();
  });

  it('skips the collection when its ownership lookup fails and still applies the parent', async () => {
    RECORD_KINDS.mediaCollection.load.mockRejectedValue(new Error('storage unavailable'));
    await authenticatedPush({ linkedCollection: collection });
    expect(RECORD_KINDS.universe.merge).toHaveBeenCalledTimes(1);
    expect(RECORD_KINDS.mediaCollection.merge).not.toHaveBeenCalled();
  });
});

describe('applyIncomingPush catalog bundle binding', () => {
  const ingredient = (id) => ({ id, type: 'character', name: id });
  const ref = (ingredientId, refId = 'u1', refKind = 'universe') => ({ ingredientId, refId, refKind });
  const foreign = ref('cat-foreign');
  const owned = ref('cat-owned');
  const fresh = ref('cat-new');

  it('merges only bound refs and ingredients that are new or already owned by the parent', async () => {
    vi.mocked(getLocalIngredientRefOwnership).mockResolvedValue({
      existing: new Set([foreign.ingredientId, owned.ingredientId]), linked: new Set([owned.ingredientId]),
    });
    await authenticatedPush({
      catalogBundle: {
        ingredients: [foreign, owned, fresh, ref('cat-unreferenced')].map(({ ingredientId }) => ingredient(ingredientId)),
        refs: [foreign, owned, fresh, ref('cat-other', 'u-other'), ref('cat-other-kind', 'u1', 'series')],
      },
    });
    expect(getLocalIngredientRefOwnership).toHaveBeenCalledWith(['cat-foreign', 'cat-owned', 'cat-new'], 'universe', 'u1');
    expect(applyRemoteChanges).toHaveBeenCalledExactlyOnceWith({
      ingredients: [ingredient('cat-owned'), ingredient('cat-new')],
      refs: [owned, fresh],
      portosMeta,
    });
  });

  it('skips a foreign ingredient ref even when it arrives without the ingredient row', async () => {
    vi.mocked(getLocalIngredientRefOwnership).mockResolvedValue({
      existing: new Set([foreign.ingredientId]), linked: new Set(),
    });
    await authenticatedPush({ catalogBundle: { ingredients: [], refs: [foreign] } });
    expect(applyRemoteChanges).not.toHaveBeenCalled();
  });

  it('skips a bundle with no ref to the pushed record', async () => {
    await authenticatedPush({ catalogBundle: { ingredients: [ingredient('cat-other')], refs: [ref('cat-other', 'u-other')] } });
    expect(getLocalIngredientRefOwnership).not.toHaveBeenCalled();
    expect(applyRemoteChanges).not.toHaveBeenCalled();
  });

  it('skips the bundle when ingredient ownership cannot be verified and still applies the parent', async () => {
    vi.mocked(getLocalIngredientRefOwnership).mockRejectedValue(new Error('storage unavailable'));
    await authenticatedPush({ catalogBundle: { ingredients: [ingredient('cat-new')], refs: [fresh] } });
    expect(RECORD_KINDS.universe.merge).toHaveBeenCalledTimes(1);
    expect(applyRemoteChanges).not.toHaveBeenCalled();
  });
});

describe('applyIncomingPush linked track binding', () => {
  const record = { id: 'mv-1', trackId: 'track-1' };
  const linkedTrack = { id: 'track-1', title: 'Example track' };
  const pushTrack = (track = linkedTrack) => authenticatedPush({ kind: 'musicVideoProject', record, linkedTrack: track });

  it('merges a matching track after a not-found result even when the Tracks category is off', async () => {
    RECORD_KINDS.track.load.mockRejectedValue(Object.assign(new Error('Track not found'), { status: 404 }));
    await pushTrack();
    expect(RECORD_KINDS.track.merge).toHaveBeenCalledExactlyOnceWith([linkedTrack], { source });
  });

  it('skips a track ID other than the one referenced by the pushed project', async () => {
    await pushTrack({ ...linkedTrack, id: 'track-other' });
    expect(RECORD_KINDS.track.load).not.toHaveBeenCalled();
    expect(RECORD_KINDS.track.merge).not.toHaveBeenCalled();
  });

  it('keeps an existing local track even when the local project already links it', async () => {
    RECORD_KINDS.musicVideoProject.load.mockResolvedValue(record);
    RECORD_KINDS.track.load.mockResolvedValue({ ...linkedTrack, title: 'Local title' });
    await pushTrack();
    expect(RECORD_KINDS.musicVideoProject.merge).toHaveBeenCalledTimes(1);
    expect(RECORD_KINDS.track.merge).not.toHaveBeenCalled();
  });

  it('marks the track pending when its lookup fails and still applies the project', async () => {
    RECORD_KINDS.track.load.mockRejectedValue(new Error('storage unavailable'));
    await expect(pushTrack()).resolves.toMatchObject({ trackSyncPending: true });
    expect(RECORD_KINDS.musicVideoProject.merge).toHaveBeenCalledTimes(1);
    expect(RECORD_KINDS.track.merge).not.toHaveBeenCalled();
  });
});
