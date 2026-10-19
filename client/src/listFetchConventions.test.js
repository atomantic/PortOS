// @vitest-environment node

/**
 * Repo-wide guard: a page's list fetch does not collapse a failed read into
 * an empty list.
 *
 * `listLorasFull().catch(() => [])` and `.catch(() => setTracks([]))` make a
 * transient 5xx during page load render as "you have none" — no error, no
 * retry, and no way to tell it from an empty library (#12040). The root
 * AGENTS.md sentinel rule (absent vs failed vs legitimately empty) is enforced
 * server-side; this is its client half. The shared primitive is
 * `hooks/useListResource` (`{ items, state, error, retry }`) with
 * `components/ui/ListLoadError` for the failed state.
 *
 * The rule is a ratchet. `KNOWN` records how many such sites each page still
 * carries today; a NEW site, or a higher count in a listed page, fails. So does
 * a count that DROPPED, so the row is lowered or removed and the baseline
 * stays honest. The remaining sites are tracked by surface in the follow-up
 * issues #12040 names.
 *
 * ## What this guard CANNOT see
 *
 * It is a source grep, not an AST pass:
 *   - A catch whose body does more than clear the list (`{ setX([]); setLoading(false); }`)
 *     is not matched; so is a `.catch` passed a named function.
 *   - A collapse moved into a hook or lib module is invisible (that is also where
 *     a shared, state-carrying read belongs).
 *   - A match inside a comment or string counts.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { trackedSourceFiles } from './test/trackedFiles.js';

const CLIENT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Page code only — the pickers and index lists users see.
const SCAN_PREFIX = 'src/pages/';

/**
 * `.catch(() => [])`, `.catch(() => setX([]))` and the braced one-statement
 * form `.catch(() => { setX([]); })`. The setter must start with `set` + a
 * capital, so `.catch(() => reset([]))` and a non-setter call stay out.
 */
export const LIST_COLLAPSE = /\.catch\(\s*\(\s*\)\s*=>\s*(?:\[\]|\{?\s*set[A-Z]\w*\(\s*\[\]\s*\)\s*;?\s*\}?)\s*\)/g;

/**
 * Pages still carrying a collapse, with how many. Lower or remove a row when a
 * site is migrated to `useListResource`; never raise one.
 */
const KNOWN = Object.freeze({});

const countIn = (source) => (source.match(LIST_COLLAPSE) || []).length;

describe('page list fetches keep a failed read distinct from an empty list', () => {
  it('matches the collapse spellings it is meant to catch, and not a handled failure', () => {
    for (const sample of [
      'listLorasFull().catch(() => [])',
      'listTracks({ silent: true }).then((t) => setTracks(t || [])).catch(() => setTracks([]))',
      'load().catch(() => { setRows([]); })',
    ]) expect(countIn(sample), sample).toBe(1);
    for (const sample of [
      'listTracks().catch(() => setLoadError(true))',
      'load().catch(() => { setRows([]); setFailed(true); })',
      'load().catch(() => FETCH_FAILED)',
    ]) expect(countIn(sample), sample).toBe(0);
  });

  it('has no new page list fetch that collapses failure into an empty list', () => {
    const found = {};
    for (const file of trackedSourceFiles(CLIENT_ROOT)) {
      if (!file.startsWith(SCAN_PREFIX)) continue;
      const count = countIn(readFileSync(join(CLIENT_ROOT, file), 'utf8'));
      if (count > 0) found[file] = count;
    }
    const added = Object.entries(found)
      .filter(([file, count]) => count > (KNOWN[file] || 0))
      .map(([file, count]) => `${file}: ${count} (known ${KNOWN[file] || 0})`);
    expect(added, [
      'These page list fetches render a failed read as an empty list. Read the list through',
      '`useListResource(fetcher)` and render `<ListLoadError onRetry={retry}>` on `state === "error"`,',
      'keeping the empty copy for `state === "ready"`; never `.catch(() => [])` / `setX([])`.',
    ].join('\n')).toEqual([]);
    const stale = Object.entries(KNOWN)
      .filter(([file, count]) => (found[file] || 0) < count)
      .map(([file, count]) => `${file}: now ${found[file] || 0} (known ${count})`);
    expect(stale, 'A migrated site: lower or remove its KNOWN row so the ratchet holds.').toEqual([]);
  });
});
