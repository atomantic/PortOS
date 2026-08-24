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
import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const LIB_ROOT = dirname(fileURLToPath(import.meta.url));

// Modules that still import upward into services. Each row is a real layering
// inversion awaiting its slice of #4901 — NOT a permanent exemption. Fix the
// module, delete the row. Never add a row for new code.
// EMPTY — the burn-down is complete (#4901). Every server/lib module that
// imported upward into services has been resolved, each on its own merits:
// pure vocabularies were pushed DOWN into lib, and genuine orchestration
// (runners, the HF download stack, aiProvider) was promoted UP into services.
//
// Do NOT add a row here. An empty list means the rule is now simply enforced:
// if you need a service from lib, either the dependency belongs below (move the
// constant/helper down) or the module belongs above (promote it). Adding a row
// re-opens a backlog that took six PRs to close.
const PREEXISTING_LIB_TO_SERVICES_ALLOWLIST = new Set([]);

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

// Matches `from '../services/x.js'` / `from '../../services/x.js'` in both
// static imports and dynamic `import(...)`, ignoring commented-out lines.
const UPWARD_IMPORT = /from\s+['"](?:\.\.\/)+services\/|import\s*\(\s*['"](?:\.\.\/)+services\//;

const offenders = () => libSourceFiles()
  .filter(({ rel }) => !DYNAMIC_IMPORT_EXEMPT.has(rel))
  .filter(({ abs }) => UPWARD_IMPORT.test(readFileSync(abs, 'utf8')))
  .map(({ rel }) => rel);

describe('server/lib layering', () => {
  it('has no lib -> services imports outside the burn-down allowlist', () => {
    const unlisted = offenders().filter((f) => !PREEXISTING_LIB_TO_SERVICES_ALLOWLIST.has(f));
    expect(
      unlisted,
      `server/lib modules importing upward into services — move the dependency below, or promote the module into services (#4901):\n${unlisted.join('\n')}`,
    ).toEqual([]);
  });

  it('keeps no stale entries in PREEXISTING_LIB_TO_SERVICES_ALLOWLIST (#4901)', () => {
    const current = new Set(offenders());
    const stale = [...PREEXISTING_LIB_TO_SERVICES_ALLOWLIST].filter((f) => !current.has(f));
    expect(
      stale,
      `allowlist rows whose module no longer imports services — delete them so the burn-down stays honest:\n${stale.join('\n')}`,
    ).toEqual([]);
  });
});
