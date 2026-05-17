import { describe, it, expect, afterAll } from 'vitest';
import { existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createTempDataRoot, makePathsProxy, mockPathsDataRoot } from './mockPathsDataRoot.js';

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
      PATHS: { data: '/real/data', images: '/real/images', logs: '/real/logs' },
      ensureDir: () => 'ensureDir-fn',
      otherFn: 42,
    };

    it('overrides only PATHS.data by default and passes other PATHS keys through', () => {
      const proxy = makePathsProxy(fakeActual, { dataRoot: '/tmp/x' });
      expect(proxy.PATHS.data).toBe('/tmp/x');
      expect(proxy.PATHS.images).toBe('/real/images');
      expect(proxy.PATHS.logs).toBe('/real/logs');
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
});
