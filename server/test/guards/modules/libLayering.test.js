/**
 * Layering guard: `server/lib/` sits BELOW `server/services/`.
 *
 * lib is the pure/reusable tier — validation schemas, formatters, vocabularies.
 * services is domain orchestration. A lib module that imports upward inverts
 * that contract, and the cost is real, not theoretical: `lib/postValidation.js`
 * is loaded by every POST route, and it used to reach `services/
 * meatspacePostDrillCache.js` for a four-string array — dragging in the LLM
 * drill generator behind it.
 *
 * The burn-down is COMPLETE: the allowlist is empty, so this is now a plain
 * rule rather than a backlog. The stale-entry test below stays because the
 * allowlist must keep shrinking if anyone ever re-opens it.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync } from 'fs';
import { join } from 'path';
import { readText, REPO_ROOT } from '../../../../scripts/lib/guardCorpus.js';

const LIB_ROOT = join(REPO_ROOT, 'server/lib');

// The #4901 burn-down is complete: no server/lib module may import upward into
// services, and there is no allowlist to grow. If you need a service from lib,
// either the dependency belongs below (move the constant/helper down) or the
// module belongs above (promote it).

// Permanently exempt — NOT burn-down rows. Both reach into services through a
// DYNAMIC import for a documented structural reason, and turning either into a
// static import is the bug, not the fix:
//   * peerHttpClient.js  — `services/instances.js` imports THIS module, so a
//     static import back would close an evaluation-order cycle.
//   * settingsTestUtil.js — a test-only helper; suites `vi.resetModules()`
//     between builds, so it must resolve the live module per call.
// Listed separately from the allowlist so nobody "burns them down" by making
// them static.
const DYNAMIC_IMPORT_EXEMPT = new Set([
  'peerHttpClient.js',
  'settingsTestUtil.js',
]);

// `aiToolkit/` is a vendored, self-contained toolkit (see its AGENTS.md) and is
// scanned by its own rules, not this one.
const SKIP_DIRS = new Set(['aiToolkit', 'node_modules']);

function libSourceFiles(dir = LIB_ROOT, prefix = '') {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...libSourceFiles(join(dir, entry.name), `${prefix}${entry.name}/`));
    } else if (entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) {
      out.push({ rel: `${prefix}${entry.name}`, abs: join(dir, entry.name) });
    }
  }
  return out;
}

// Matches static named/re-export and side-effect imports, and dynamic import().
const UPWARD_IMPORT = /from\s+['"](?:\.\.\/)+services\/|import\s*(?:\(\s*)?['"](?:\.\.\/)+services\//;

const offenders = () => libSourceFiles()
  .filter(({ rel }) => !DYNAMIC_IMPORT_EXEMPT.has(rel))
  .filter(({ abs }) => UPWARD_IMPORT.test(readText(abs)))
  .map(({ rel }) => rel);

describe('server/lib layering', () => {
  it('has no lib -> services imports (#4901)', () => {
    const unlisted = offenders();
    expect(
      unlisted,
      `server/lib modules importing upward into services — move the dependency below, or promote the module into services (#4901):\n${unlisted.join('\n')}`,
    ).toEqual([]);
  });
});
