/**
 * Rule: A stale-response test must flush the resolved promise with `await act(async () => { resolveOld(payload); })` before asserting absence.
 * Fix: Wrap `resolve*(…)` in `await act(async () => { … })` and assert synchronously instead of `await waitFor(() => expect(…).toBeNull())`.
 * What this guard cannot see:
 *   - Lexical scan: only catches bare `resolve*(`/`finish*(` followed within two lines by `await waitFor(() => expect(…)` with `.not`/`toBeNull()`; other resolver names and multi-line `waitFor` bodies are not examined.
 */

import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { execSync } from 'child_process';
import { readText, REPO_ROOT } from '../../../../../scripts/lib/guardCorpus.js';

const CLIENT_ROOT = join(REPO_ROOT, 'client');

const BARE_RESOLVE = /^\s*(?:resolve|finish)\w*\(/;
const ABSENCE_WAIT = /await waitFor\(\(\) => expect\(.*(?:\.not\.|toBeNull\(\))/;
const LOOKAHEAD = 2;

const TEST_TITLE = /^\s*(?:it|test)(?:\.\w+)*\(\s*(['"`])(.*?)\1/;

/** Title of the nearest `it(`/`test(` opening at or above line index `i`. */
const enclosingTestTitle = (lines, i) => {
  for (let j = i; j >= 0; j -= 1) {
    const match = lines[j].match(TEST_TITLE);
    if (match) return match[2];
  }
  return '<outside a test>';
};

/** Enclosing test titles of vacuous waitFor lines in `source`. */
const findVacuousAbsenceWaits = (source) => {
  const lines = source.split('\n');
  const hits = [];
  lines.forEach((line, i) => {
    if (!BARE_RESOLVE.test(line)) return;
    for (let j = i + 1; j <= i + LOOKAHEAD && j < lines.length; j += 1) {
      if (ABSENCE_WAIT.test(lines[j])) { hits.push(j); break; }
    }
  });
  return hits.map((i) => `${enclosingTestTitle(lines, i)}`);
};

/**
 * `file :: enclosing test title` -> reason the waitFor is real (the absent state is present
 * before the trigger). Keyed by test title, never a line number, so unrelated edits above
 * the test cannot invalidate the entry.
 */
const ALLOWED = {
  'src/pages/SongBookViewer.test.jsx :: hides the discard row while a save is in flight': 'the editor sheet is open (Content label present) until the save settles, so waitFor genuinely waits',
};

// Git-tracked only, so an untracked scratch file can't fail the suite.
const testFiles = () => execSync('git ls-files src', { cwd: CLIENT_ROOT, encoding: 'utf8' })
  .trim().split('\n').filter((f) => /\.test\.jsx?$/.test(f));

describe('stale-response tests flush before asserting absence', () => {
  const found = () => testFiles().flatMap((file) =>
    findVacuousAbsenceWaits(readText(join(CLIENT_ROOT, file))).map((title) => `${file} :: ${title}`));

  it('has no un-flushed absence waitFor after a bare resolve', () => {
    expect(testFiles().length).toBeGreaterThan(100);
    const violations = found().filter((key) => !(key in ALLOWED));
    expect(
      violations,
      'waitFor checks synchronously first, so an absence assertion right after a bare resolve passes '
      + 'before the response lands. Use `await act(async () => { resolveX(...); })` then assert '
      + 'synchronously (plus a positive assertion on the current record), or allowlist with a reason.\n'
      + `Offenders:\n  ${violations.join('\n  ')}`,
    ).toEqual([]);
  });

  it('has no stale allowlist entry', () => {
    const seen = new Set(found());
    expect(Object.keys(ALLOWED).filter((key) => !seen.has(key))).toEqual([]);
  });
});
