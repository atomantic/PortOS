import { describe, it, expect, beforeEach, vi } from 'vitest';

// `instances.js` pulls in the socket relay / Tailscale graph; the only things
// this module and `peerSyncShared` need from it are `getPeers` and the
// UNKNOWN_INSTANCE_ID sentinel. Mocking it lets the REAL `findPeerById` /
// `peerAllowsOutbound` / `peerHasCategory` run — which is the point: the test
// asserts pull agrees with push because both use those same predicates.
const peers = [];
vi.mock('../instances.js', async () => ({
  // Real `resolveEffectiveCategories` + shipped defaults, for the same reason:
  // the category-scoped pull decision must agree with what the sync loop and
  // the settings UI resolve for that peer.
  ...(await vi.importActual('../instances.js')),
  getPeers: async () => peers,
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

    it('reads the first value when the header arrived twice', () => {
      expect(readCallerInstanceId({ headers: { [PEER_INSTANCE_ID_HEADER]: [PEER_A, 'other'] } })).toBe(PEER_A);
      expect(readCallerInstanceId({ headers: { [PEER_INSTANCE_ID_HEADER]: `${PEER_A}, other` } })).toBe(PEER_A);
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
      // `severity: 'warning'` is what keeps asyncHandler from re-logging its
      // generic `❌ Route error` on every poll of a peer that will be refused
      // forever; the throttled 🔒 line below is this path's log of record.
      await expect(authorizePeerPull(req(PEER_A), { recordKind: 'series' }))
        .rejects.toMatchObject({ status: 403, code: 'PEER_PULL_FORBIDDEN', severity: 'warning' });
      await expect(authorizePeerPull(req(null), { recordKind: 'universe' }))
        .rejects.toMatchObject({ status: 403 });
      // Strict mode rejects instead of logging the compatibility ⚠️ — but it is
      // not silent: it logs the same throttled 🔒 refusal `alwaysEnforce` does,
      // once per caller. Since the 403 no longer self-logs, this is the only
      // record of a peer being cut off.
      const lines = console.warn.mock.calls.map((c) => c[0]);
      expect(lines).toHaveLength(2);
      for (const line of lines) expect(line).toContain('🔒');
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

  // #5663 — the snapshot transport's unit of consent is a whole sync CATEGORY,
  // not a record kind, so it resolves the peer's category map directly.
  describe('syncCategory scope', () => {
    it('allows a category the user ticked for this peer', async () => {
      setPeers(universePeer());
      const decision = await decidePeerPull({ callerId: PEER_A, syncCategory: 'universe' });
      expect(decision.allowed).toBe(true);
    });

    it('denies a category the user did NOT tick, even for an outbound-allowed peer', async () => {
      setPeers(universePeer());
      const decision = await decidePeerPull({ callerId: PEER_A, syncCategory: 'digitalTwin' });
      expect(decision).toMatchObject({ allowed: false, reason: PULL_DENY_CATEGORY });
    });

    it('allows anything for a full-sync ("mirror everything") peer', async () => {
      setPeers(universePeer({ fullSync: true, syncCategories: {} }));
      expect((await decidePeerPull({ callerId: PEER_A, syncCategory: 'digitalTwin' })).allowed).toBe(true);
    });

    it('keeps a default-ON category flowing when the master sync switch is off', async () => {
      // `usage` is retained by resolveEffectiveCategories' master-switch mask;
      // gating on peerAllowsOutbound instead would refuse it outright.
      setPeers(universePeer({ syncEnabled: false }));
      expect((await decidePeerPull({ callerId: PEER_A, syncCategory: 'usage' })).allowed).toBe(true);
      expect((await decidePeerPull({ callerId: PEER_A, syncCategory: 'universe' })).allowed).toBe(false);
    });

    it('denies a peer that only announced itself (inbound-only, never approved here)', async () => {
      setPeers(universePeer({ directions: ['inbound'] }));
      // Reason parity with the record routes: "we don't share with you at all"
      // must not read as "we don't share THIS with you".
      expect(await decidePeerPull({ callerId: PEER_A, syncCategory: 'universe' }))
        .toMatchObject({ allowed: false, reason: PULL_DENY_OUTBOUND });
    });

    it('denies a disabled peer as outbound-disallowed, not category-disabled', async () => {
      setPeers(universePeer({ enabled: false }));
      expect(await decidePeerPull({ callerId: PEER_A, syncCategory: 'universe' }))
        .toMatchObject({ allowed: false, reason: PULL_DENY_OUTBOUND });
    });

    it('lets the master switch beat a stale fullSync flag', async () => {
      // `{ fullSync: true, syncEnabled: false }` is reachable (set full mirror,
      // then flip the switch off) and contradictory — every push is already
      // refused for it, so a pull must not hand it the whole install.
      setPeers(universePeer({ fullSync: true, syncEnabled: false }));
      expect((await decidePeerPull({ callerId: PEER_A, syncCategory: 'digitalTwin' })).allowed).toBe(false);
      // The default-ON category still survives the switch, as everywhere else.
      expect((await decidePeerPull({ callerId: PEER_A, syncCategory: 'usage' })).allowed).toBe(true);
    });
  });

  // #5663 — the PII snapshot categories opt out of the warn-first ramp: root
  // AGENTS.md forbids those records on the federation layer at all, so an
  // unidentified caller must never be served one regardless of the setting.
  describe('alwaysEnforce', () => {
    it('403s a denied pull with strictPullAuthorization off', async () => {
      settings = { federation: { strictPullAuthorization: false } };
      await expect(authorizePeerPull(req(null), { route: 'sync digitalTwin', alwaysEnforce: true }))
        .rejects.toMatchObject({ status: 403, code: 'PEER_PULL_FORBIDDEN' });
    });

    it('still allows a configured, outbound-allowed peer', async () => {
      setPeers(universePeer());
      const decision = await authorizePeerPull(req(PEER_A), { route: 'sync digitalTwin', alwaysEnforce: true });
      expect(decision.allowed).toBe(true);
      expect(console.warn).not.toHaveBeenCalled();
    });

    it('logs the refusal once per caller per boot', async () => {
      const opts = { route: 'sync digitalTwin', alwaysEnforce: true };
      await expect(authorizePeerPull(req(null), opts)).rejects.toThrow();
      await expect(authorizePeerPull(req(null), opts)).rejects.toThrow();
      expect(console.warn).toHaveBeenCalledTimes(1);
      expect(console.warn.mock.calls[0][0]).toContain('🔒');
    });

    it('does not consume the served-anyway throttle slot for the same caller', async () => {
      // Distinct throttle keys: a caller refused a PII pull must still produce
      // the one compatibility ⚠️ when it pulls a creative-work category.
      await expect(authorizePeerPull(req(null), { route: 'sync digitalTwin', alwaysEnforce: true })).rejects.toThrow();
      await authorizePeerPull(req(null), { route: 'sync universe' });
      expect(console.warn).toHaveBeenCalledTimes(2);
    });
  });
});
