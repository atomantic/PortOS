import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Source of instanceIdentity.js, for a source-level assertion that doesn't
// execute the module (avoids the vitest worker-teardown console-RPC flake
// that running the identity-creation path under resetModules + fake timers
// can trigger). Split out of instances.test.js by #6836, which moved this
// module's self-identity + file-I/O implementation out of services/instances.js.
const INSTANCE_IDENTITY_SRC = readFileSync(
  fileURLToPath(new URL('./instanceIdentity.js', import.meta.url)), 'utf8'
);

// Mock dependencies before importing the module
vi.mock('fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('../lib/fileUtils.js', async (importOriginal) => ({
  ...(await importOriginal()),
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

import { readJSONFile } from '../lib/fileUtils.js';
import {
  ensureSelf,
  getSelf,
  getInstanceId,
  ensureInstanceId,
  updateSelf,
} from './instanceIdentity.js';

describe('instanceIdentity.js', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readJSONFile.mockResolvedValue({ self: null, peers: [] });
  });

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
      expect(INSTANCE_IDENTITY_SRC).toMatch(/export async function ensureInstanceId\(\)/);
    });

    it('reads getInstanceId, guards the unknown sentinel, and falls back to ensureSelf on the cold path', () => {
      const start = INSTANCE_IDENTITY_SRC.indexOf('export async function ensureInstanceId');
      const body = INSTANCE_IDENTITY_SRC.slice(start, start + 600);
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

    // Moved from instances.test.js's "fullSync (full-mirror) peer mode" block
    // (#6836) — it exercises updateSelf's defaultPeerFullSync field, which
    // instances.js's addPeer reads to seed a new peer's fullSync default, but
    // the function itself lives here now.
    it('persists the new-peer full-sync default', async () => {
      readJSONFile.mockResolvedValue({ self: { instanceId: 'me', name: 'box' }, peers: [] });
      const self = await updateSelf(undefined, { defaultPeerFullSync: true });
      expect(self.defaultPeerFullSync).toBe(true);
      expect(self.name).toBe('box'); // name untouched when omitted
    });
  });
});
