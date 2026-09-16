import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { describe, expect, it } from 'vitest';

import { trackedTestFiles } from './trackedFiles.js';
import { ASYNC_UTIL_TIMEOUT_MS, TEST_TIMEOUT_MS } from './timeouts.js';

const CLIENT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * A lone-key `{ timeout: N }` — the shape `waitFor(fn, { timeout })` and
 * `findBy*(text, {}, { timeout })` take. Deliberately does NOT match a fixture
 * object that carries a `timeout` field beside other keys (the provider records
 * in `src/utils/providers.test.js` hold `{ id, timeout }`), which is data rather
 * than an async bound.
 */
const LONE_TIMEOUT_OPTION = /\{\s*timeout:\s*([\d_]+)\s*\}/g;

describe('client suite time budgets', () => {
  it('leaves the async bound strictly inside the per-test budget', () => {
    // Equality is the failure mode, not just excess: a `waitFor` bounded at
    // exactly the per-test budget loses the race to report its own failure, and
    // the run shows a bare "test timed out" naming nothing.
    expect(TEST_TIMEOUT_MS).toBeGreaterThan(ASYNC_UTIL_TIMEOUT_MS);
  });

  it("gives a slow runner real headroom over testing-library's default", () => {
    // Pins the intent rather than the exact number: the whole point of #7448 is
    // that 1000ms (the library default) and the 3000ms this suite ran at both
    // sat under what a 2-vCPU public runner needs for an `await`-a-mock-call
    // assertion, so shard 1 went red on most runs while passing locally.
    expect(ASYNC_UTIL_TIMEOUT_MS).toBeGreaterThanOrEqual(5000);
  });

  it('has no inline async bound that the per-test budget would cut short', () => {
    // An inline `{ timeout: N }` at or above the per-test budget is inert: the
    // test dies first, so the extended wait never happens and the failure names
    // nothing. `BeeperTab.test.jsx` carried `{ timeout: 15000 }` against a
    // 5000ms budget for exactly this reason (#7448) — it read as a fix and was
    // not one. A file that genuinely needs longer raises BOTH, through
    // `vi.setConfig({ testTimeout })`, so those files are skipped here.
    const offenders = [];
    for (const file of trackedTestFiles(CLIENT_ROOT)) {
      const source = readFileSync(join(CLIENT_ROOT, file), 'utf8');
      if (source.includes('vi.setConfig(')) continue;
      for (const [, digits] of source.matchAll(LONE_TIMEOUT_OPTION)) {
        if (Number(digits.replace(/_/g, '')) >= TEST_TIMEOUT_MS) {
          offenders.push(`${file}: { timeout: ${digits} }`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
