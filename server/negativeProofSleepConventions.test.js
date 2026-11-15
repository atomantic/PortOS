/**
 * Rule: Negative assertions (`.not.toHaveBeenCalled` / `toHaveBeenCalledTimes(0)`) may not rest on a one-line real `setTimeout` sleep.
 * Fix: Await the handler's completion signal, use `vi.advanceTimersByTimeAsync`, or wait for a positive signal with `vi.waitFor` first.
 * What this guard cannot see:
 *   - Sleeps bound to a helper (`await sleep(30)`) or negative assertions further away than a few lines.
 */
import { existingPaths } from '../scripts/lib/trackedFiles.js';

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
// This file spells the pattern out in its docs and recognizer fixtures.
const SELF = 'server/negativeProofSleepConventions.test.js';

const REAL_SLEEP = /await\s+new\s+Promise\s*\(\s*\(?\s*\w*\s*\)?\s*=>\s*setTimeout\s*\(\s*\w+\s*,\s*\d+\s*\)\s*\)/;
const NEGATIVE_CALL = /\.not\.toHaveBeenCalled\b|toHaveBeenCalledTimes\(\s*0\s*\)/;
const TEST_BOUNDARY = /^\s*(?:it|test|describe)(?:\.\w+)*\(|^\s*}\)?;?\s*$/;
const LOOKAHEAD_LINES = 5;

/** `file:line` for every real sleep that a negative call assertion follows. */
export function scanNegativeProofSleeps(source, file) {
  const lines = source.split('\n');
  const hits = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!REAL_SLEEP.test(lines[i])) continue;
    for (let j = i + 1; j < Math.min(lines.length, i + 1 + LOOKAHEAD_LINES); j += 1) {
      if (TEST_BOUNDARY.test(lines[j])) break;
      if (NEGATIVE_CALL.test(lines[j])) { hits.push(`${file}:${i + 1}`); break; }
    }
  }
  return hits;
}

function trackedTests() {
  return existingPaths(ROOT, execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', 'server', 'scripts', 'client/src', 'lib', 'autofixer'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0').filter(Boolean)).filter((f) => /\.test\.[cm]?jsx?$/.test(f) && f !== SELF);
}

describe('negative proofs do not rest on real sleeps (#12047)', () => {
  it('flags a sleep followed by a not-called assertion and nothing else', () => {
    const flagged = [
      "    await new Promise((r) => setTimeout(r, 30));",
      '    expect(setPortraitMedia).not.toHaveBeenCalled();',
    ].join('\n');
    expect(scanNegativeProofSleeps(flagged, 'probe.test.js')).toEqual(['probe.test.js:1']);

    const zeroTimes = [
      '    await new Promise((resolve) => setTimeout(resolve, 700));',
      '    expect(container.innerHTML).toBe("");',
      '    expect(fetchMock).toHaveBeenCalledTimes(0);',
    ].join('\n');
    expect(scanNegativeProofSleeps(zeroTimes, 'probe.test.js')).toEqual(['probe.test.js:1']);

    const positive = [
      '    await new Promise((r) => setTimeout(r, 30));',
      '    expect(attachMedia).toHaveBeenCalledWith("a");',
      '  });',
      '  it("other", () => {',
      '    expect(other).not.toHaveBeenCalled();',
    ].join('\n');
    expect(scanNegativeProofSleeps(positive, 'probe.test.js')).toEqual([]);

    const fakeTimers = [
      '    await vi.advanceTimersByTimeAsync(50);',
      '    expect(stop).not.toHaveBeenCalled();',
    ].join('\n');
    expect(scanNegativeProofSleeps(fakeTimers, 'probe.test.js')).toEqual([]);
  });

  it('keeps the pattern out of every test file', () => {
    const files = trackedTests();
    expect(files.length).toBeGreaterThan(100);
    const offenders = files.flatMap((f) => scanNegativeProofSleeps(readFileSync(join(ROOT, f), 'utf8'), f));
    expect(
      offenders,
      'await the handler\'s completion signal, drive fake timers, or vi.waitFor a positive signal before the negative assertion.',
    ).toEqual([]);
  });
});
