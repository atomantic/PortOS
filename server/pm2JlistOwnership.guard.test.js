/**
 * Tree-wide guard: only the two designated readers may execute raw
 * `pm2 jlist` (issue #8164, consolidating #968, #2991, #5732).
 *
 * ## The bug class
 *
 * `pm2 jlist` always emits a JSON array (`[]` for no processes), so an exit-0
 * read with empty/garbage stdout is a FAILED read, not "no processes" — and a
 * caller that re-implements its own extraction/parsing tends to get that
 * absent-vs-empty distinction wrong, collapsing a transient PM2 outage into a
 * confident "nothing running." Before this issue, six call sites each ran and
 * parsed `pm2 jlist` independently (`cosHealthMonitor.js`, `streamingDetect.js`,
 * `routes/detect.js`, `browserService.js`, `autofixer/server.js`,
 * `autofixer/ui.js`), and three prior issues (#968, #2991, #5732) each fixed
 * the contract in one owner without closing the door on a new copy appearing
 * elsewhere.
 *
 * ## The rule
 *
 * Exactly two non-test modules may spawn PM2 with a literal `['jlist']` (or
 * `["jlist"]`) argument array: `server/services/pm2.js` (`fetchJlist` →
 * `listProcessesStrict`/`listProcesses`, the mapped-shape reader every other
 * server-side caller should use) and `autofixer/shared.js`
 * (`listProcessesStrict`, package-local because the autofixer deliberately
 * avoids the server dependency graph — see the comment at the top of that
 * file). Both compose the shared, dependency-free parser at
 * `server/lib/pm2Jlist.js#parsePm2JlistStdout`. A new caller must import one of
 * those readers, not re-run `pm2 jlist` itself.
 *
 * This is a narrow, call-shape-specific scan (`(['jlist'` / `(["jlist"`), not a
 * substring match on the word "jlist" — that word appears legitimately in
 * comments, cache-key constants (`clearJlistCache`, `JLIST_TTL_MS`), and an
 * autonomous-job shell-command description elsewhere in the tree.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const SERVER_ROOT = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(SERVER_ROOT);
const PROCESS_ROOTS = ['server/', 'autofixer/'];

// The only two files permitted to spawn PM2 with a literal `['jlist']`/`["jlist"]`
// argument array.
const ALLOWED_OWNERS = new Set([
  'server/services/pm2.js',
  'autofixer/shared.js',
]);

const RAW_JLIST_CALL = /\(\s*\[\s*['"]jlist['"]/;

const trackedSources = () => execFileSync('git', ['ls-files', '*.js', '*.mjs', '*.cjs'], {
  cwd: REPO_ROOT,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
}).split('\n').filter((f) => f && PROCESS_ROOTS.some((root) => f.startsWith(root)) && !f.includes('.test.'));

describe('pm2 jlist ownership guard (#8164)', () => {
  it('scans both long-running Node process trees', () => {
    // A broken `git ls-files` (wrong cwd, detached checkout) would otherwise
    // let the assertion below pass by scanning nothing at all.
    const sources = trackedSources();
    expect(sources.length).toBeGreaterThan(200);
    expect(PROCESS_ROOTS.every((root) => sources.some((file) => file.startsWith(root)))).toBe(true);
  });

  it('recognizes the two allowed owners actually spawn a literal jlist call', () => {
    // Proves the regex still matches real call sites — without this the scan
    // below could go vacuously green if the call shape ever changed.
    for (const owner of ALLOWED_OWNERS) {
      const src = readFileSync(join(REPO_ROOT, owner), 'utf8');
      expect(RAW_JLIST_CALL.test(src)).toBe(true);
    }
  });

  it('finds no raw `pm2 jlist` execution outside the two designated readers', () => {
    const offenders = [];
    for (const file of trackedSources()) {
      if (ALLOWED_OWNERS.has(file)) continue;
      const src = readFileSync(join(REPO_ROOT, file), 'utf8');
      if (RAW_JLIST_CALL.test(src)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
