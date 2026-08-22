import { describe, it, expect } from 'vitest';
import {
  FEDERATED_MEDIA_KINDS,
  FEDERATED_MEDIA_STATE_HELP,
  federatedMediaModelKey,
  federatedMediaModelsForPeer,
  peerMediaProviderConfig,
  peerModelAcceptsInput,
  peerModelRequiresInput,
  resolvePeerMediaReadiness,
  summarizePeerMediaQueue,
} from './federatedMediaReadiness.js';

const NOW = Date.parse('2026-08-20T12:00:00.000Z');
const iso = (offsetMs) => new Date(NOW + offsetMs).toISOString();

const peer = (overrides = {}) => ({
  id: 'peer-1',
  name: 'render-box',
  status: 'online',
  mediaProvider: { enabled: true, audioModels: [{ engine: 'minimax', modelId: 'music-3' }] },
  mediaProviderStatus: {
    checkedAt: iso(-1000),
    state: 'ready',
    reason: null,
    freshUntil: iso(60_000),
    snapshot: {
      queue: { running: 1, queued: 0, totalActive: 1, maxQueuedJobs: 4, accepting: true },
      capabilities: [{ kind: 'audio', engine: 'minimax', modelId: 'music-3', ready: true }],
    },
  },
  ...overrides,
});

describe('resolvePeerMediaReadiness', () => {
  it('reports a fresh ready provider with its queue and capabilities', () => {
    const readiness = resolvePeerMediaReadiness(peer(), { now: NOW });
    expect(readiness).toMatchObject({ configured: true, state: 'ready', label: 'ready', tone: 'success', help: null });
    expect(readiness.queue.maxQueuedJobs).toBe(4);
    expect(readiness.capabilities).toHaveLength(1);
    expect(readiness.kinds).toEqual(['audio']);
    expect(readiness.modelCount).toBe(1);
  });

  // The load-bearing case: the probe concluded `ready`, then the snapshot
  // expired while the record sat on disk. The server would refuse to submit
  // against it, so the UI must not keep advertising it as available.
  it('downgrades an expired ready snapshot to stale', () => {
    const readiness = resolvePeerMediaReadiness(peer(), { now: NOW + 61_000 });
    expect(readiness.state).toBe('stale');
    expect(readiness.label).toBe('stale');
    expect(readiness.tone).toBe('warning');
    expect(readiness.help).toBe(FEDERATED_MEDIA_STATE_HELP.stale);
  });

  it('keeps a snapshot fresh right up to its expiry instant', () => {
    expect(resolvePeerMediaReadiness(peer(), { now: NOW + 60_000 }).state).toBe('ready');
  });

  // Date.parse returns NaN for a missing or malformed value. Reading that as
  // "not expired" is the fail-OPEN version of the same bug: a ready snapshot
  // with no verifiable window is not a ready snapshot.
  it.each([undefined, null, '', 'not-a-date'])(
    'treats a ready snapshot whose freshUntil is %p as stale',
    (freshUntil) => {
      const broken = peer({
        mediaProviderStatus: { ...peer().mediaProviderStatus, freshUntil },
      });
      expect(resolvePeerMediaReadiness(broken, { now: NOW }).state).toBe('stale');
    },
  );

  // assertFederatedMediaProviderSelection refuses a probe with no snapshot, so a
  // ready state with nothing behind it must not be advertised as usable.
  it.each([undefined, null, 'nope', []])(
    'treats a ready status whose snapshot is %p as invalid',
    (snapshot) => {
      const broken = peer({ mediaProviderStatus: { ...peer().mediaProviderStatus, snapshot } });
      const readiness = resolvePeerMediaReadiness(broken, { now: NOW });
      expect(readiness.state).toBe('invalid');
      expect(readiness.help).toBe(FEDERATED_MEDIA_STATE_HELP.invalid);
    },
  );

  // Expiry is checked before the snapshot shape: an expired record's problem is
  // its age, and "re-probe" is the remedy that actually fixes it.
  it('prefers stale over invalid when an expired status also lacks a snapshot', () => {
    const broken = peer({
      mediaProviderStatus: { ...peer().mediaProviderStatus, snapshot: null, freshUntil: iso(-1000) },
    });
    expect(resolvePeerMediaReadiness(broken, { now: NOW }).state).toBe('stale');
  });

  it('treats a busy snapshot with no verifiable window as stale', () => {
    const broken = peer({
      mediaProviderStatus: { ...peer().mediaProviderStatus, state: 'busy', freshUntil: null },
    });
    expect(resolvePeerMediaReadiness(broken, { now: NOW }).state).toBe('stale');
  });

  it('leaves a state with no freshness window alone', () => {
    const unreachable = peer({
      mediaProviderStatus: { checkedAt: iso(-1000), state: 'unreachable', reason: 'timeout', freshUntil: null, snapshot: null },
    });
    const readiness = resolvePeerMediaReadiness(unreachable, { now: NOW + 10_000_000 });
    expect(readiness.state).toBe('unreachable');
    expect(readiness.help).toBe(FEDERATED_MEDIA_STATE_HELP.unreachable);
    expect(readiness.queue).toBeNull();
    expect(readiness.capabilities).toEqual([]);
  });

  it('reads a peer with no provider config as off, not as broken', () => {
    const readiness = resolvePeerMediaReadiness({ id: 'p', status: 'online' }, { now: NOW });
    expect(readiness).toMatchObject({ configured: false, state: null, label: 'off', tone: 'note', help: null });
    expect(readiness.modelCount).toBe(0);
  });

  // An opted-in peer that has not been probed yet is not the same claim as a
  // peer with nothing to offer.
  it('reads an unprobed opted-in peer as checking', () => {
    const readiness = resolvePeerMediaReadiness(peer({ mediaProviderStatus: undefined }), { now: NOW });
    expect(readiness.label).toBe('checking');
    expect(readiness.state).toBeNull();
  });

  // The server rejects a submission to a disabled peer with
  // MEDIA_PROVIDER_PEER_DISABLED before it looks at capacity at all, so a
  // healthy cached snapshot must not keep advertising it as ready.
  it('reports a disabled peer connection as disabled despite a ready snapshot', () => {
    const readiness = resolvePeerMediaReadiness(peer({ enabled: false }), { now: NOW });
    expect(readiness.label).toBe('peer disabled');
    expect(readiness.tone).toBe('warning');
    expect(readiness.help).toMatch(/switched off/i);
  });

  it('treats a peer with no explicit enabled flag as enabled', () => {
    expect(resolvePeerMediaReadiness(peer(), { now: NOW }).label).toBe('ready');
  });

  it('reports an offline peer as offline rather than as a provider fault', () => {
    const readiness = resolvePeerMediaReadiness(peer({ status: 'offline' }), { now: NOW });
    expect(readiness.label).toBe('peer offline');
    expect(readiness.tone).toBe('warning');
  });

  it('surfaces the remedy for a disabled provider', () => {
    const disabled = peer({
      mediaProviderStatus: { checkedAt: iso(-1), state: 'disabled', reason: 'MEDIA_PROVIDER_DISABLED', freshUntil: null, snapshot: null },
    });
    expect(resolvePeerMediaReadiness(disabled, { now: NOW }).help).toBe(FEDERATED_MEDIA_STATE_HELP.disabled);
  });

  it('lists only the kinds that actually have an allowlisted model', () => {
    const multi = peer({
      mediaProvider: {
        enabled: true,
        audioModels: [{ engine: 'minimax', modelId: 'music-3' }],
        imageModels: [],
        videoModels: [{ engine: 'local', modelId: 'ltx2' }],
      },
    });
    const readiness = resolvePeerMediaReadiness(multi, { now: NOW });
    expect(readiness.kinds).toEqual(['audio', 'video']);
    expect(readiness.modelCount).toBe(2);
  });

  it('tolerates a malformed stored config without throwing', () => {
    const junk = resolvePeerMediaReadiness(
      { id: 'p', status: 'online', mediaProvider: 'nope', mediaProviderStatus: [] },
      { now: NOW },
    );
    expect(junk.configured).toBe(false);
    expect(junk.capabilities).toEqual([]);
  });
});

describe('peerMediaProviderConfig', () => {
  it('always returns a list for every known kind', () => {
    const config = peerMediaProviderConfig({ mediaProvider: { enabled: true } });
    for (const { kind } of FEDERATED_MEDIA_KINDS) expect(config.models[kind]).toEqual([]);
  });
});

describe('federatedMediaModelKey', () => {
  // Matches the server's own NUL-separated key. A printable separator would let
  // an engine name containing it collide with a different engine/model pair.
  it('separates engine from model with NUL', () => {
    expect(federatedMediaModelKey({ engine: 'local', modelId: 'ltx2' })).toBe('local\u0000ltx2');
    expect(federatedMediaModelKey({ engine: 'a', modelId: 'b-c' }))
      .not.toBe(federatedMediaModelKey({ engine: 'a-b', modelId: 'c' }));
  });
});

describe('resolvePeerMediaReadiness usable', () => {
  const freshReady = (overrides = {}) => ({
    id: 'peer-1',
    enabled: true,
    status: 'online',
    mediaProvider: { enabled: true, audioModels: [{ engine: 'e', modelId: 'm' }] },
    mediaProviderStatus: {
      state: 'ready',
      checkedAt: iso(-1_000),
      freshUntil: iso(60_000),
      snapshot: { queue: { running: 0, queued: 0, totalActive: 0, maxQueuedJobs: 4, accepting: true }, capabilities: [] },
    },
    ...overrides,
  });

  it('is true only for an enabled, online, opted-in peer with a fresh ready snapshot', () => {
    expect(resolvePeerMediaReadiness(freshReady(), { now: NOW }).usable).toBe(true);
  });

  // `state` is the provider's verdict on its own surface and says nothing about
  // reachability, so a caller gating on it alone would enable work against a
  // peer that is switched off or gone.
  it('is false for a peer that is switched off, offline, or not opted in, however fresh its snapshot', () => {
    for (const overrides of [
      { enabled: false },
      { status: 'offline' },
      { mediaProvider: { enabled: false, audioModels: [] } },
    ]) {
      const readiness = resolvePeerMediaReadiness(freshReady(overrides), { now: NOW });
      expect(readiness.state).toBe('ready');
      expect(readiness.usable).toBe(false);
    }
  });

  it('is false once the capacity window has expired', () => {
    const stale = freshReady();
    stale.mediaProviderStatus.freshUntil = iso(-1_000);
    expect(resolvePeerMediaReadiness(stale, { now: NOW }).usable).toBe(false);
  });
});

describe('summarizePeerMediaQueue', () => {
  const queue = (overrides = {}) => ({
    totalActive: 2, providerActive: 1, queued: 1, running: 1, maxQueuedJobs: 4, accepting: true, ...overrides,
  });

  it('renders shared slots, drain rate, per-kind load, and the federated share', () => {
    expect(summarizePeerMediaQueue(queue({
      concurrency: 2,
      byKind: { audio: { running: 1, queued: 1 }, image: { running: 0, queued: 1 } },
    }))).toEqual([
      '2/4 shared slots active',
      'runs 2 at a time',
      'audio 1 running, 1 queued',
      'image 1 queued',
      'federated 1 running, 1 queued',
    ]);
  });

  // byKind is machine-wide while running/queued are the federated share, so an
  // unlabelled "0 running" beside "audio 1 running" would claim the peer is
  // both busy and idle.
  it('labels the federated share so it cannot be read as the whole machine', () => {
    expect(summarizePeerMediaQueue({
      totalActive: 1, providerActive: 0, queued: 0, running: 0, maxQueuedJobs: 2, accepting: true,
      byKind: { audio: { running: 1, queued: 0 } },
    })).toEqual(['1/2 shared slots active', 'audio 1 running']);
  });

  // An older provider sends neither new field. Rendering the absence as a zero
  // would claim idle lanes the peer never reported on.
  it('drops the segments an older provider never sent instead of showing zeroes', () => {
    expect(summarizePeerMediaQueue(queue())).toEqual([
      '2/4 shared slots active',
      'federated 1 running, 1 queued',
    ]);
  });

  it('drops a concurrency that claims no capacity', () => {
    expect(summarizePeerMediaQueue(queue({ concurrency: 0 })))
      .not.toContain('runs 0 at a time');
  });

  // The provider omits an idle kind, but a build that sent one must not add a
  // segment saying nothing.
  // Asserted as an exact array: `toContain` on an array is element identity,
  // not substring, so `.not.toContain('audio')` would pass against a segment
  // reading 'audio 0 running' and verify nothing.
  it('omits a kind reporting no work', () => {
    expect(summarizePeerMediaQueue(queue({
      byKind: { audio: { running: 0, queued: 0 }, image: { running: 2, queued: 0 } },
    }))).toEqual([
      '2/4 shared slots active',
      'image 2 running',
      'federated 1 running, 1 queued',
    ]);
  });

  it('reports nothing at all when the queue block is missing', () => {
    for (const bad of [null, undefined, 'busy']) expect(summarizePeerMediaQueue(bad)).toEqual([]);
  });
});

describe('federatedMediaModelsForPeer', () => {
  const withCapabilities = (capabilities, allowlist) => peer({
    mediaProvider: { enabled: true, audioModels: allowlist },
    mediaProviderStatus: { checkedAt: iso(-1000), freshUntil: iso(60_000), state: 'ready', snapshot: { capabilities } },
  });
  const capability = (overrides) => ({
    kind: 'audio', engine: 'minimax', engineName: 'MiniMax', modelId: 'music-3',
    modelName: 'MiniMax Music 3', ready: true, unavailableReason: null, ...overrides,
  });

  // The allowlist is what the SERVER checks on submit; the capabilities are the
  // only thing carrying readiness. Either list alone would offer a model that
  // gets refused, or hide why a listed one cannot run.
  it('returns only the models present in both the allowlist and the capabilities', () => {
    const result = federatedMediaModelsForPeer(withCapabilities(
      [capability(), capability({ modelId: 'other', modelName: 'Other' })],
      [{ engine: 'minimax', modelId: 'music-3' }],
    ), 'audio');
    expect(result.map((entry) => entry.modelId)).toEqual(['music-3']);
  });

  // Same model id under a different engine is a different entry on the server's
  // allowlist, so matching on the id alone would offer work the peer refuses.
  it('keys the match on the engine/model PAIR, not the model id', () => {
    const result = federatedMediaModelsForPeer(withCapabilities(
      [capability({ engine: 'other-engine' })],
      [{ engine: 'minimax', modelId: 'music-3' }],
    ), 'audio');
    expect(result).toEqual([]);
  });

  it('keeps an unadvertised kind, an unknown kind and a missing snapshot all empty', () => {
    const allowed = [{ engine: 'minimax', modelId: 'music-3' }];
    expect(federatedMediaModelsForPeer(withCapabilities([capability()], allowed), 'image')).toEqual([]);
    expect(federatedMediaModelsForPeer(withCapabilities([capability()], allowed), 'hologram')).toEqual([]);
    expect(federatedMediaModelsForPeer(withCapabilities(undefined, allowed), 'audio')).toEqual([]);
    expect(federatedMediaModelsForPeer(null, 'audio')).toEqual([]);
  });

  // Callers memoize on this result; a fresh [] per call would defeat that memo
  // for exactly the peers with nothing to recompute.
  it('returns one shared array identity when there is nothing to offer', () => {
    const empty = federatedMediaModelsForPeer(null, 'audio');
    expect(federatedMediaModelsForPeer(withCapabilities([], []), 'audio')).toBe(empty);
  });
});

// ADR docs/decisions/2026-08-22-federated-media-input-assets.md rule 1. The
// fail-closed reading is the whole point: a provider built before that ADR
// advertises no `inputAssets` block AND rejects the fields, so an absent block
// read as "unrestricted" would offer a render the peer answers with a 400.
describe('peerModelAcceptsInput / peerModelRequiresInput', () => {
  const withInput = (inputAssets) => ({ modelName: 'Example', inputAssets });

  it('accepts only the roles the capability actually advertises', () => {
    const model = withInput({ roles: ['initImage'], required: false, maxCount: 8 });
    expect(peerModelAcceptsInput(model, 'initImage')).toBe(true);
    expect(peerModelAcceptsInput(model, 'referenceImages')).toBe(false);
  });

  it.each([
    ['an absent block (a provider predating the ADR)', undefined],
    ['an explicit null', null],
    ['a block with no roles array', { required: false }],
    ['a malformed roles value', { roles: 'initImage' }],
  ])('reads %s as accepting nothing', (_name, inputAssets) => {
    expect(peerModelAcceptsInput(withInput(inputAssets), 'initImage')).toBe(false);
    expect(peerModelRequiresInput(withInput(inputAssets))).toBe(false);
  });

  it('reports a model that cannot render without conditioning', () => {
    expect(peerModelRequiresInput(withInput({ roles: ['initImage'], required: true }))).toBe(true);
    expect(peerModelRequiresInput(withInput({ roles: ['initImage'], required: false }))).toBe(false);
  });

  it('tolerates a null capability rather than throwing on an unpicked model', () => {
    expect(peerModelAcceptsInput(null, 'initImage')).toBe(false);
    expect(peerModelRequiresInput(null)).toBe(false);
  });
});
