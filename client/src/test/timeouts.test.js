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
/** This file's own path, as `trackedTestFiles` spells it. */
const SELF = 'src/test/timeouts.test.js';

/** A brace-delimited object literal with no nested braces, and its `key:` names. */
const FLAT_OBJECT = /\{([^{}]*)\}/g;
const OBJECT_KEYS = /(?:^|,)\s*([A-Za-z_$][\w$]*)\s*:/g;
/** `timeout: <number>` inside such an object. */
const TIMEOUT_KEY = /(?:^|,)\s*timeout:\s*([\d_]+)\s*(?:,|$)/;
/**
 * Every option `waitFor` / `findBy*` accept. An object whose keys are all in
 * here is an async bound; one carrying anything else is fixture data that
 * happens to hold a `timeout` field (`src/utils/providers.test.js` has
 * `{ id, timeout }`).
 */
const WAIT_FOR_OPTIONS = new Set([
  'timeout', 'interval', 'onTimeout', 'container', 'mutationObserverOptions',
  'ignore', 'showOriginalStackTrace', 'asyncUtilTimeout',
]);
/**
 * A file raising its own per-test budget. Matched on the `testTimeout` key
 * rather than the bare call, so a file that merely MENTIONS `vi.setConfig` — in
 * a comment, or in this file's own probes — is not silently exempted.
 */
const RAISES_OWN_BUDGET = /vi\.setConfig\(\s*\{[^{}]*\btestTimeout\b/;

/**
 * Inline async bounds in `source` that the enclosing budget would cut short —
 * the test dies first, so the extended wait never happens and the failure names
 * nothing. Exported so the bypass probe below can prove the detector still
 * fires; a guard whose detector has quietly stopped matching passes forever.
 *
 * Scope is deliberately one-sided. A bound TIGHTER than the suite-wide async
 * budget is a legitimate local choice — several tests assert that something
 * settles fast — while a bound at or above the enclosing budget is inert in
 * every case, which is the one that actually shipped.
 */
export function inertTimeoutBounds(source, budgetMs = TEST_TIMEOUT_MS) {
  if (RAISES_OWN_BUDGET.test(source)) return [];
  return [...source.matchAll(FLAT_OBJECT)]
    .map(([, body]) => body)
    .filter((body) => [...body.matchAll(OBJECT_KEYS)].every(([, key]) => WAIT_FOR_OPTIONS.has(key)))
    .map((body) => TIMEOUT_KEY.exec(body)?.[1])
    .filter((digits) => digits && Number(digits.replace(/_/g, '')) >= budgetMs);
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
    const files = trackedTestFiles(CLIENT_ROOT).filter((file) => file !== SELF);
    // A broken `git ls-files` would otherwise make this guard pass by scanning
    // nothing at all. Self is excluded above because the probes below are
    // deliberate offenders.
    expect(files.length).toBeGreaterThan(500);

    const offenders = files.flatMap((file) => (
      inertTimeoutBounds(readFileSync(join(CLIENT_ROOT, file), 'utf8'))
        .map((digits) => `${file}: { timeout: ${digits} }`)
    ));
    expect(offenders).toEqual([]);
  });

  it('still detects an inert bound however the option object is written', () => {
    // The bypass probe: without it, a detector that stopped matching anything
    // would report a clean tree forever.
    expect(inertTimeoutBounds('await waitFor(fn, { timeout: 15000 });')).toEqual(['15000']);
    // `interval` is the common co-key on a raised bound — a sole-key pattern
    // missed exactly the shape most likely to appear.
    expect(inertTimeoutBounds('await waitFor(fn, { timeout: 20000, interval: 50 });')).toEqual(['20000']);
    expect(inertTimeoutBounds('await waitFor(fn, { interval: 50, timeout: 20000 });')).toEqual(['20000']);
    expect(inertTimeoutBounds('await waitFor(fn, { timeout: 2000 });')).toEqual([]);
    // A file that genuinely raises its own budget is exempt; merely naming the
    // call in prose is not.
    expect(inertTimeoutBounds('vi.setConfig({ testTimeout: 60000 });\nwaitFor(fn, { timeout: 30000 });')).toEqual([]);
    expect(inertTimeoutBounds('// vi.setConfig( is discussed here\nwaitFor(fn, { timeout: 30000 });')).toEqual(['30000']);
    // Fixture data that merely carries a `timeout` field is not an async bound.
    expect(inertTimeoutBounds("const p = { id: 'p1', timeout: 300000 };")).toEqual([]);
  });
});
