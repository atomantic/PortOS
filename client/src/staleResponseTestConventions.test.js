// @vitest-environment node
// test-memo: never (tree-wide scanner)

/**
 * Rule: A stale-response test must flush the resolved promise with `await act(async () => { resolveOld(payload); })` before asserting absence.
 * Fix: Wrap `resolve*(…)` in `await act(async () => { … })` and assert synchronously instead of `await waitFor(() => expect(…).toBeNull())`.
 * What this guard cannot see:
 *   - Lexical scan: only catches bare `resolve*(`/`finish*(` followed within two lines by `await waitFor(() => expect(…)` with `.not`/`toBeNull()`; other resolver names and multi-line `waitFor` bodies are not examined.
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
