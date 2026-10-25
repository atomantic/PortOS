/**
 * Repo-wide guard: a negative proof may not rest on a real sleep.
 *
 *   await new Promise((r) => setTimeout(r, 30));
 *   expect(writeMock).not.toHaveBeenCalled();
 *
 * That passes whenever the handler is merely slower than the sleep — on a
 * loaded CI worker the asserted-absent call lands after the assertion, so the
 * test is green against the exact regression it exists to catch, while every
 * run pays the sleep (#12047). The deterministic shapes are: await the
 * handler's own completion signal (`hook.__testing.settled()` on the media-job
 * hooks), drive the clock with fake timers (`vi.advanceTimersByTimeAsync`), or
 * wait for a positive signal with `vi.waitFor` and only then assert the negative.
 *
 * ## Burn-down
 *
 * `BURN_DOWN` names the test files that still carry the pattern. It only
 * shrinks: a file that no longer matches must leave the list (the stale-entry
 * assertion fails otherwise), and a new site anywhere fails outright.
 *
 * ## What the scan sees
 *
 * A one-line real sleep (`await new Promise(<fn> => setTimeout(<fn>, <literal>))`)
 * followed, before the enclosing test ends and within the next few lines, by
 * `.not.toHaveBeenCalled` / `toHaveBeenCalledTimes(0)`. A sleep bound to a
 * helper (`await sleep(30)`) or a negative assertion further away is not seen;
 * the guard errs toward silence rather than guessing at intent.
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

const BURN_DOWN = [
  'client/src/components/meatspace/post/PostSessionLauncher.test.jsx',
  'server/services/agentCliSpawning.test.js',
  'server/services/backupScheduler.test.js',
  'server/services/creativeDirectorSceneImageHook.test.js',
  'server/services/fableLoomSceneImageHook.test.js',
  'server/services/fableLoomSceneVideoHook.test.js',
  'server/services/mediaJobImageHook.test.js',
  'server/services/musicVideo/autonomousService.test.js',
  'server/services/runner.test.js',
  'server/services/writersRoomSceneImageHook.test.js',
];

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

  it('keeps the pattern out of every test file not on the burn-down list', () => {
    const files = trackedTests();
    expect(files.length).toBeGreaterThan(100);
    const burnDown = new Set(BURN_DOWN);
    const offenders = files
      .filter((f) => !burnDown.has(f))
      .flatMap((f) => scanNegativeProofSleeps(readFileSync(join(ROOT, f), 'utf8'), f));
    expect(
      offenders,
      'await the handler\'s completion signal, drive fake timers, or vi.waitFor a positive signal before the negative assertion. Do NOT add to BURN_DOWN — it only shrinks.',
    ).toEqual([]);
  });

  it('drops burn-down entries once their file is clean', () => {
    const files = new Set(trackedTests());
    const stale = BURN_DOWN.filter((f) => !files.has(f)
      || scanNegativeProofSleeps(readFileSync(join(ROOT, f), 'utf8'), f).length === 0);
    expect(stale, 'these files no longer carry the pattern — remove them from BURN_DOWN').toEqual([]);
    expect([...BURN_DOWN].sort()).toEqual(BURN_DOWN);
    expect(new Set(BURN_DOWN).size).toBe(BURN_DOWN.length);
  });
});
