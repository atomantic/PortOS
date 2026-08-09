import { describe, it, expect, beforeEach, vi } from 'vitest';

// `instances.js` pulls in the socket relay / Tailscale graph; the only things
// this module and `peerSyncShared` need from it are `getPeers` and the
// UNKNOWN_INSTANCE_ID sentinel. Mocking it lets the REAL `findPeerById` /
// `peerAllowsOutbound` / `peerHasCategory` run — which is the point: the test
// asserts pull agrees with push because both use those same predicates.
const peers = [];
vi.mock('../instances.js', () => ({
  getPeers: async () => peers,
  UNKNOWN_INSTANCE_ID: 'unknown',
}));

let settings = {};
vi.mock('../settings.js', () => ({
  getSettings: async () => settings,
}));

const {
  authorizePeerPull,
  decidePeerPull,
  readCallerInstanceId,
  __resetPullWarnThrottleForTests,
  PEER_INSTANCE_ID_HEADER,
  PULL_DENY_UNIDENTIFIED,
  PULL_DENY_UNKNOWN_PEER,
  PULL_DENY_OUTBOUND,
  PULL_DENY_CATEGORY,
} = await import('./peerPullAuthorization.js');
const { peerAllowsOutbound, peerHasCategory } = await import('./peerSyncShared.js');

const PEER_A = 'peer-a-instance-id';
const req = (instanceId) => ({ headers: instanceId ? { [PEER_INSTANCE_ID_HEADER]: instanceId } : {} });

const setPeers = (...next) => {
  peers.length = 0;
  peers.push(...next);
};

// An obviously-fake peer record; `syncCategories.universe` mirrors what the
// push path checks for a `universe` record kind.
const universePeer = (overrides = {}) => ({
  instanceId: PEER_A,
  name: 'Example Peer',
  enabled: true,
  syncEnabled: true,
  directions: ['outbound', 'inbound'],
  syncCategories: { universe: true },
  ...overrides,
});

describe('peerPullAuthorization', () => {
  beforeEach(() => {
    settings = {};
    setPeers();
    __resetPullWarnThrottleForTests();
    vi.restoreAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  describe('readCallerInstanceId', () => {
    it('collapses absent, blank, and sentinel ids to null', () => {
      expect(readCallerInstanceId({ headers: {} })).toBeNull();
      expect(readCallerInstanceId({ headers: { [PEER_INSTANCE_ID_HEADER]: '   ' } })).toBeNull();
      expect(readCallerInstanceId({ headers: { [PEER_INSTANCE_ID_HEADER]: 'unknown' } })).toBeNull();
      expect(readCallerInstanceId({ headers: { [PEER_INSTANCE_ID_HEADER]: ` ${PEER_A} ` } })).toBe(PEER_A);
    });
  });

  describe('decidePeerPull', () => {
    it('allows a peer whose sharing config covers the record kind', async () => {
      setPeers(universePeer());
      const decision = await decidePeerPull({ callerId: PEER_A, recordKind: 'universe' });
      expect(decision.allowed).toBe(true);
      expect(decision.reason).toBeNull();
    });

    it('denies an unidentified caller and an unregistered instance id', async () => {
      expect((await decidePeerPull({ callerId: null, recordKind: 'universe' })).reason).toBe(PULL_DENY_UNIDENTIFIED);
      expect((await decidePeerPull({ callerId: 'not-registered', recordKind: 'universe' })).reason).toBe(PULL_DENY_UNKNOWN_PEER);
    });

    it('denies a peer with sync globally disabled or set to inbound-only', async () => {
      setPeers(universePeer({ syncEnabled: false }));
      expect((await decidePeerPull({ callerId: PEER_A, recordKind: 'universe' })).reason).toBe(PULL_DENY_OUTBOUND);
      setPeers(universePeer({ directions: ['inbound'] }));
      expect((await decidePeerPull({ callerId: PEER_A, recordKind: 'universe' })).reason).toBe(PULL_DENY_OUTBOUND);
      setPeers(universePeer({ enabled: false }));
      expect((await decidePeerPull({ callerId: PEER_A, recordKind: 'universe' })).reason).toBe(PULL_DENY_OUTBOUND);
    });

    it('denies a record kind whose category the peer has turned off', async () => {
      setPeers(universePeer());
      const decision = await decidePeerPull({ callerId: PEER_A, recordKind: 'series' });
      expect(decision.reason).toBe(PULL_DENY_CATEGORY);
    });

    it('allows a full-sync peer every subscribable kind', async () => {
      setPeers(universePeer({ syncCategories: {}, fullSync: true }));
      expect((await decidePeerPull({ callerId: PEER_A, recordKind: 'series' })).allowed).toBe(true);
    });

    it('gates a kind-less manifest pull on outbound only, not on categories', async () => {
      setPeers(universePeer({ syncCategories: {} }));
      expect((await decidePeerPull({ callerId: PEER_A })).allowed).toBe(true);
      setPeers(universePeer({ syncCategories: {}, syncEnabled: false }));
      expect((await decidePeerPull({ callerId: PEER_A })).allowed).toBe(false);
    });

    // The acceptance criterion: push and pull decisions come from the SAME
    // predicates, so they can never diverge for a given peer/kind pair.
    it('agrees with the push-path gate for every peer/kind combination', async () => {
      const candidates = [
        universePeer(),
        universePeer({ syncEnabled: false }),
        universePeer({ enabled: false }),
        universePeer({ directions: ['inbound'] }),
        universePeer({ syncCategories: { pipeline: true } }),
        universePeer({ syncCategories: {}, fullSync: true }),
      ];
      for (const peer of candidates) {
        for (const kind of ['universe', 'series', 'mediaCollection']) {
          setPeers(peer);
          const pull = await decidePeerPull({ callerId: PEER_A, recordKind: kind });
          // Exactly the two checks pushRecord runs before sending (peerSyncPush.js).
          const push = peerAllowsOutbound(peer) && peerHasCategory(peer, kind);
          expect(pull.allowed).toBe(push);
        }
      }
    });
  });

  describe('authorizePeerPull compatibility', () => {
    it('serves an unidentified pull when strict mode is off (older peer keeps syncing)', async () => {
      const decision = await authorizePeerPull(req(null), { recordKind: 'universe', route: 'record universe' });
      expect(decision.allowed).toBe(false);
      expect(console.warn).toHaveBeenCalledTimes(1);
    });

    it('warns at most once per caller per boot', async () => {
      await authorizePeerPull(req(null), { recordKind: 'universe' });
      await authorizePeerPull(req(null), { recordKind: 'universe' });
      await authorizePeerPull(req(null), { recordKind: 'series' });
      expect(console.warn).toHaveBeenCalledTimes(1);

      setPeers(universePeer());
      await authorizePeerPull(req(PEER_A), { recordKind: 'series' });
      await authorizePeerPull(req(PEER_A), { recordKind: 'series' });
      expect(console.warn).toHaveBeenCalledTimes(2);
    });

    it('does not warn when the pull is allowed', async () => {
      setPeers(universePeer());
      const decision = await authorizePeerPull(req(PEER_A), { recordKind: 'universe' });
      expect(decision.allowed).toBe(true);
      expect(console.warn).not.toHaveBeenCalled();
    });

    it('403s a denied pull once strictPullAuthorization is on', async () => {
      settings = { federation: { strictPullAuthorization: true } };
      setPeers(universePeer());
      await expect(authorizePeerPull(req(PEER_A), { recordKind: 'series' }))
        .rejects.toMatchObject({ status: 403, code: 'PEER_PULL_FORBIDDEN' });
      await expect(authorizePeerPull(req(null), { recordKind: 'universe' }))
        .rejects.toMatchObject({ status: 403 });
      // Strict mode rejects instead of logging the compatibility warning.
      expect(console.warn).not.toHaveBeenCalled();
    });

    it('still allows an authorized pull under strict mode', async () => {
      settings = { federation: { strictPullAuthorization: true } };
      setPeers(universePeer());
      expect((await authorizePeerPull(req(PEER_A), { recordKind: 'universe' })).allowed).toBe(true);
    });

    it('treats an unreadable settings file as strict-off (warn, do not break sync)', async () => {
      settings = null;
      await expect(authorizePeerPull(req(null), { recordKind: 'universe' })).resolves.toBeDefined();
    });
  });
});
