import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Source of instances.js, for source-level assertions that don't execute the
// module (avoids the vitest worker-teardown console-RPC flake that running the
// identity-creation path under resetModules + fake timers can trigger).
const INSTANCES_SRC = readFileSync(fileURLToPath(new URL('./instances.js', import.meta.url)), 'utf8');

// This suite tests the real instances.js implementation — cancel the global
// vitest.setup.js mock so the real getPeers (and all other exports) are used.
// The global mock stubs getPeers → [] to prevent live peer fan-out in tests
// that create records; here we instead mock instances.js's own dependencies
// (fileUtils, asyncMutex, etc.) to make the real code deterministic.
vi.unmock('./instances.js');

// Mock dependencies before importing the module
vi.mock('fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('../lib/fileUtils.js', () => ({
tryReadFile: vi.fn().mockResolvedValue(null),
  dataPath: (name) => `/mock/data/${name}`,
  readJSONFile: vi.fn(),
  ensureDir: vi.fn().mockResolvedValue(undefined),
  atomicWrite: vi.fn().mockResolvedValue(undefined),
  PATHS: { data: '/mock/data' }
}));

vi.mock('../lib/asyncMutex.js', () => ({
  createMutex: () => (fn) => fn()
}));

vi.mock('./instanceEvents.js', () => ({
  instanceEvents: {
    emit: vi.fn()
  }
}));

vi.mock('./peerSocketRelay.js', () => ({
  connectToPeer: vi.fn(),
  disconnectFromPeer: vi.fn()
}));

vi.mock('../lib/ports.js', () => ({
  DEFAULT_PEER_PORT: 5555
}));

vi.mock('../lib/tailscale.js', () => ({
  getTailscaleStatus: vi.fn()
}));

// fetch is stubbed per-test in beforeEach and restored in afterEach

import { readJSONFile, atomicWrite } from '../lib/fileUtils.js';
import { getTailscaleStatus } from '../lib/tailscale.js';
import { instanceEvents } from './instanceEvents.js';
import { connectToPeer, disconnectFromPeer } from './peerSocketRelay.js';
import {
  ensureSelf,
  getSelf,
  getInstanceId,
  updateSelf,
  getPeers,
  addPeer,
  removePeer,
  updatePeer,
  probePeer,
  probeAllPeers,
  queryPeer,
  handleAnnounce,
  redactPeerForWire,
  sanitizePeerForClient,
  applyReciprocalSync,
  requestReciprocalSync,
  enqueueReciprocalSync,
  DEFAULT_SYNC_CATEGORIES,
  startPolling,
  stopPolling
} from './instances.js';

describe('instances.js', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn());
    readJSONFile.mockResolvedValue({ self: null, peers: [] });
    getTailscaleStatus.mockResolvedValue({ available: true, running: true, state: 'Running', reason: 'running' });
  });

  afterEach(() => {
    stopPolling();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // --- Self Identity ---

  describe('ensureSelf', () => {
    it('should create identity when none exists', async () => {
      readJSONFile.mockResolvedValue({ self: null, peers: [] });

      const self = await ensureSelf();

      expect(self).toEqual({
        instanceId: expect.any(String),
        name: expect.any(String)
      });
      expect(self.instanceId).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('should return existing identity without creating a new one', async () => {
      const existing = { instanceId: 'existing-id', name: 'my-host' };
      readJSONFile.mockResolvedValue({ self: existing, peers: [] });

      const self = await ensureSelf();

      expect(self).toEqual(existing);
    });
  });

  describe('getSelf', () => {
    it('should return self from data', async () => {
      const selfData = { instanceId: 'abc', name: 'host1' };
      readJSONFile.mockResolvedValue({ self: selfData, peers: [] });

      const result = await getSelf();

      expect(result).toEqual(selfData);
    });

    it('should return null when no self exists', async () => {
      readJSONFile.mockResolvedValue({ self: null, peers: [] });

      const result = await getSelf();

      expect(result).toBeNull();
    });
  });

  describe('getInstanceId', () => {
    it('should return "unknown" when no self exists', async () => {
      readJSONFile.mockResolvedValue({ self: null, peers: [] });

      const id = await getInstanceId();

      expect(id).toBe('unknown');
    });

    it('should return instanceId from self', async () => {
      readJSONFile.mockResolvedValue({
        self: { instanceId: 'test-id-123', name: 'host' },
        peers: []
      });

      const id = await getInstanceId();

      expect(id).toBe('test-id-123');
    });
  });

  // ensureInstanceId's runtime behavior is exercised transitively by the
  // agentLifecycle / cos / worktreeManager suites that call it. Here we assert
  // its structure at the source level — running the identity-creation path in
  // this suite (which uses resetModules + fake timers) can leave a console log
  // pending over the worker RPC at teardown and flake the whole run.
  describe('ensureInstanceId (#1563)', () => {
    it('is exported', () => {
      expect(INSTANCES_SRC).toMatch(/export async function ensureInstanceId\(\)/);
    });

    it('reads getInstanceId, guards the unknown sentinel, and falls back to ensureSelf on the cold path', () => {
      const start = INSTANCES_SRC.indexOf('export async function ensureInstanceId');
      const body = INSTANCES_SRC.slice(start, start + 600);
      const getIdx = body.indexOf('await getInstanceId()');
      const guardIdx = body.indexOf('=== UNKNOWN_INSTANCE_ID');
      const ensureIdx = body.indexOf('await ensureSelf()');
      expect(getIdx, 'must read getInstanceId()').toBeGreaterThan(-1);
      expect(guardIdx, 'must guard on the UNKNOWN_INSTANCE_ID sentinel').toBeGreaterThan(getIdx);
      expect(ensureIdx, 'must fall back to ensureSelf() on the sentinel').toBeGreaterThan(guardIdx);
    });
  });

  describe('updateSelf', () => {
    it('should update name when self exists', async () => {
      readJSONFile.mockResolvedValue({
        self: { instanceId: 'abc', name: 'old-name' },
        peers: []
      });

      const result = await updateSelf('new-name');

      expect(result).toEqual({ instanceId: 'abc', name: 'new-name' });
    });

    it('should return null when no self exists', async () => {
      readJSONFile.mockResolvedValue({ self: null, peers: [] });

      const result = await updateSelf('name');

      expect(result).toBeNull();
    });
  });

  // --- Peer CRUD ---

  describe('getPeers', () => {
    it('should return peers array', async () => {
      const peers = [{ id: '1', address: '10.0.0.1' }];
      readJSONFile.mockResolvedValue({ self: null, peers });

      const result = await getPeers();

      expect(result).toEqual(peers);
    });

    it('should return empty array when no peers', async () => {
      readJSONFile.mockResolvedValue({ self: null, peers: [] });

      const result = await getPeers();

      expect(result).toEqual([]);
    });
  });

  describe('addPeer', () => {
    it('should add a peer with correct defaults', async () => {
      readJSONFile.mockResolvedValue({ self: null, peers: [] });
      fetch.mockRejectedValue(new Error('not reachable'));

      const peer = await addPeer({ address: '10.0.0.2', name: 'remote-host' });

      expect(peer).toMatchObject({
        id: expect.any(String),
        address: '10.0.0.2',
        port: 5555,
        name: 'remote-host',
        instanceId: null,
        status: 'unknown',
        enabled: true,
        directions: ['outbound']
      });
      expect(peer.addedAt).toBeDefined();
      expect(instanceEvents.emit).toHaveBeenCalledWith('peers:updated', expect.any(Array));
    });

    it('should use address as name when name is not provided', async () => {
      readJSONFile.mockResolvedValue({ self: null, peers: [] });
      fetch.mockRejectedValue(new Error('not reachable'));

      const peer = await addPeer({ address: '10.0.0.3' });

      expect(peer.name).toBe('10.0.0.3');
    });

    it('should accept names like null/undefined/NaN as valid hostnames', async () => {
      readJSONFile.mockResolvedValue({ self: null, peers: [] });
      fetch.mockRejectedValue(new Error('not reachable'));

      const peer = await addPeer({ address: '10.0.0.4', name: 'null' });

      expect(peer.name).toBe('null');
    });

    it('should use custom port when specified', async () => {
      readJSONFile.mockResolvedValue({ self: null, peers: [] });
      fetch.mockRejectedValue(new Error('not reachable'));

      const peer = await addPeer({ address: '10.0.0.5', port: 8080 });

      expect(peer.port).toBe(8080);
    });

    it('should default hostManual to false when no host provided (allow auto-learn)', async () => {
      readJSONFile.mockResolvedValue({ self: null, peers: [] });
      fetch.mockRejectedValue(new Error('not reachable'));

      const peer = await addPeer({ address: '10.0.0.6' });

      expect(peer.host).toBeNull();
      expect(peer.hostManual).toBe(false);
    });

    it('should latch hostManual when host is provided at add time', async () => {
      readJSONFile.mockResolvedValue({ self: null, peers: [] });
      fetch.mockRejectedValue(new Error('not reachable'));

      const peer = await addPeer({ address: '10.0.0.7', host: 'machine.taile8179.ts.net' });

      expect(peer.host).toBe('machine.taile8179.ts.net');
      expect(peer.hostManual).toBe(true);
    });

    it('should default auth to null when no credential is provided', async () => {
      readJSONFile.mockResolvedValue({ self: null, peers: [] });
      fetch.mockRejectedValue(new Error('not reachable'));

      const peer = await addPeer({ address: '10.0.0.8' });

      expect(peer.auth).toBeNull();
    });

    it('should store a sanitized credential when provided', async () => {
      readJSONFile.mockResolvedValue({ self: null, peers: [] });
      fetch.mockRejectedValue(new Error('not reachable'));

      const peer = await addPeer({ address: '10.0.0.9', auth: { username: '  alice  ', password: 's3cret' } });

      expect(peer.auth).toEqual({ username: 'alice', password: 's3cret' });
    });

    it('should treat a blank credential as no auth', async () => {
      readJSONFile.mockResolvedValue({ self: null, peers: [] });
      fetch.mockRejectedValue(new Error('not reachable'));

      const peer = await addPeer({ address: '10.0.0.10', auth: { username: '', password: '' } });

      expect(peer.auth).toBeNull();
    });

    it('should store a password-only credential (username defaults to "")', async () => {
      readJSONFile.mockResolvedValue({ self: null, peers: [] });
      fetch.mockRejectedValue(new Error('not reachable'));

      const peer = await addPeer({ address: '10.0.0.11', auth: { password: 'tok3n' } });

      expect(peer.auth).toEqual({ username: '', password: 'tok3n' });
    });

    it('should ignore a username-only payload (no blank-password store)', async () => {
      readJSONFile.mockResolvedValue({ self: null, peers: [] });
      fetch.mockRejectedValue(new Error('not reachable'));

      const peer = await addPeer({ address: '10.0.0.12', auth: { username: 'alice' } });

      // A username-only payload (e.g. a redacted client peer round-tripped back)
      // must not store a blank-password credential — it's ignored, so a new peer
      // is left with no auth.
      expect(peer.auth).toBeNull();
    });
  });

  describe('removePeer', () => {
    it('should remove existing peer by id', async () => {
      const peers = [
        { id: 'peer-1', name: 'host1', address: '10.0.0.1' },
        { id: 'peer-2', name: 'host2', address: '10.0.0.2' }
      ];
      readJSONFile.mockResolvedValue({ self: null, peers });

      const removed = await removePeer('peer-1');

      expect(removed).toMatchObject({ id: 'peer-1', name: 'host1' });
      expect(disconnectFromPeer).toHaveBeenCalledWith('peer-1');
      expect(instanceEvents.emit).toHaveBeenCalledWith('peers:updated', expect.any(Array));
    });

    it('should return null for non-existent peer', async () => {
      readJSONFile.mockResolvedValue({ self: null, peers: [] });

      const removed = await removePeer('non-existent');

      expect(removed).toBeNull();
      expect(disconnectFromPeer).toHaveBeenCalledWith('non-existent');
    });
  });

  describe('redactPeerForWire', () => {
    it('strips the auth credential before a peer crosses the wire', () => {
      const peer = { id: 'peer-1', name: 'host', auth: { username: 'a', password: 'b' }, status: 'online' };
      const redacted = redactPeerForWire(peer);

      expect(redacted).not.toHaveProperty('auth');
      expect(redacted).toMatchObject({ id: 'peer-1', name: 'host', status: 'online' });
      // Does not mutate the original
      expect(peer.auth).toEqual({ username: 'a', password: 'b' });
    });

    it('is a no-op for a peer without auth', () => {
      const peer = { id: 'peer-1', name: 'host' };
      expect(redactPeerForWire(peer)).toBe(peer);
    });
  });

  describe('sanitizePeerForClient', () => {
    it('redacts the password to a hasPassword marker but keeps the username', () => {
      const peer = { id: 'peer-1', name: 'host', auth: { username: 'alice', password: 'secret' }, status: 'online' };
      const sanitized = sanitizePeerForClient(peer);

      expect(sanitized.auth).toEqual({ username: 'alice', hasPassword: true });
      expect(sanitized.auth.password).toBeUndefined();
      expect(sanitized).toMatchObject({ id: 'peer-1', status: 'online' });
      // Original (server-side record) keeps the real password
      expect(peer.auth.password).toBe('secret');
    });

    it('leaves a credential-less peer untouched', () => {
      const peer = { id: 'peer-1', name: 'host', auth: null };
      expect(sanitizePeerForClient(peer)).toBe(peer);
    });
  });

  describe('updatePeer', () => {
    it('should update peer name', async () => {
      const peers = [{ id: 'peer-1', name: 'old-name', enabled: true }];
      readJSONFile.mockResolvedValue({ self: null, peers });

      const result = await updatePeer('peer-1', { name: 'new-name' });

      expect(result.name).toBe('new-name');
    });

    it('should update peer enabled state', async () => {
      const peers = [{ id: 'peer-1', name: 'host', enabled: true }];
      readJSONFile.mockResolvedValue({ self: null, peers });

      const result = await updatePeer('peer-1', { enabled: false });

      expect(result.enabled).toBe(false);
      expect(disconnectFromPeer).toHaveBeenCalledWith('peer-1');
    });

    it('should return null for non-existent peer', async () => {
      readJSONFile.mockResolvedValue({ self: null, peers: [] });

      const result = await updatePeer('missing', { name: 'x' });

      expect(result).toBeNull();
    });

    it('should accept names like undefined as valid hostnames', async () => {
      const peers = [{ id: 'peer-1', name: 'good-name', enabled: true }];
      readJSONFile.mockResolvedValue({ self: null, peers });

      const result = await updatePeer('peer-1', { name: 'undefined' });

      expect(result.name).toBe('undefined');
    });

    it('should set a credential on a peer', async () => {
      const peers = [{ id: 'peer-1', name: 'host', enabled: true, auth: null }];
      readJSONFile.mockResolvedValue({ self: null, peers });

      const result = await updatePeer('peer-1', { auth: { username: 'bob', password: 'pw' } });

      expect(result.auth).toEqual({ username: 'bob', password: 'pw' });
    });

    it('should clear a credential when auth is null', async () => {
      const peers = [{ id: 'peer-1', name: 'host', enabled: true, auth: { username: 'bob', password: 'pw' } }];
      readJSONFile.mockResolvedValue({ self: null, peers });

      const result = await updatePeer('peer-1', { auth: null });

      expect(result.auth).toBeNull();
    });

    it('should ignore a malformed auth value rather than wiping a working credential', async () => {
      const peers = [{ id: 'peer-1', name: 'host', enabled: true, auth: { username: 'bob', password: 'pw' } }];
      readJSONFile.mockResolvedValue({ self: null, peers });

      const result = await updatePeer('peer-1', { auth: 'not-an-object' });

      expect(result.auth).toEqual({ username: 'bob', password: 'pw' });
    });

    it('should ignore a username-only payload rather than wiping a working password', async () => {
      // The client only ever receives a redacted peer ({ username, hasPassword }).
      // Round-tripping that shape back into a PATCH sends auth.username with no
      // password — it must not clear the stored secret with a blank password.
      const peers = [{ id: 'peer-1', name: 'host', enabled: true, auth: { username: 'bob', password: 'pw' } }];
      readJSONFile.mockResolvedValue({ self: null, peers });

      const result = await updatePeer('peer-1', { auth: { username: 'bob' } });

      expect(result.auth).toEqual({ username: 'bob', password: 'pw' });
      expect(disconnectFromPeer).not.toHaveBeenCalled();
    });

    it('should reconnect the relay and re-probe immediately when the credential changes', async () => {
      // Peer is deep in backoff from prior 401s — the new credential must
      // trigger an immediate probe, not wait out nextProbeAt.
      const peers = [{ id: 'peer-1', name: 'host', enabled: true, status: 'offline', consecutiveFailures: 5, nextProbeAt: '2999-01-01T00:00:00Z', auth: { username: 'bob', password: 'old' } }];
      readJSONFile.mockResolvedValue({ self: null, peers });
      fetch.mockRejectedValue(new Error('offline'));

      await updatePeer('peer-1', { auth: { username: 'bob', password: 'new' } });

      // Relay pins the Basic header at connect time, so a credential change
      // must tear it down to reconnect with the new extraHeaders.
      expect(disconnectFromPeer).toHaveBeenCalledWith('peer-1');
      // Immediate re-probe fired (bypasses the nextProbeAt backoff gate). The
      // probe is fire-and-forget and now resolves our instanceId (one extra
      // microtask) before fetching sync-status, so wait for the fetch.
      await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    });

    it('should NOT reconnect or re-probe on a no-op credential write', async () => {
      const peers = [{ id: 'peer-1', name: 'host', enabled: true, auth: { username: 'bob', password: 'pw' } }];
      readJSONFile.mockResolvedValue({ self: null, peers });
      fetch.mockRejectedValue(new Error('offline'));

      await updatePeer('peer-1', { auth: { username: 'bob', password: 'pw' } });

      expect(disconnectFromPeer).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    });

    it('should not disconnect when enabling a peer', async () => {
      const peers = [{ id: 'peer-1', name: 'host', enabled: false }];
      readJSONFile.mockResolvedValue({ self: null, peers });

      await updatePeer('peer-1', { enabled: true });

      expect(disconnectFromPeer).not.toHaveBeenCalled();
    });

    it('should set a valid DNS host and disconnect the relay so it reconnects via HTTPS', async () => {
      const peers = [{ id: 'peer-1', name: 'host', enabled: true, host: null }];
      readJSONFile.mockResolvedValue({ self: null, peers });

      const result = await updatePeer('peer-1', { host: 'void.taile8179.ts.net' });

      expect(result.host).toBe('void.taile8179.ts.net');
      expect(disconnectFromPeer).toHaveBeenCalledWith('peer-1');
    });

    it('should clear host when empty string is passed', async () => {
      const peers = [{ id: 'peer-1', name: 'host', enabled: true, host: 'old.example.com' }];
      readJSONFile.mockResolvedValue({ self: null, peers });

      const result = await updatePeer('peer-1', { host: '' });

      expect(result.host).toBeNull();
    });

    it('should latch hostManual when user explicitly sets host', async () => {
      const peers = [{ id: 'peer-1', name: 'host', enabled: true, host: null, hostManual: false }];
      readJSONFile.mockResolvedValue({ self: null, peers });

      const result = await updatePeer('peer-1', { host: 'machine.taile8179.ts.net' });

      expect(result.host).toBe('machine.taile8179.ts.net');
      expect(result.hostManual).toBe(true);
    });

    it('should latch hostManual when user explicitly clears host (the un-revert bug)', async () => {
      const peers = [{ id: 'peer-1', name: 'host', enabled: true, host: 'machine.taile8179.ts.net', hostManual: false }];
      readJSONFile.mockResolvedValue({ self: null, peers });

      const result = await updatePeer('peer-1', { host: '' });

      expect(result.host).toBeNull();
      expect(result.hostManual).toBe(true);
    });

    it('should ignore invalid host (leave unchanged)', async () => {
      const peers = [{ id: 'peer-1', name: 'host', enabled: true, host: 'good.example.com' }];
      readJSONFile.mockResolvedValue({ self: null, peers });

      const result = await updatePeer('peer-1', { host: 'bad!!host' });

      expect(result.host).toBe('good.example.com');
    });

    it('should not disconnect the relay when host is invalid or unchanged', async () => {
      const peers = [{ id: 'peer-1', name: 'host', enabled: true, host: 'same.example.com' }];
      readJSONFile.mockResolvedValue({ self: null, peers });

      await updatePeer('peer-1', { host: 'same.example.com' });
      expect(disconnectFromPeer).not.toHaveBeenCalled();

      await updatePeer('peer-1', { host: 'bad!!host' });
      expect(disconnectFromPeer).not.toHaveBeenCalled();
    });
  });

  // --- Bidirectional sync reciprocation ---

  describe('applyReciprocalSync', () => {
    it('mirrors a peer\'s enabled categories onto our local record for that peer', async () => {
      const peers = [{ id: 'p1', instanceId: 'inst-A', name: 'A', syncCategories: { brain: false, goals: false } }];
      readJSONFile.mockResolvedValue({ self: { instanceId: 'me' }, peers });

      const { changed, peer } = await applyReciprocalSync('inst-A', { brain: true });

      expect(changed).toBe(true);
      expect(peer.syncCategories.brain).toBe(true);
      expect(peer.syncEnabled).toBe(true); // recomputed from the resulting map
      expect(peer._reciprocalChanged).toBeUndefined(); // no transient marker leaks onto the record
      // And the persisted payload must not carry any transient marker either.
      const written = atomicWrite.mock.calls.at(-1)?.[1];
      expect(written.peers[0]._reciprocalChanged).toBeUndefined();
    });

    it('is a no-op (changed:false) when our record already matches — the echo guard', async () => {
      const peers = [{ id: 'p1', instanceId: 'inst-A', name: 'A', syncCategories: { brain: true }, syncEnabled: true }];
      readJSONFile.mockResolvedValue({ self: { instanceId: 'me' }, peers });

      const { changed } = await applyReciprocalSync('inst-A', { brain: true });

      expect(changed).toBe(false);
    });

    it('echo guard treats absent-vs-false alike: adding goals:false to a partial map is a no-op', async () => {
      // prev is a partial map missing `goals`; incoming sets goals:false, which
      // is already the effective state → must NOT report changed (the baseline
      // is defaulted so `false !== undefined` can't spuriously trip the guard).
      const peers = [{ id: 'p1', instanceId: 'inst-A', name: 'A', syncCategories: { brain: true } }];
      readJSONFile.mockResolvedValue({ self: { instanceId: 'me' }, peers });

      const { changed } = await applyReciprocalSync('inst-A', { goals: false });

      expect(changed).toBe(false);
    });

    it('applies an all-false map to clear a stale enabled category (the offline-disable recovery path)', async () => {
      const peers = [{ id: 'p1', instanceId: 'inst-A', name: 'A', syncCategories: { brain: true }, syncEnabled: true }];
      readJSONFile.mockResolvedValue({ self: { instanceId: 'me' }, peers });

      const { changed, peer } = await applyReciprocalSync('inst-A', { brain: false });

      expect(changed).toBe(true);
      expect(peer.syncCategories.brain).toBe(false);
      expect(peer.syncEnabled).toBe(false); // nothing left enabled
    });

    it('full-mirror is intentional: a peer\'s category:false disables a category we independently enabled (issue #1094)', async () => {
      // Decision (issue #1094): sync categories are a symmetric full mirror, not
      // two strictly-independent per-direction switches. So when a peer announces
      // `{ goals: false }` (e.g. via 'Make mutual' pushing its current set), it
      // DISABLES goals on our record for that peer even though we had enabled it
      // toward them independently. This pins that behavior so a future refactor to
      // enable-only reciprocation can't silently regress 'Make mutual' / the
      // offline-disable recovery path without tripping this test.
      const peers = [{ id: 'p1', instanceId: 'inst-A', name: 'A', syncCategories: { brain: true, goals: true }, syncEnabled: true }];
      readJSONFile.mockResolvedValue({ self: { instanceId: 'me' }, peers });

      const { changed, peer } = await applyReciprocalSync('inst-A', { goals: false });

      expect(changed).toBe(true);
      expect(peer.syncCategories.goals).toBe(false); // announced false is authoritative — clobbers our independent enable
      expect(peer.syncCategories.brain).toBe(true);  // omitted keys preserved untouched
      expect(peer.syncEnabled).toBe(true);           // brain still on
    });

    it('returns changed:false for an unknown peer instanceId', async () => {
      readJSONFile.mockResolvedValue({ self: { instanceId: 'me' }, peers: [] });
      const { changed, peer } = await applyReciprocalSync('nope', { brain: true });
      expect(changed).toBe(false);
      expect(peer).toBeNull();
    });

    it('drops unknown/garbage category keys (only DEFAULT_SYNC_CATEGORIES keys applied)', async () => {
      const peers = [{ id: 'p1', instanceId: 'inst-A', name: 'A', syncCategories: { brain: false } }];
      readJSONFile.mockResolvedValue({ self: { instanceId: 'me' }, peers });

      const { peer } = await applyReciprocalSync('inst-A', { brain: true, __proto__: true, bogus: true });

      expect(peer.syncCategories.brain).toBe(true);
      expect(peer.syncCategories.bogus).toBeUndefined();
    });

    it('ignores a non-object categories payload', async () => {
      readJSONFile.mockResolvedValue({ self: { instanceId: 'me' }, peers: [] });
      const { changed } = await applyReciprocalSync('inst-A', 'not-an-object');
      expect(changed).toBe(false);
    });
  });

  describe('requestReciprocalSync', () => {
    it('POSTs our self instanceId + sanitized categories to the peer', async () => {
      readJSONFile.mockResolvedValue({ self: { instanceId: 'me-id', name: 'me' }, peers: [] });
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      vi.stubGlobal('fetch', fetchMock);

      const result = await requestReciprocalSync(
        { id: 'p1', address: '10.0.0.2', port: 5555, name: 'B' },
        { brain: true, bogus: true }
      );

      expect(result.ok).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toContain('/api/instances/peers/sync-categories');
      const body = JSON.parse(opts.body);
      expect(body.instanceId).toBe('me-id');
      expect(body.syncCategories).toEqual({ brain: true }); // bogus dropped
    });

    it('returns ok:false (not throw) when the peer 404s the endpoint (older version)', async () => {
      readJSONFile.mockResolvedValue({ self: { instanceId: 'me-id' }, peers: [] });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }));

      const result = await requestReciprocalSync(
        { id: 'p1', address: '10.0.0.2', port: 5555, name: 'B' },
        { brain: true }
      );

      expect(result.ok).toBe(false);
      expect(result.reason).toBe('http-404');
    });

    it('returns ok:false when we have no self identity', async () => {
      readJSONFile.mockResolvedValue({ self: null, peers: [] });
      const result = await requestReciprocalSync({ id: 'p1', address: '10.0.0.2', port: 5555 }, { brain: true });
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('no-self-identity');
    });
  });

  describe('enqueueReciprocalSync', () => {
    it('reads the FRESHEST persisted categories at send time (last enqueue wins, not enqueue-time snapshot)', async () => {
      // readJSONFile is re-read on each send; point it at the latest map so the
      // serialized send carries final state regardless of when it was enqueued.
      readJSONFile.mockResolvedValue({
        self: { instanceId: 'me-id' },
        peers: [{ id: 'p1', instanceId: 'inst-A', name: 'A', syncCategories: { brain: true, goals: true } }]
      });
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      vi.stubGlobal('fetch', fetchMock);

      await enqueueReciprocalSync('p1');

      const body = JSON.parse(fetchMock.mock.calls.at(-1)[1].body);
      expect(body.syncCategories).toEqual({ brain: true, goals: true });
    });

    it('serializes per peer so sends leave in enqueue order (no stale-map race)', async () => {
      // Unique peer id so the module-level per-peer tail can't chain onto another
      // test's queue. The second send resolves immediately; the first blocks on
      // resolveFirst. If sends raced, order would be ['second', 'first']; ordered
      // serialization yields ['first', 'second'].
      readJSONFile.mockResolvedValue({
        self: { instanceId: 'me-id' },
        peers: [{ id: 'p-serial', instanceId: 'inst-A', name: 'A', syncCategories: { brain: true } }]
      });
      const order = [];
      let resolveFirst;
      const fetchMock = vi.fn()
        .mockImplementationOnce(() => new Promise(r => { resolveFirst = () => { order.push('first'); r({ ok: true, status: 200 }); }; }))
        .mockImplementationOnce(async () => { order.push('second'); return { ok: true, status: 200 }; });
      vi.stubGlobal('fetch', fetchMock);

      const p1 = enqueueReciprocalSync('p-serial');
      const p2 = enqueueReciprocalSync('p-serial');
      // The second send resolves immediately; the first blocks until we release
      // it. If the two ran concurrently (unserialized), 'second' would land
      // first. Flush microtasks until the first send reaches its (blocked)
      // fetch, then release it — the recorded order proves serialization.
      // (beforeEach installs fake timers, so we flush the microtask queue
      // directly rather than waiting on a real-time setTimeout.)
      for (let i = 0; i < 20 && !resolveFirst; i++) await Promise.resolve();
      resolveFirst();
      await Promise.all([p1, p2]);
      expect(order).toEqual(['first', 'second']);
    });

    it('no-ops cleanly for a peer that lost its instanceId', async () => {
      readJSONFile.mockResolvedValue({
        self: { instanceId: 'me-id' },
        peers: [{ id: 'p-noinst', name: 'A', syncCategories: { brain: true } }] // no instanceId
      });
      vi.stubGlobal('fetch', vi.fn());
      const result = await enqueueReciprocalSync('p-noinst');
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('no-peer-identity');
    });

    it('a full-sync peer reciprocates the ALL-ON category view + the fullSync flag (not its raw all-false map)', async () => {
      // A full-sync peer mirrors everything; its stored syncCategories can be
      // all-false underneath. Sending that raw would tell the peer to DISABLE
      // everything (reciprocal apply is an authoritative overlay). It must send
      // every category on, plus fullSync:true so a new-enough peer adopts mirror
      // mode too.
      readJSONFile.mockResolvedValue({
        self: { instanceId: 'me-id' },
        peers: [{ id: 'p-full', instanceId: 'inst-A', name: 'A', fullSync: true, syncCategories: { brain: false } }]
      });
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      vi.stubGlobal('fetch', fetchMock);

      await enqueueReciprocalSync('p-full');

      const body = JSON.parse(fetchMock.mock.calls.at(-1)[1].body);
      expect(body.fullSync).toBe(true);
      // Every category present and true.
      expect(Object.values(body.syncCategories).every(Boolean)).toBe(true);
      expect(body.syncCategories.brain).toBe(true);
      expect(body.syncCategories.tracks).toBe(true);
    });
  });

  describe('fullSync (full-mirror) peer mode', () => {
    it('addPeer defaults fullSync off when no self default is set', async () => {
      readJSONFile.mockResolvedValue({ self: { instanceId: 'me' }, peers: [] });
      fetch.mockRejectedValue(new Error('not reachable'));
      const peer = await addPeer({ address: '10.0.0.9', name: 'p' });
      expect(peer.fullSync).toBe(false);
    });

    it('addPeer inherits the self-side defaultPeerFullSync for new peers', async () => {
      readJSONFile.mockResolvedValue({ self: { instanceId: 'me', defaultPeerFullSync: true }, peers: [] });
      fetch.mockRejectedValue(new Error('not reachable'));
      const peer = await addPeer({ address: '10.0.0.10', name: 'p' });
      expect(peer.fullSync).toBe(true);
      expect(peer.syncEnabled).toBe(true);
    });

    it('updatePeer enabling fullSync implies syncEnabled on', async () => {
      const peers = [{ id: 'p1', name: 'A', enabled: true, fullSync: false, syncEnabled: false, syncCategories: {} }];
      readJSONFile.mockResolvedValue({ self: { instanceId: 'me' }, peers });
      const result = await updatePeer('p1', { fullSync: true });
      expect(result.fullSync).toBe(true);
      expect(result.syncEnabled).toBe(true);
    });

    it('updatePeer disabling fullSync recomputes syncEnabled from the preserved category map', async () => {
      // brain was on underneath → still sync-enabled after turning mirror off.
      const onPeer = [{ id: 'p1', name: 'A', enabled: true, fullSync: true, syncEnabled: true, syncCategories: { brain: true } }];
      readJSONFile.mockResolvedValue({ self: { instanceId: 'me' }, peers: onPeer });
      const stillOn = await updatePeer('p1', { fullSync: false });
      expect(stillOn.fullSync).toBe(false);
      expect(stillOn.syncEnabled).toBe(true);

      // empty map → nothing left to sync.
      const emptyPeer = [{ id: 'p2', name: 'B', enabled: true, fullSync: true, syncEnabled: true, syncCategories: {} }];
      readJSONFile.mockResolvedValue({ self: { instanceId: 'me' }, peers: emptyPeer });
      const off = await updatePeer('p2', { fullSync: false });
      expect(off.syncEnabled).toBe(false);
    });

    it('applyReciprocalSync adopts fullSync even when the category map is empty', async () => {
      const peers = [{ id: 'p1', instanceId: 'inst-A', name: 'A', fullSync: false, syncCategories: {} }];
      readJSONFile.mockResolvedValue({ self: { instanceId: 'me' }, peers });
      const { changed, peer } = await applyReciprocalSync('inst-A', {}, { fullSync: true });
      expect(changed).toBe(true);
      expect(peer.fullSync).toBe(true);
      expect(peer.syncEnabled).toBe(true);
    });

    it('adopting full mirror via reciprocation preserves the underlying per-category selection', async () => {
      // The sender includes an all-on compat map alongside fullSync:true. A
      // fullSync-aware receiver must NOT overwrite its own selection with it —
      // otherwise a later disable would leave every category on instead of
      // restoring the user's choice (only brain here).
      const peers = [{ id: 'p1', instanceId: 'inst-A', name: 'A', fullSync: false, syncCategories: { brain: true } }];
      readJSONFile.mockResolvedValue({ self: { instanceId: 'me' }, peers });
      const allOn = Object.fromEntries(Object.keys(DEFAULT_SYNC_CATEGORIES).map(k => [k, true]));
      const { changed, peer } = await applyReciprocalSync('inst-A', allOn, { fullSync: true });
      expect(changed).toBe(true);
      expect(peer.fullSync).toBe(true);
      expect(peer.syncCategories.brain).toBe(true);
      expect(peer.syncCategories.universe).toBeFalsy(); // not clobbered to true
    });

    it('applyReciprocalSync drops our mirror when the peer reports fullSync:false (disable reciprocation)', async () => {
      // The peer stopped mirroring us — symmetric with the enable path. The
      // preserved per-category map (brain on) becomes authoritative again.
      const peers = [{ id: 'p1', instanceId: 'inst-A', name: 'A', fullSync: true, syncEnabled: true, syncCategories: { brain: true } }];
      readJSONFile.mockResolvedValue({ self: { instanceId: 'me' }, peers });
      const { changed, peer } = await applyReciprocalSync('inst-A', { brain: true }, { fullSync: false });
      expect(changed).toBe(true);
      expect(peer.fullSync).toBe(false);
      expect(peer.syncEnabled).toBe(true); // brain still on underneath
    });

    it('applyReciprocalSync ignores an absent fullSync field (older peer) — mirror untouched', async () => {
      const peers = [{ id: 'p1', instanceId: 'inst-A', name: 'A', fullSync: true, syncEnabled: true, syncCategories: { brain: true } }];
      readJSONFile.mockResolvedValue({ self: { instanceId: 'me' }, peers });
      // No fullSync key in opts → undefined → must not clear the mirror.
      const { peer } = await applyReciprocalSync('inst-A', { brain: true });
      expect(peer.fullSync).toBe(true);
    });

    // --- Outbound consent on reciprocation (#1636) ---
    // An `/announce`-created peer record is inbound-only until the user here adds
    // it back. peerAllowsOutbound refuses to push to an inbound-only peer, so a
    // reciprocally-enabled per-record category / fullSync would silently never
    // back-subscribe — leaving the "mirror" one-directional. An explicit
    // reciprocal-sync request IS the peer's consent to receive our pushes, so we
    // adopt `outbound` when (and only when) we turn a per-record kind on.

    it('adopts `outbound` on an inbound-only peer when a per-record category is reciprocally enabled (#1636)', async () => {
      const peers = [{ id: 'p1', instanceId: 'inst-A', name: 'A', directions: ['inbound'], syncCategories: { universe: false } }];
      readJSONFile.mockResolvedValue({ self: { instanceId: 'me' }, peers });
      const { changed, peer } = await applyReciprocalSync('inst-A', { universe: true });
      expect(changed).toBe(true);
      expect(peer.syncCategories.universe).toBe(true);
      expect(peer.directions).toContain('outbound'); // backfill/push now unblocked
      expect(peer.directions).toContain('inbound');  // existing direction preserved
    });

    it('adopts `outbound` on an inbound-only peer when fullSync is reciprocally adopted (#1636)', async () => {
      const peers = [{ id: 'p1', instanceId: 'inst-A', name: 'A', directions: ['inbound'], fullSync: false, syncCategories: {} }];
      readJSONFile.mockResolvedValue({ self: { instanceId: 'me' }, peers });
      const { changed, peer } = await applyReciprocalSync('inst-A', {}, { fullSync: true });
      expect(changed).toBe(true);
      expect(peer.fullSync).toBe(true);
      expect(peer.directions).toContain('outbound');
    });

    it('does NOT add `outbound` when the peer reports fullSync:false — a disable is not consent to push (#1636)', async () => {
      const peers = [{ id: 'p1', instanceId: 'inst-A', name: 'A', directions: ['inbound'], fullSync: true, syncEnabled: true, syncCategories: {} }];
      readJSONFile.mockResolvedValue({ self: { instanceId: 'me' }, peers });
      const { changed, peer } = await applyReciprocalSync('inst-A', {}, { fullSync: false });
      expect(changed).toBe(true);
      expect(peer.fullSync).toBe(false);
      expect(peer.directions).not.toContain('outbound'); // mirror dropped, not widened
    });

    it('leaves directions untouched when only a snapshot category (no per-record kind) is reciprocated (#1636)', async () => {
      // brain/goals sync via the snapshot path, which does not gate on directions —
      // so there is no backfill to unblock and no reason to widen consent.
      const peers = [{ id: 'p1', instanceId: 'inst-A', name: 'A', directions: ['inbound'], syncCategories: { brain: false } }];
      readJSONFile.mockResolvedValue({ self: { instanceId: 'me' }, peers });
      const { changed, peer } = await applyReciprocalSync('inst-A', { brain: true });
      expect(changed).toBe(true);
      expect(peer.syncCategories.brain).toBe(true);
      expect(peer.directions).toEqual(['inbound']); // not widened to outbound
    });

    it('does not duplicate `outbound` when the peer record already pushes — idempotent (#1636)', async () => {
      const peers = [{ id: 'p1', instanceId: 'inst-A', name: 'A', directions: ['inbound', 'outbound'], syncCategories: { universe: false } }];
      readJSONFile.mockResolvedValue({ self: { instanceId: 'me' }, peers });
      const { peer } = await applyReciprocalSync('inst-A', { universe: true });
      expect(peer.directions.filter(d => d === 'outbound')).toHaveLength(1);
    });

    it('heals a pre-existing inbound-only record that already adopted fullSync — a re-sent request with no flip still adopts outbound (#1636)', async () => {
      // The population this issue exists to fix: a record that adopted fullSync (or
      // categories) BEFORE the fix landed but stayed inbound-only, so it never
      // back-filled. Nothing flips on a re-sent reciprocal request, so outbound
      // adoption must drive change detection itself or the echo guard returns first.
      const peers = [{ id: 'p1', instanceId: 'inst-A', name: 'A', directions: ['inbound'], fullSync: true, syncEnabled: true, syncCategories: {} }];
      readJSONFile.mockResolvedValue({ self: { instanceId: 'me' }, peers });
      const { changed, peer } = await applyReciprocalSync('inst-A', {}, { fullSync: true });
      expect(changed).toBe(true);           // NOT echo-guarded — the missing direction is a real change
      expect(peer.fullSync).toBe(true);     // unchanged
      expect(peer.directions).toContain('outbound');
    });

    it('heals a pre-existing inbound-only record with an already-enabled per-record category (#1636)', async () => {
      const peers = [{ id: 'p1', instanceId: 'inst-A', name: 'A', directions: ['inbound'], syncCategories: { universe: true }, syncEnabled: true }];
      readJSONFile.mockResolvedValue({ self: { instanceId: 'me' }, peers });
      const { changed, peer } = await applyReciprocalSync('inst-A', { universe: true });
      expect(changed).toBe(true);
      expect(peer.directions).toContain('outbound');
    });

    it('stays a no-op when a fullSync re-send arrives on a record that already pushes (echo guard intact) (#1636)', async () => {
      const peers = [{ id: 'p1', instanceId: 'inst-A', name: 'A', directions: ['inbound', 'outbound'], fullSync: true, syncEnabled: true, syncCategories: {} }];
      readJSONFile.mockResolvedValue({ self: { instanceId: 'me' }, peers });
      const { changed } = await applyReciprocalSync('inst-A', {}, { fullSync: true });
      expect(changed).toBe(false); // already outbound + already fullSync → nothing to do
    });

    it('does not adopt outbound (or report changed) for a snapshot-only category that already matches on an inbound-only peer (#1636)', async () => {
      // brain is a snapshot category, not a per-record push kind — it doesn't gate
      // on directions, so there's no backfill to unblock and no consent to widen.
      const peers = [{ id: 'p1', instanceId: 'inst-A', name: 'A', directions: ['inbound'], syncCategories: { brain: true }, syncEnabled: true }];
      readJSONFile.mockResolvedValue({ self: { instanceId: 'me' }, peers });
      const { changed, peer } = await applyReciprocalSync('inst-A', { brain: true });
      expect(changed).toBe(false);
      expect(peer.directions).toEqual(['inbound']);
    });

    it('a snapshot-only reciprocal request does NOT widen outbound just because a per-record category is already enabled locally (#1636)', async () => {
      // Consent is scoped to THIS request: reciprocating `goals` (a snapshot
      // category) must not opportunistically start pushing the locally-enabled
      // `universe` records back — the peer never asked us to mirror universe here.
      const peers = [{ id: 'p1', instanceId: 'inst-A', name: 'A', directions: ['inbound'], syncCategories: { universe: true }, syncEnabled: true }];
      readJSONFile.mockResolvedValue({ self: { instanceId: 'me' }, peers });
      const { changed, peer } = await applyReciprocalSync('inst-A', { goals: true });
      expect(changed).toBe(true);                 // goals (snapshot) was enabled
      expect(peer.syncCategories.goals).toBe(true);
      expect(peer.syncCategories.universe).toBe(true); // preserved
      expect(peer.directions).toEqual(['inbound']);    // NOT widened to outbound
    });

    it('disabling fullSync reciprocates fullSync:false even with an empty category map', async () => {
      // The empty-map case is the one the no-categories send guard used to drop:
      // a just-disabled mirror peer whose underlying syncCategories is empty must
      // STILL POST fullSync:false so the remote learns to drop its mirror.
      readJSONFile.mockResolvedValue({
        self: { instanceId: 'me-id' },
        peers: [{ id: 'p1', instanceId: 'inst-A', name: 'A', enabled: true, fullSync: false, syncCategories: {} }],
      });
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      vi.stubGlobal('fetch', fetchMock);
      const result = await enqueueReciprocalSync('p1');
      expect(result.ok).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = JSON.parse(fetchMock.mock.calls.at(-1)[1].body);
      expect(body.fullSync).toBe(false);
      expect(body.syncCategories).toEqual({}); // valid object so the receiver schema parses
    });

    it('updateSelf persists the new-peer full-sync default', async () => {
      readJSONFile.mockResolvedValue({ self: { instanceId: 'me', name: 'box' }, peers: [] });
      const self = await updateSelf(undefined, { defaultPeerFullSync: true });
      expect(self.defaultPeerFullSync).toBe(true);
      expect(self.name).toBe('box'); // name untouched when omitted
    });
  });

  // --- Probing ---

  describe('probePeer', () => {
    const makePeer = (overrides = {}) => ({
      id: 'peer-1',
      address: '10.0.0.1',
      port: 5555,
      name: 'remote',
      status: 'unknown',
      lastSeen: null,
      lastHealth: null,
      lastApps: null,
      remoteSyncSeqs: null,
      enabled: true,
      ...overrides
    });

    it('should mark peer online on successful probe', async () => {
      const peer = makePeer();
      const peers = [peer];
      readJSONFile.mockResolvedValue({ self: null, peers });

      const healthData = { instanceId: 'remote-id', version: '1.0.0', hostname: 'remote-host' };
      const appsData = [{ id: 'app1', name: 'MyApp', overallStatus: 'running' }];

      fetch
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(healthData) }) // health
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(appsData) }) // apps
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ seq: 1 }) }); // sync

      const result = await probePeer(peer);

      expect(result.status).toBe('online');
      expect(result.instanceId).toBe('remote-id');
      expect(result.version).toBe('1.0.0');
      expect(result.lastSeen).toBeDefined();
      expect(connectToPeer).toHaveBeenCalledWith(peer);
    });

    it('should mark peer offline on fetch failure', async () => {
      const peer = makePeer({ lastSeen: '2024-01-01T00:00:00Z', lastHealth: { uptime: 100 } });
      const peers = [peer];
      readJSONFile.mockResolvedValue({ self: null, peers });

      fetch.mockRejectedValue(new Error('Connection refused'));

      const result = await probePeer(peer);

      expect(result.status).toBe('offline');
      expect(result.lastSeen).toBe('2024-01-01T00:00:00Z');
      expect(result.lastHealth).toEqual({ uptime: 100 });
      expect(disconnectFromPeer).toHaveBeenCalledWith('peer-1');
    });

    it('should mark peer offline on non-ok health response', async () => {
      const peer = makePeer();
      const peers = [peer];
      readJSONFile.mockResolvedValue({ self: null, peers });

      fetch
        .mockResolvedValueOnce({ ok: false, status: 500 }) // health
        .mockResolvedValueOnce(null) // apps (caught)
        .mockResolvedValueOnce(null); // sync (caught)

      const result = await probePeer(peer);

      expect(result.status).toBe('offline');
      expect(result.authRequired).toBe(false);
    });

    it('should set authRequired when the peer responds 401', async () => {
      const peer = makePeer();
      const peers = [peer];
      readJSONFile.mockResolvedValue({ self: null, peers });

      fetch
        .mockResolvedValueOnce({ ok: false, status: 401 }) // health — auth-gated proxy
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);

      const result = await probePeer(peer);

      expect(result.status).toBe('offline');
      expect(result.authRequired).toBe(true);
    });

    it('should clear authRequired on a successful probe', async () => {
      const peer = makePeer({ authRequired: true });
      const peers = [peer];
      readJSONFile.mockResolvedValue({ self: null, peers });

      fetch
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ instanceId: 'r-id' }) })
        .mockResolvedValueOnce({ ok: false })
        .mockResolvedValueOnce({ ok: false });

      const result = await probePeer(peer);

      expect(result.status).toBe('online');
      expect(result.authRequired).toBe(false);
    });

    it('should auto-update name from hostname when name is an IP', async () => {
      const peer = makePeer({ name: '10.0.0.1' });
      const peers = [peer];
      readJSONFile.mockResolvedValue({ self: null, peers });

      const healthData = { instanceId: 'r-id', hostname: 'proper-hostname' };
      fetch
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(healthData) })
        .mockResolvedValueOnce({ ok: false })
        .mockResolvedValueOnce({ ok: false });

      const result = await probePeer(peer);

      expect(result.name).toBe('proper-hostname');
    });

    it('should emit peer:online when transitioning to online', async () => {
      const peer = makePeer({ status: 'offline' });
      const peers = [peer];
      readJSONFile.mockResolvedValue({ self: null, peers });

      const healthData = { instanceId: 'r-id' };
      fetch
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(healthData) })
        .mockResolvedValueOnce({ ok: false })
        .mockResolvedValueOnce({ ok: false })
        // announceSelf calls
        .mockRejectedValue(new Error('announce failed'));

      const result = await probePeer(peer);

      expect(result.status).toBe('online');
      expect(instanceEvents.emit).toHaveBeenCalledWith('peer:online', expect.any(Object));
    });

    it('should not emit peer:online if already online', async () => {
      const peer = makePeer({ status: 'online' });
      const peers = [peer];
      readJSONFile.mockResolvedValue({ self: null, peers });

      const healthData = { instanceId: 'r-id' };
      fetch
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(healthData) })
        .mockResolvedValueOnce({ ok: false })
        .mockResolvedValueOnce({ ok: false });

      await probePeer(peer);

      expect(instanceEvents.emit).not.toHaveBeenCalledWith('peer:online', expect.anything());
    });

    it('should return null if peer is removed during probe', async () => {
      const peer = makePeer({ id: 'removed-peer' });
      // The peer list does NOT contain this peer
      readJSONFile.mockResolvedValue({ self: null, peers: [] });

      const healthData = { instanceId: 'r-id' };
      fetch
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(healthData) })
        .mockResolvedValueOnce({ ok: false })
        .mockResolvedValueOnce({ ok: false });

      const result = await probePeer(peer);

      expect(result).toBeNull();
    });
  });

  describe('probeAllPeers', () => {
    it('should skip probing when no enabled peers', async () => {
      readJSONFile.mockResolvedValue({ self: null, peers: [] });

      await probeAllPeers();

      expect(fetch).not.toHaveBeenCalled();
    });

    it('should only probe enabled peers', async () => {
      const peers = [
        { id: 'p1', address: '10.0.0.1', port: 5555, name: 'h1', enabled: true, status: 'unknown' },
        { id: 'p2', address: '10.0.0.2', port: 5555, name: 'h2', enabled: false, status: 'unknown' }
      ];
      readJSONFile.mockResolvedValue({ self: null, peers });

      // Probe will call fetch for enabled peer only
      fetch.mockRejectedValue(new Error('offline'));

      await probeAllPeers();

      // Only 3 fetch calls for p1 (health, apps, sync), not 6
      expect(fetch).toHaveBeenCalledTimes(3);
    });
  });

  // --- Query Proxy ---

  describe('queryPeer', () => {
    it('should proxy request to peer and return data', async () => {
      const peers = [{ id: 'peer-1', address: '10.0.0.1', port: 5555 }];
      readJSONFile.mockResolvedValue({ self: null, peers });

      const mockData = { apps: ['app1'] };
      fetch.mockResolvedValue({ json: () => Promise.resolve(mockData) });

      const result = await queryPeer('peer-1', '/api/apps');

      expect(result).toEqual({ success: true, data: mockData });
      expect(fetch).toHaveBeenCalledWith(
        'http://10.0.0.1:5555/api/apps',
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
    });

    it('should return error for non-existent peer', async () => {
      readJSONFile.mockResolvedValue({ self: null, peers: [] });

      const result = await queryPeer('missing', '/api/apps');

      expect(result).toEqual({ error: 'Peer not found' });
      expect(fetch).not.toHaveBeenCalled();
    });

    it('should return error when fetch fails', async () => {
      const peers = [{ id: 'peer-1', address: '10.0.0.1', port: 5555 }];
      readJSONFile.mockResolvedValue({ self: null, peers });

      fetch.mockRejectedValue(new Error('Connection refused'));

      const result = await queryPeer('peer-1', '/api/health');

      expect(result).toEqual({ error: 'Failed to query peer: Connection refused' });
    });
  });

  // --- Announce (Bidirectional Registration) ---

  describe('handleAnnounce', () => {
    it('should create a new peer from announcement', async () => {
      readJSONFile.mockResolvedValue({ self: null, peers: [] });
      // probePeer will call fetch
      fetch.mockRejectedValue(new Error('offline'));

      const result = await handleAnnounce({
        address: '10.0.0.5',
        port: 5555,
        instanceId: 'remote-instance',
        name: 'remote-host'
      });

      expect(result.created).toBe(true);
      expect(result.peer).toMatchObject({
        address: '10.0.0.5',
        port: 5555,
        instanceId: 'remote-instance',
        name: 'remote-host',
        enabled: true,
        directions: ['inbound']
      });
      // Note: status not asserted — handleAnnounce fires async probePeer which may change it
      expect(instanceEvents.emit).toHaveBeenCalledWith('peers:updated', expect.any(Array));
    });

    it('should update existing peer matched by instanceId but preserve user-set name', async () => {
      const existing = {
        id: 'p1',
        address: '10.0.0.5',
        port: 5555,
        instanceId: 'remote-instance',
        name: 'custom-name',
        status: 'offline',
        directions: ['outbound']
      };
      readJSONFile.mockResolvedValue({ self: null, peers: [existing] });

      const result = await handleAnnounce({
        address: '10.0.0.5',
        port: 5555,
        instanceId: 'remote-instance',
        name: 'remote-hostname'
      });

      expect(result.created).toBe(false);
      expect(result.peer.name).toBe('custom-name'); // user-set name preserved
      expect(result.peer.status).toBe('online');
      expect(result.peer.directions).toContain('inbound');
      expect(result.peer.directions).toContain('outbound');
    });

    it('should auto-update name from announce when current name is an IP', async () => {
      const existing = {
        id: 'p1',
        address: '10.0.0.5',
        port: 5555,
        instanceId: 'remote-instance',
        name: '10.0.0.5',
        status: 'offline',
        directions: ['outbound']
      };
      readJSONFile.mockResolvedValue({ self: null, peers: [existing] });

      const result = await handleAnnounce({
        address: '10.0.0.5',
        port: 5555,
        instanceId: 'remote-instance',
        name: 'remote-hostname'
      });

      expect(result.created).toBe(false);
      expect(result.peer.name).toBe('remote-hostname'); // IP auto-updated to hostname
      expect(result.peer.status).toBe('online');
    });

    it('should match existing peer by address+port when instanceId differs', async () => {
      const existing = {
        id: 'p1',
        address: '10.0.0.5',
        port: 5555,
        instanceId: null,
        name: 'host',
        status: 'unknown',
        directions: []
      };
      readJSONFile.mockResolvedValue({ self: null, peers: [existing] });

      const result = await handleAnnounce({
        address: '10.0.0.5',
        port: 5555,
        instanceId: 'new-id',
        name: 'host'
      });

      expect(result.created).toBe(false);
      expect(result.peer.instanceId).toBe('new-id');
      expect(result.peer.directions).toContain('inbound');
    });

    it('should preserve user-set name on announce even with NaN hostname', async () => {
      const existing = {
        id: 'p1',
        address: '10.0.0.5',
        port: 5555,
        instanceId: 'remote',
        name: 'good-name',
        status: 'offline',
        directions: []
      };
      readJSONFile.mockResolvedValue({ self: null, peers: [existing] });

      const result = await handleAnnounce({
        address: '10.0.0.5',
        port: 5555,
        instanceId: 'remote',
        name: 'NaN'
      });

      // Name preserved because 'good-name' is not an IP address
      expect(result.peer.name).toBe('good-name');
    });

    it('should not duplicate inbound direction on re-announce', async () => {
      const existing = {
        id: 'p1',
        address: '10.0.0.5',
        port: 5555,
        instanceId: 'remote',
        name: 'host',
        status: 'online',
        directions: ['inbound']
      };
      readJSONFile.mockResolvedValue({ self: null, peers: [existing] });

      const result = await handleAnnounce({
        address: '10.0.0.5',
        port: 5555,
        instanceId: 'remote',
        name: 'host'
      });

      const inboundCount = result.peer.directions.filter(d => d === 'inbound').length;
      expect(inboundCount).toBe(1);
    });

    it('should store host on a new peer announced over Tailscale', async () => {
      readJSONFile.mockResolvedValue({ self: null, peers: [] });
      fetch.mockRejectedValue(new Error('offline'));

      const result = await handleAnnounce({
        address: '100.111.11.146',
        port: 5555,
        instanceId: 'remote-instance',
        name: 'null',
        host: 'null.taile8179.ts.net'
      });

      expect(result.created).toBe(true);
      expect(result.peer.host).toBe('null.taile8179.ts.net');
    });

    it('should learn host on existing peer when previously absent', async () => {
      const existing = {
        id: 'p1',
        address: '100.111.11.146',
        port: 5555,
        instanceId: 'remote-instance',
        name: 'null',
        host: null,
        status: 'offline',
        directions: ['outbound']
      };
      readJSONFile.mockResolvedValue({ self: null, peers: [existing] });

      const result = await handleAnnounce({
        address: '100.111.11.146',
        port: 5555,
        instanceId: 'remote-instance',
        name: 'null',
        host: 'null.taile8179.ts.net'
      });

      expect(result.peer.host).toBe('null.taile8179.ts.net');
    });

    it('should not overwrite a user-set host on existing peer', async () => {
      const existing = {
        id: 'p1',
        address: '100.111.11.146',
        port: 5555,
        instanceId: 'remote-instance',
        name: 'null',
        host: 'manual.example.ts.net',
        status: 'online',
        directions: ['outbound']
      };
      readJSONFile.mockResolvedValue({ self: null, peers: [existing] });

      const result = await handleAnnounce({
        address: '100.111.11.146',
        port: 5555,
        instanceId: 'remote-instance',
        name: 'null',
        host: 'auto.different.ts.net'
      });

      expect(result.peer.host).toBe('manual.example.ts.net');
    });

    it('should not re-adopt host on cleared peer when hostManual is true', async () => {
      // Reproduces the original "can't undo Tailnet DNS" bug: user cleared
      // peer.host, but the next inbound announce silently re-adopted the DNS
      // name because the only safeguard was "is existing.host empty?".
      const existing = {
        id: 'p1',
        address: '100.111.11.146',
        port: 5555,
        instanceId: 'remote-instance',
        name: 'null',
        host: null,
        hostManual: true,
        status: 'offline',
        directions: ['outbound']
      };
      readJSONFile.mockResolvedValue({ self: null, peers: [existing] });

      const result = await handleAnnounce({
        address: '100.111.11.146',
        port: 5555,
        instanceId: 'remote-instance',
        name: 'null',
        host: 'null.taile8179.ts.net'
      });

      expect(result.peer.host).toBeNull();
      expect(result.peer.hostManual).toBe(true);
    });

    it('should still learn host on a fresh peer when hostManual is unset', async () => {
      // Auto-learn must remain the default for never-touched peers — only
      // explicit user intervention should latch hostManual.
      const existing = {
        id: 'p1',
        address: '100.111.11.146',
        port: 5555,
        instanceId: 'remote-instance',
        name: 'null',
        host: null,
        status: 'offline',
        directions: ['outbound']
      };
      readJSONFile.mockResolvedValue({ self: null, peers: [existing] });

      const result = await handleAnnounce({
        address: '100.111.11.146',
        port: 5555,
        instanceId: 'remote-instance',
        name: 'null',
        host: 'null.taile8179.ts.net'
      });

      expect(result.peer.host).toBe('null.taile8179.ts.net');
    });

    it('should drop invalid host strings via validHost', async () => {
      readJSONFile.mockResolvedValue({ self: null, peers: [] });
      fetch.mockRejectedValue(new Error('offline'));

      const result = await handleAnnounce({
        address: '100.111.11.146',
        port: 5555,
        instanceId: 'remote-instance',
        name: 'null',
        host: 'has spaces and:colons'
      });

      expect(result.peer.host).toBeNull();
    });
  });

  // --- Polling ---

  describe('startPolling / stopPolling', () => {
    let logSpy;

    beforeEach(() => {
      logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
      logSpy.mockRestore();
    });

    // startPolling now defers to an async gate (loadData + Tailscale check);
    // flush the resolved-promise chain so the gate reaches beginPolling().
    const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
    const logged = (frag) => logSpy.mock.calls.some(c => String(c[0]).includes(frag));

    it('starts polling immediately with no peers (solo install), without probing Tailscale', async () => {
      readJSONFile.mockResolvedValue({ self: null, peers: [] });
      getTailscaleStatus.mockResolvedValue({ running: false, state: 'Stopped', reason: 'tailscale-stopped' });

      startPolling();
      await flush();

      expect(logged('Instance polling started')).toBe(true);
      // No peers → never even asks Tailscale.
      expect(getTailscaleStatus).not.toHaveBeenCalled();
      stopPolling();
    });

    it('starts polling when tailnet peers exist and Tailscale is connected', async () => {
      readJSONFile.mockResolvedValue({ self: null, peers: [{ id: 'p1', enabled: true, host: 'p1.tailnet.ts.net' }] });
      getTailscaleStatus.mockResolvedValue({ running: true, state: 'Running', reason: 'running' });

      startPolling();
      await flush();

      expect(getTailscaleStatus).toHaveBeenCalled();
      expect(logged('Instance polling started')).toBe(true);
      expect(logged('Peer sync deferred')).toBe(false);
      stopPolling();
    });

    it('probes immediately for a LAN/IP peer even when Tailscale is down (never stranded)', async () => {
      // A peer addressed by a plain LAN IP (no MagicDNS host, not a CGNAT addr)
      // is reachable without Tailscale, so the gate must not defer it.
      readJSONFile.mockResolvedValue({ self: null, peers: [{ id: 'lan', enabled: true, address: '192.168.1.50' }] });
      getTailscaleStatus.mockResolvedValue({ running: false, state: 'Stopped', reason: 'tailscale-stopped' });

      startPolling();
      await flush();

      expect(logged('Instance polling started')).toBe(true);
      expect(logged('Peer sync deferred')).toBe(false);
      // A non-tailnet peer means we don't even need to ask Tailscale.
      expect(getTailscaleStatus).not.toHaveBeenCalled();
      stopPolling();
    });

    it('defers polling when all peers are tailnet-only and Tailscale is down, then starts once it comes up', async () => {
      readJSONFile.mockResolvedValue({ self: null, peers: [{ id: 'p1', enabled: true, host: 'p1.tailnet.ts.net' }] });
      getTailscaleStatus.mockResolvedValue({ running: false, state: 'Stopped', reason: 'tailscale-stopped' });

      startPolling();
      await flush();

      expect(logged('Peer sync deferred')).toBe(true);
      expect(logged('Instance polling started')).toBe(false);

      // Tailscale connects; the recheck watcher should pick it up and start polling.
      getTailscaleStatus.mockResolvedValue({ running: true, state: 'Running', reason: 'running' });
      await vi.advanceTimersByTimeAsync(60_000);
      await flush();

      expect(logged('Tailscale connected — starting peer sync polling')).toBe(true);
      expect(logged('Instance polling started')).toBe(true);
      stopPolling();
    });

    it('does not start twice', async () => {
      readJSONFile.mockResolvedValue({ self: null, peers: [] });

      startPolling();
      startPolling(); // second call should be a no-op
      await flush();

      const starts = logSpy.mock.calls.filter(c => String(c[0]).includes('Instance polling started')).length;
      expect(starts).toBe(1);
      stopPolling();
    });

    it('stop clears a pending Tailscale watch so it never starts polling later', async () => {
      readJSONFile.mockResolvedValue({ self: null, peers: [{ id: 'p1', enabled: true, host: 'p1.tailnet.ts.net' }] });
      getTailscaleStatus.mockResolvedValue({ running: false, state: 'Stopped', reason: 'tailscale-stopped' });

      startPolling();
      await flush();
      expect(logged('Peer sync deferred')).toBe(true);

      stopPolling();
      stopPolling(); // double stop should be safe

      // Even if Tailscale comes up after stop, the (cleared) watcher must not fire.
      getTailscaleStatus.mockResolvedValue({ running: true, state: 'Running', reason: 'running' });
      await vi.advanceTimersByTimeAsync(60_000);
      await flush();

      expect(logged('Instance polling started')).toBe(false);
    });

    it('aborts startup if stopPolling is called during the async gate window', async () => {
      readJSONFile.mockResolvedValue({ self: null, peers: [{ id: 'p1', enabled: true, host: 'p1.tailnet.ts.net' }] });
      getTailscaleStatus.mockResolvedValue({ running: true, state: 'Running', reason: 'running' });

      startPolling();      // kicks off the async gate (loadData → getTailscaleStatus)
      stopPolling();       // lands before the gate resolves — must cancel it
      await flush();

      // The generation bump makes the resolving gate bail before beginPolling().
      expect(logged('Instance polling started')).toBe(false);

      // And a fresh start afterward still works (state wasn't left wedged).
      startPolling();
      await flush();
      expect(logged('Instance polling started')).toBe(true);
      stopPolling();
    });
  });
});
