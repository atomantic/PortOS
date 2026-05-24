/**
 * Shared `vi.mock` factory for the "PATHS.data → temp dir" pattern.
 *
 * Eight (and growing) test files duplicated the same Proxy-over-fileUtils
 * mock to redirect `PATHS.data` at a per-test temp directory:
 *
 *     vi.mock('../../lib/fileUtils.js', async () => {
 *       const actual = await vi.importActual('../../lib/fileUtils.js');
 *       return new Proxy(actual, {
 *         get(target, prop) {
 *           if (prop === 'PATHS') return { ...actual.PATHS, data: tempRoot };
 *           return target[prop];
 *         },
 *       });
 *     });
 *
 * This module gives the same behavior via a single helper. The relative path
 * to `fileUtils.js` stays at each call site because `vi.mock` is hoisted to
 * module top before any test code runs — Vitest must see a string literal to
 * a real file from the *test's* directory. The helper computes the temp dir
 * and exposes a Proxy factory; the caller still writes the one-liner
 * `vi.mock(...)` so Vitest's hoister can find it. See `mockPathsDataRoot()`
 * below for the canonical usage example.
 *
 * To keep the call site short and avoid forcing every test to write the Proxy
 * block, this module exports:
 *
 *   - `makePathsProxy(actual, { dataRoot, extraOverrides? })` — used inside
 *     the test's own `vi.mock` factory. Returns the Proxy.
 *   - `createTempDataRoot()` — returns `{ tempRoot }` allocated under os.tmpdir().
 *   - `mockNoPeers(actual?, overrides?)` — shared `instances.js` mock guard
 *     for record-creating tests that should never auto-subscribe to live peers.
 *   - `mockNoPeerSync(actual?, overrides?)` — shared `peerSync.js` mock guard
 *     that makes fire-and-forget record auto-subscribe a clean no-op in tests.
 *
 * Migration: tests that need MULTIPLE PATHS members redirected
 * (e.g. `images`, `videos`) can pass `extraOverrides` (object or function)
 * — the helper merges those on top of the `data: tempRoot` override.
 */

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * Allocate a unique temp dir suitable for use as `PATHS.data` in a test file.
 * Caller is responsible for cleanup (`rmSync` in afterAll) when needed.
 */
export function createTempDataRoot(prefix = 'portos-test-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * Build the Proxy returned from a `vi.mock('../lib/fileUtils.js', ...)`
 * factory. Pass the already-resolved `actual` (from `vi.importActual`) and
 * the `dataRoot` you want `PATHS.data` to point at.
 *
 * `dataRoot` accepts either:
 *   - a string — captured by value at construction time, or
 *   - a function `() => string` — resolved lazily on each PATHS read. Use
 *     the function form when the test allocates a fresh temp dir per test
 *     (a `let tempRoot` that the per-test setup reassigns). The Proxy reads
 *     it through the getter so it always sees the current value.
 *
 * `extraOverrides` is either:
 *   - a plain object — merged over `{ data: <resolved root> }`, or
 *   - a function `(dataRoot) => overridesObject` — for cases where the
 *     extra keys are derived (e.g. `images: join(dataRoot, 'images')`).
 */
export function makePathsProxy(actual, { dataRoot, extraOverrides = null, overrides = null } = {}) {
  const resolveRoot = typeof dataRoot === 'function' ? dataRoot : () => dataRoot;
  const buildOverrides = () => {
    const root = resolveRoot();
    const extras = typeof extraOverrides === 'function'
      ? extraOverrides(root)
      : (extraOverrides || {});
    return { ...actual.PATHS, data: root, ...extras };
  };
  return new Proxy(actual, {
    get(target, prop) {
      if (prop === 'PATHS') return buildOverrides();
      // Top-level export overrides (e.g. a delegating spy for atomicWrite).
      // Served through the get trap so callers never vi.spyOn a read-only
      // ESM namespace export — see mockPathsDataRoot's wrapExports option.
      if (overrides && prop in overrides) return overrides[prop];
      return target[prop];
    },
  });
}

/**
 * Build an `instances.js` mock that disables peer auto-subscribe fan-out.
 *
 * `createUniverse` / `createSeries` fire a non-awaited peerSync import after
 * record creation. In tests, that background path can outlive local fileUtils
 * mocks and read the real peer registry unless `getPeers` is explicitly
 * guarded. Pass the real module as `actual` when a suite needs the other
 * exports, and pass `overrides` for test-specific exports like getInstanceId.
 */
export function mockNoPeers(actual = {}, overrides = {}) {
  return {
    UNKNOWN_INSTANCE_ID: 'unknown',
    getInstanceId: () => Promise.resolve('test-instance'),
    ...actual,
    getPeers: () => Promise.resolve([]),
    ...overrides,
  };
}

/**
 * Build a `sharing/peerSync.js` mock that disables create-time peer fan-out.
 *
 * This is intentionally separate from `mockNoPeers`: stubbing `getPeers → []`
 * prevents live registry reads once `peerSync.js` loads, while this helper
 * prevents record-creating tests from loading the peer-sync module graph at
 * all through the fire-and-forget dynamic import.
 */
export function mockNoPeerSync(actual = {}, overrides = {}) {
  return {
    ...actual,
    autoSubscribeRecordToAllPeers: () => Promise.resolve([]),
    unsubscribeAllForRecord: () => Promise.resolve({ removed: [], failed: [] }),
    ...overrides,
  };
}

/**
 * Convenience wrapper for the most-common case: a single per-file temp dir
 * plus a Proxy factory. Returns `{ tempRoot, makeProxy, cleanup }` where
 * `makeProxy(actual)` is called from the test's `vi.mock` factory.
 *
 * Example:
 *
 *     import { mockPathsDataRoot } from '../lib/mockPathsDataRoot.js';
 *     const { tempRoot, makeProxy, cleanup } = mockPathsDataRoot();
 *     vi.mock('../lib/fileUtils.js', async () => {
 *       const actual = await vi.importActual('../lib/fileUtils.js');
 *       return makeProxy(actual);
 *     });
 *     afterAll(cleanup);
 *
 * To inspect call counts on a fileUtils export (e.g. atomicWrite) WITHOUT
 * `vi.spyOn`-ing a read-only ESM namespace export, pass `wrapExports` plus
 * `makeSpy: vi.fn` (the test owns vitest; this module stays vitest-free since
 * it's barrel-exported and runtime-loaded). The wrapped exports are exposed
 * on the returned `spies` map, each a vi.fn delegating to the real impl:
 *
 *     const { makeProxy, spies, cleanup } = mockPathsDataRoot({
 *       wrapExports: ['atomicWrite'], makeSpy: vi.fn,
 *     });
 *     // ...later: spies.atomicWrite.mock.calls
 */
export function mockPathsDataRoot({
  prefix = 'portos-test-',
  extraOverrides = null,
  wrapExports = [],
  makeSpy = null,
} = {}) {
  const tempRoot = createTempDataRoot(prefix);
  const spies = {};
  return {
    tempRoot,
    spies,
    makeProxy: (actual) => {
      const overrides = {};
      if (wrapExports.length) {
        if (typeof makeSpy !== 'function') {
          throw new Error('mockPathsDataRoot: wrapExports requires a makeSpy (pass vi.fn)');
        }
        for (const name of wrapExports) {
          spies[name] = makeSpy((...args) => actual[name](...args));
          overrides[name] = spies[name];
        }
      }
      return makePathsProxy(actual, { dataRoot: tempRoot, extraOverrides, overrides });
    },
    cleanup: () => rmSync(tempRoot, { recursive: true, force: true }),
  };
}
