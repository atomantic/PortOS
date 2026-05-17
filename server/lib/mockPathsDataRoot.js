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
export function makePathsProxy(actual, { dataRoot, extraOverrides = null } = {}) {
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
      return target[prop];
    },
  });
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
 */
export function mockPathsDataRoot({ prefix = 'portos-test-', extraOverrides = null } = {}) {
  const tempRoot = createTempDataRoot(prefix);
  return {
    tempRoot,
    makeProxy: (actual) => makePathsProxy(actual, { dataRoot: tempRoot, extraOverrides }),
    cleanup: () => rmSync(tempRoot, { recursive: true, force: true }),
  };
}
