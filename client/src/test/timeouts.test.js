// @vitest-environment node
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { describe, expect, it } from 'vitest';
import { getConfig } from '@testing-library/dom';

import { trackedTestFiles } from './trackedFiles.js';
import { ASYNC_UTIL_TIMEOUT_MS, TEST_TIMEOUT_MS } from './timeouts.js';
import vitestConfig from '../../vitest.config.js';

const CLIENT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * A lone-key `{ timeout: N }` — the shape `waitFor(fn, { timeout })` and
 * `findBy*(text, {}, { timeout })` take. Deliberately does NOT match a fixture
 * object carrying a `timeout` field beside other keys (the provider records in
 * `src/utils/providers.test.js` hold `{ id, timeout }`), which is data rather
 * than an async bound.
 */
const LONE_TIMEOUT_OPTION = /\{\s*timeout:\s*([\d_]+)\s*\}/g;

/**
 * Inline async bounds in `source` that the enclosing budget would cut short —
 * the test dies first, so the extended wait never happens and the failure names
 * nothing. Exported so the bypass probe below can prove the detector still
 * fires; a guard whose detector has quietly stopped matching passes forever.
 *
 * Scope is deliberately one-sided. A bound TIGHTER than the suite-wide async
 * budget is a legitimate (if easy to forget) local choice — several tests assert
 * that something settles fast — while a bound at or above the enclosing budget
 * is inert in every case, which is the one that actually shipped.
 *
 * A file that raises its own budget with `vi.setConfig` is skipped: its real
 * ceiling is a per-file expression this cannot evaluate.
 */
export function inertTimeoutBounds(source, budgetMs = TEST_TIMEOUT_MS) {
  if (source.includes('vi.setConfig(')) return [];
  return [...source.matchAll(LONE_TIMEOUT_OPTION)]
    .map(([, digits]) => digits)
    .filter((digits) => Number(digits.replace(/_/g, '')) >= budgetMs);
}

describe('client suite time budgets', () => {
  it('applies the shared async budget inside the budgets that enclose it', () => {
    // The EFFECTIVE values, not the module's own constants: `TEST_TIMEOUT_MS >
    // ASYNC_UTIL_TIMEOUT_MS` is unfalsifiable given the `* 3` that derives one
    // from the other, which is the same vacuous shape this file exists to
    // police. What can actually drift is the wiring — setup.js failing to apply
    // the budget, or vitest.config.js growing a hardcoded timeout beside it.
    expect(getConfig().asyncUtilTimeout).toBe(ASYNC_UTIL_TIMEOUT_MS);
    expect(vitestConfig.test.testTimeout).toBeGreaterThan(getConfig().asyncUtilTimeout);
    expect(vitestConfig.test.hookTimeout).toBeGreaterThan(getConfig().asyncUtilTimeout);
  });

  it('has no inline async bound the enclosing budget would cut short', () => {
    // `BeeperTab.test.jsx` carried `{ timeout: 15000 }` against a 5000ms budget
    // for exactly this reason (#7448) — it read as a fix and was not one.
    const files = trackedTestFiles(CLIENT_ROOT);
    // A broken `git ls-files` would otherwise make this guard pass by scanning
    // nothing at all.
    expect(files.length).toBeGreaterThan(500);

    const offenders = files.flatMap((file) => (
      inertTimeoutBounds(readFileSync(join(CLIENT_ROOT, file), 'utf8'))
        .map((digits) => `${file}: { timeout: ${digits} }`)
    ));
    expect(offenders).toEqual([]);
  });

  it('still detects an inert bound, a tight one, and an opted-out file', () => {
    // The bypass probe: without it, a detector that stopped matching anything
    // would report a clean tree forever.
    expect(inertTimeoutBounds('await waitFor(fn, { timeout: 15000 });')).toEqual(['15000']);
    expect(inertTimeoutBounds('await waitFor(fn, { timeout: 2000 });')).toEqual([]);
    expect(inertTimeoutBounds('vi.setConfig({ testTimeout: 60000 });\nwaitFor(fn, { timeout: 30000 });')).toEqual([]);
    // Fixture data that merely carries a `timeout` field is not an async bound.
    expect(inertTimeoutBounds("const p = { id: 'p1', timeout: 300000 };")).toEqual([]);
  });
});
