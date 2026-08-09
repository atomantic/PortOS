import { describe, it, expect, afterAll } from 'vitest';
import { existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, relative, sep } from 'path';
import { createTempDataRoot, makePathsProxy, mockNoPeers, mockNoPeerSync, mockPathsDataRoot } from './mockPathsDataRoot.js';

describe('mockPathsDataRoot', () => {
  describe('createTempDataRoot', () => {
    const created = [];
    afterAll(() => created.forEach((d) => rmSync(d, { recursive: true, force: true })));

    it('returns a path under the OS temp dir', () => {
      const dir = createTempDataRoot('portos-mockpaths-test-');
      created.push(dir);
      expect(dir).toMatch(/portos-mockpaths-test-/);
      expect(dir.startsWith(tmpdir())).toBe(true);
      expect(existsSync(dir)).toBe(true);
    });

    it('returns distinct paths on successive calls', () => {
      const a = createTempDataRoot('mp-distinct-');
      const b = createTempDataRoot('mp-distinct-');
      created.push(a, b);
      expect(a).not.toBe(b);
    });
  });

  describe('makePathsProxy', () => {
    const fakeActual = {
      PATHS: {
        data: join('/real', 'data'),
        images: join('/real', 'data', 'images'),
        cosAgents: join('/real', 'data', 'cos', 'agents'),
        // Outside data/ — must survive untouched, like PATHS.root / slashdo /
        // browserDownloads do in the real fileUtils.
        logs: join('/real', 'logs'),
        // A near-miss sibling: `data-archive` shares the `data` PREFIX but is
        // not INSIDE data/, so it must not be re-rooted.
        dataArchive: join('/real', 'data-archive'),
      },
      ensureDir: () => 'ensureDir-fn',
      otherFn: 42,
    };
    const TMP = join('/tmp', 'x');

    it('re-roots every PATHS member that lives under the real data/ dir', () => {
      const proxy = makePathsProxy(fakeActual, { dataRoot: TMP });
      expect(proxy.PATHS.data).toBe(TMP);
      expect(proxy.PATHS.images).toBe(join(TMP, 'images'));
      expect(proxy.PATHS.cosAgents).toBe(join(TMP, 'cos', 'agents'));
    });

    it('leaves PATHS members outside data/ alone, including prefix near-misses', () => {
      const proxy = makePathsProxy(fakeActual, { dataRoot: TMP });
      expect(proxy.PATHS.logs).toBe(join('/real', 'logs'));
      expect(proxy.PATHS.dataArchive).toBe(join('/real', 'data-archive'));
    });

    it('re-roots the real fileUtils PATHS so no member still points into the live install', async () => {
      const { PATHS } = await import('./fileUtils.js');
      const proxy = makePathsProxy({ PATHS }, { dataRoot: TMP });
      const dataRooted = Object.entries(PATHS)
        .filter(([, v]) => typeof v === 'string' && (v === PATHS.data || v.startsWith(PATHS.data + sep)));

      // Guard against a vacuous assertion if PATHS is ever restructured.
      expect(dataRooted.length).toBeGreaterThan(40);
      for (const [key] of dataRooted) {
        expect(`${key}=${proxy.PATHS[key]}`).toBe(`${key}=${join(TMP, relative(PATHS.data, PATHS[key]))}`);
      }
      // The four members that live outside data/ are untouched by construction.
      for (const key of ['root', 'installRoot', 'slashdo', 'browserDownloads']) {
        expect(proxy.PATHS[key]).toBe(PATHS[key]);
      }
    });

    it('passes non-PATHS exports through untouched', () => {
      const proxy = makePathsProxy(fakeActual, { dataRoot: '/tmp/x' });
      expect(proxy.ensureDir()).toBe('ensureDir-fn');
      expect(proxy.otherFn).toBe(42);
    });

    it('extraOverrides (object) merges over the default { data } override', () => {
      const proxy = makePathsProxy(fakeActual, {
        dataRoot: '/tmp/x',
        extraOverrides: { images: '/tmp/x/images', videos: '/tmp/x/videos' },
      });
      expect(proxy.PATHS.data).toBe('/tmp/x');
      expect(proxy.PATHS.images).toBe('/tmp/x/images');
      expect(proxy.PATHS.videos).toBe('/tmp/x/videos');
      expect(proxy.PATHS.logs).toBe('/real/logs'); // untouched
    });

    it('extraOverrides (function) receives the dataRoot', () => {
      const proxy = makePathsProxy(fakeActual, {
        dataRoot: '/tmp/x',
        extraOverrides: (root) => ({ images: join(root, 'images') }),
      });
      expect(proxy.PATHS.images).toBe('/tmp/x/images');
    });

    it('dataRoot (function) resolves lazily on each PATHS read', () => {
      let current = '/initial';
      const proxy = makePathsProxy(fakeActual, { dataRoot: () => current });
      expect(proxy.PATHS.data).toBe('/initial');
      current = '/after-mutation';
      expect(proxy.PATHS.data).toBe('/after-mutation');
    });
  });

  describe('mockPathsDataRoot wrapper', () => {
    it('returns a tempRoot + makeProxy + cleanup triple', () => {
      const { tempRoot, makeProxy, cleanup } = mockPathsDataRoot({ prefix: 'mp-wrap-' });
      expect(existsSync(tempRoot)).toBe(true);
      const proxy = makeProxy({ PATHS: { data: 'orig', logs: 'l' } });
      expect(proxy.PATHS.data).toBe(tempRoot);
      expect(proxy.PATHS.logs).toBe('l');
      cleanup();
      expect(existsSync(tempRoot)).toBe(false);
    });
  });

  describe('mockNoPeers', () => {
    it('preserves instances exports while forcing getPeers to []', async () => {
      const mock = mockNoPeers(
        { getPeers: async () => [{ instanceId: 'real-peer' }], getInstanceId: async () => 'real-id' },
        { getInstanceId: async () => 'test-id' },
      );

      await expect(mock.getPeers()).resolves.toEqual([]);
      await expect(mock.getInstanceId()).resolves.toBe('test-id');
    });
  });

  describe('mockNoPeerSync', () => {
    it('preserves peerSync exports while forcing autoSubscribeRecordToAllPeers to []', async () => {
      const mock = mockNoPeerSync(
        { autoSubscribeRecordToAllPeers: async () => [{ peerId: 'real-peer' }], otherExport: 1 },
        { custom: true },
      );

      await expect(mock.autoSubscribeRecordToAllPeers()).resolves.toEqual([]);
      await expect(mock.unsubscribeAllForRecord()).resolves.toEqual({ removed: [], failed: [] });
      expect(mock.otherExport).toBe(1);
      expect(mock.custom).toBe(true);
    });
  });
});
