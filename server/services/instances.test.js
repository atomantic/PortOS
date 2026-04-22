import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock dependencies before importing the module
vi.mock('fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('../lib/fileUtils.js', () => ({
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

// fetch is stubbed per-test in beforeEach and restored in afterEach

import { readJSONFile } from '../lib/fileUtils.js';
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
  startPolling,
  stopPolling
} from './instances.js';

describe('instances.js', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn());
    readJSONFile.mockResolvedValue({ self: null, peers: [] });
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
  });

  // --- Polling ---

  describe('startPolling / stopPolling', () => {
    it('should start polling and not start twice', () => {
      readJSONFile.mockResolvedValue({ self: null, peers: [] });

      startPolling();
      startPolling(); // second call should be no-op

      // Advance past initial probe delay
      vi.advanceTimersByTime(2000);

      stopPolling();
    });

    it('should stop polling cleanly', () => {
      startPolling();
      stopPolling();
      stopPolling(); // double stop should be safe
    });
  });
});
