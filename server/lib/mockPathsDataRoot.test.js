import { describe, it, expect, afterAll } from 'vitest';
import { posixPath } from './testHelper.js';

import { existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, sep } from 'path';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { createTempDataRoot, makePathsProxy, mockNoPeers, mockNoPeerSync, mockPathsDataRoot, ownTestBodies } from './mockPathsDataRoot.js';

describe('ownTestBodies cancellation ordering (#11641)', () => {
  // These controls also write real fixtures: own their outer Vitest bodies,
  // not only the simulated cancelled bodies they exercise below.
  const controls = ownTestBodies(it);
  afterAll(() => controls.drain());
  const lateWriteControl = tracked => async () => {
    const root = createTempDataRoot('portos-owned-body-');
    const controller = new AbortController();
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    let registered;
    const owned = ownTestBodies((_name, body) => { registered = body; });
    const writeLate = async () => {
      entered.resolve();
      await release.promise;
      await mkdir(root, { recursive: true });
      await writeFile(join(root, 'projection.json'), '{}');
    };
    owned.it('held write', writeLate);
    const body = tracked ? registered({ signal: controller.signal }) : writeLate();
    const cancelled = new Promise(resolve => controller.signal.addEventListener('abort', () => resolve('cancelled'), { once: true }));
    // Model the runner wrapper settling on cancellation, while the real body
    // is deterministically held at a write boundary rather than on a timer.
    const wrapper = Promise.race([body, cancelled]);
    let removing = false;
    let cleanup;
    try {
      await entered.promise;
      controller.abort();
      expect(await wrapper).toBe('cancelled');
      cleanup = (async () => {
        if (tracked) await owned.drain();
        removing = true;
        await rm(root, { recursive: true, force: true });
      })();
      if (tracked) {
        // Flush a resolved drain's continuation: a broken, early-resolving
        // drain must fail here rather than race the filesystem assertions.
        await Promise.resolve();
        expect(removing).toBe(false);
        expect(existsSync(root)).toBe(true);
      } else {
        await cleanup;
        expect(existsSync(root)).toBe(false);
      }
      release.resolve();
      await body;
      await cleanup;
      // Unowned cancellation recreates the removed fixture; ownership makes
      // the same write finish before removal, leaving nothing behind.
      expect(existsSync(join(root, 'projection.json'))).toBe(!tracked);
      expect(existsSync(root)).toBe(!tracked);
    } finally {
      release.resolve();
      // Preserve any assertion/body error while still settling both pieces
      // of owned work before the unconditional fixture removal.
      await Promise.allSettled([body, cleanup]);
      await rm(root, { recursive: true, force: true });
    }
  };
  for (const tracked of [false, true]) {
    controls.it(`bounds the late-write cleanup race with ownership=${tracked}`, lateWriteControl(tracked));
  }

  controls.it('reports a body failure after cancellation and still permits finally cleanup', async () => {
    const root = createTempDataRoot('portos-owned-failure-');
    const controller = new AbortController();
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    let registered;
    const owned = ownTestBodies((_name, body) => { registered = body; });
    const failure = new Error('synthetic late projection failure');
    owned.it('held failure', async () => { entered.resolve(); await release.promise; throw failure; });
    const observed = registered({ signal: controller.signal }).catch(error => error);
    let cleanup;
    try {
      await entered.promise;
      controller.abort();
      cleanup = (async () => {
        try { await owned.drain(); } finally { await rm(root, { recursive: true, force: true }); }
      })();
      const rejected = expect(cleanup).rejects.toMatchObject({ errors: [failure] });
      release.resolve();
      expect(await observed).toBe(failure);
      await rejected;
      expect(existsSync(root)).toBe(false);
    } finally {
      release.resolve();
      await Promise.allSettled([observed, cleanup]);
      await rm(root, { recursive: true, force: true });
    }
  });
});

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

      // Deliberately NOT the implementation's containment predicate — a plain
      // prefix match over the PROXIED values. It is a superset of what the
      // helper re-roots, so a member the helper failed to move is still caught
      // here rather than being filtered out of the expectation alongside it.
      const leaked = Object.entries(proxy.PATHS)
        .filter(([, v]) => typeof v === 'string' && v.startsWith(PATHS.data))
        .map(([k]) => k);
      expect(leaked).toEqual([]);

      // Hardcoded expectations — no shared derivation with the implementation.
      expect(proxy.PATHS.data).toBe(TMP);
      expect(proxy.PATHS.cos).toBe(join(TMP, 'cos'));
      expect(proxy.PATHS.cosAgents).toBe(join(TMP, 'cos', 'agents'));
      expect(proxy.PATHS.promptSkillsJobs).toBe(join(TMP, 'prompts', 'skills', 'jobs'));
      expect(proxy.PATHS.brainSongbook).toBe(join(TMP, 'brain', 'songbook'));
      expect(proxy.PATHS.digitalTwin).toBe(join(TMP, 'digital-twin'));

      // Non-vacuity: most of PATHS must actually have moved.
      const moved = Object.keys(PATHS).filter((k) => proxy.PATHS[k] !== PATHS[k]);
      expect(moved.length).toBeGreaterThan(40);

      // The four members that live outside data/ are untouched by construction.
      for (const key of ['root', 'installRoot', 'slashdo', 'browserDownloads']) {
        expect(proxy.PATHS[key]).toBe(PATHS[key]);
      }
    });

    it('handles a trailing separator on the real PATHS.data', () => {
      const trailing = { PATHS: { data: `/real/data${sep}`, images: '/real/data/images' } };
      const proxy = makePathsProxy(trailing, { dataRoot: TMP });
      expect(proxy.PATHS.images).toBe(join(TMP, 'images'));
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
      expect(posixPath(proxy.PATHS.data)).toBe('/tmp/x');
      expect(posixPath(proxy.PATHS.images)).toBe('/tmp/x/images');
      expect(posixPath(proxy.PATHS.videos)).toBe('/tmp/x/videos');
      expect(posixPath(proxy.PATHS.logs)).toBe('/real/logs'); // untouched
    });

    it('extraOverrides (function) receives the dataRoot', () => {
      const proxy = makePathsProxy(fakeActual, {
        dataRoot: '/tmp/x',
        extraOverrides: (root) => ({ images: join(root, 'images') }),
      });
      expect(posixPath(proxy.PATHS.images)).toBe('/tmp/x/images');
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
