/**
 * Tree-wide guard: only the designated autofixer reader may execute raw
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
 * Only `autofixer/shared.js` may spawn PM2 with a literal `['jlist']`
 * argument array. It uses the shared parser at
 * `server/lib/pm2Jlist.js#parsePm2JlistStdout`. Server-side callers use
 * `server/services/pm2.js#listProcessesStrict` / `listProcesses`, which read
 * an existing daemon over native RPC without spawning the CLI (#15781).
 * A new caller must import its owning reader rather than re-run `pm2 jlist`.
 *
 * This is a narrow, call-shape-specific scan (`(['jlist'` / `(["jlist"`), not a
 * substring match on the word "jlist" — that word appears legitimately in
 * comments, cache-key constants (`clearJlistCache`, `JLIST_TTL_MS`), and an
 * autonomous-job shell-command description elsewhere in the tree.
 */
import { trackedFiles } from '../scripts/lib/trackedFiles.js';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const SERVER_ROOT = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(SERVER_ROOT);
const PROCESS_ROOTS = ['server/', 'autofixer/'];

// The only file permitted to spawn PM2 with a literal `['jlist']`/`["jlist"]`
// argument array.
const ALLOWED_OWNERS = new Set([
  'autofixer/shared.js',
]);

const RAW_JLIST_CALL = /\(\s*\[\s*['"]jlist['"]/;

const trackedSources = () => trackedFiles(REPO_ROOT, ['*.js', '*.mjs', '*.cjs']).filter((f) => f && PROCESS_ROOTS.some((root) => f.startsWith(root)) && !f.includes('.test.'));

describe('pm2 jlist ownership guard (#8164)', () => {
  it('scans both long-running Node process trees', () => {
    // A broken `git ls-files` (wrong cwd, detached checkout) would otherwise
    // let the assertion below pass by scanning nothing at all.
    const sources = trackedSources();
    expect(sources.length).toBeGreaterThan(200);
    expect(PROCESS_ROOTS.every((root) => sources.some((file) => file.startsWith(root)))).toBe(true);
  });

  it('recognizes the allowed owner actually spawns a literal jlist call', () => {
    // Proves the regex still matches real call sites — without this the scan
    // below could go vacuously green if the call shape ever changed.
    for (const owner of ALLOWED_OWNERS) {
      const src = readFileSync(join(REPO_ROOT, owner), 'utf8');
      expect(RAW_JLIST_CALL.test(src)).toBe(true);
    }
  });

  it('finds no raw `pm2 jlist` execution outside the designated reader', () => {
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
