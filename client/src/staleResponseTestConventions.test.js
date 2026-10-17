// @vitest-environment node

/**
 * Repo-wide guard: a stale-response test must flush before it asserts absence.
 *
 * The vacuous shape:
 *
 *   resolveOld(payload);
 *   await waitFor(() => expect(screen.queryByText('old')).toBeNull());
 *
 * `waitFor` runs its callback once synchronously, before the resolved
 * promise's continuation has run, so the absence check passes on the first try
 * and the test stays green with the staleness guard deleted (#11890: four
 * guards in DeckStyleSources, PeerAdministrationPanel, useMusicVideoReviewDraft
 * and PromptManager were uncovered this way).
 *
 * Fix: `await act(async () => { resolveOld(payload); });` then assert
 * synchronously, ideally followed by a positive assertion about the current
 * record that must survive the flush. A waitFor is only legitimate when the
 * absent thing is PRESENT before the trigger, so it really waits.
 *
 * ## What this guard CANNOT see
 *
 * Lexical scan: a bare `resolve*(`/`finish*(` statement followed within two
 * lines by `await waitFor(() => expect(...)` with `.not` or `toBeNull()`.
 * Other resolver names, multi-line waitFor bodies, and `await`ed or
 * act-wrapped resolves are not examined.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const CLIENT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const BARE_RESOLVE = /^\s*(?:resolve|finish)\w*\(/;
const ABSENCE_WAIT = /await waitFor\(\(\) => expect\(.*(?:\.not\.|toBeNull\(\))/;
const LOOKAHEAD = 2;

/** Zero-based indexes of vacuous waitFor lines in `source`. */
const findVacuousAbsenceWaits = (source) => {
  const lines = source.split('\n');
  const hits = [];
  lines.forEach((line, i) => {
    if (!BARE_RESOLVE.test(line)) return;
    for (let j = i + 1; j <= i + LOOKAHEAD && j < lines.length; j += 1) {
      if (ABSENCE_WAIT.test(lines[j])) { hits.push(j); break; }
    }
  });
  return hits;
};

/** `file:line` -> reason the waitFor is real (the absent state is present before the trigger). */
const ALLOWED = {
  'src/pages/SongBookViewer.test.jsx:1057': 'the editor sheet is open (Content label present) until the save settles, so waitFor genuinely waits',
};

// Git-tracked only, so an untracked scratch file can't fail the suite.
const testFiles = () => execSync('git ls-files src', { cwd: CLIENT_ROOT, encoding: 'utf8' })
  .trim().split('\n').filter((f) => /\.test\.jsx?$/.test(f));

describe('stale-response tests flush before asserting absence', () => {
  it('has no un-flushed absence waitFor after a bare resolve', () => {
    const files = testFiles();
    expect(files.length).toBeGreaterThan(100);
    const violations = files.flatMap((file) =>
      findVacuousAbsenceWaits(readFileSync(join(CLIENT_ROOT, file), 'utf8'))
        .map((i) => `${file}:${i + 1}`))
      .filter((loc) => !(loc in ALLOWED));
    expect(
      violations,
      'waitFor checks synchronously first, so an absence assertion right after a bare resolve passes '
      + 'before the response lands. Use `await act(async () => { resolveX(...); })` then assert '
      + 'synchronously (plus a positive assertion on the current record), or allowlist with a reason.\n'
      + `Offenders:\n  ${violations.join('\n  ')}`,
    ).toEqual([]);
  });

  it('has no stale allowlist entry', () => {
    const stale = Object.keys(ALLOWED).filter((loc) => {
      const [file, line] = loc.split(/:(?=\d+$)/);
      try {
        return !findVacuousAbsenceWaits(readFileSync(join(CLIENT_ROOT, file), 'utf8')).includes(Number(line) - 1);
      } catch { return true; }
    });
    expect(stale, `Allowlist rows that no longer match a flagged line:\n  ${stale.join('\n  ')}`).toEqual([]);
  });

  it('flags the vacuous shape and accepts the flushed one', () => {
    const vacuous = [
      'resolveOld(data);',
      "await waitFor(() => expect(screen.queryByText('old')).toBeNull());",
    ].join('\n');
    expect(findVacuousAbsenceWaits(vacuous)).toEqual([1]);
    expect(findVacuousAbsenceWaits("finishLoad();\nawait waitFor(() => expect(x).not.toBeInTheDocument());")).toEqual([1]);
    expect(findVacuousAbsenceWaits([
      'await act(async () => { resolveOld(data); });',
      "await waitFor(() => expect(screen.queryByText('old')).toBeNull());",
    ].join('\n'))).toEqual([]);
    expect(findVacuousAbsenceWaits('resolveOld(data);\nawait waitFor(() => expect(fn).toHaveBeenCalled());')).toEqual([]);
  });
});
