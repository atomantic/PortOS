/**
 * Rule: Every route module mounted by `server/index.js` must be imported (or `vi.mock`ed) by at least one tracked test; a router with no validation or derivation may sit in `UNTESTED_ALLOWLIST` when its entry names the service suite that covers it.
 * Fix: Add an HTTP-boundary contract test (`request(app)` from `lib/testHelper.js`) that asserts what the route owns, or, for a pure pass-through, allowlist it naming the covering service suite.
 * What this guard cannot see:
 *   - Sub-routers reached only through a barrel module are covered by the barrel's test.
 */

import { describe, it, expect } from 'vitest';
import { dirname, join, relative, resolve } from 'node:path';
import { readText, REPO_ROOT as ROOT, workingTreeFiles } from '../../../../scripts/lib/guardCorpus.js';

/** Mounted route modules no test imports yet, each with why it can wait. */
const UNTESTED_ALLOWLIST = new Map([
  ['server/routes/alerts.js', 'read-only pass-through over proactiveAlerts, which its own suite covers'],
  ['server/routes/autoFixMetrics.js', 'read-only pass-through over autoFixMetrics, which its own suite covers'],
  ['server/routes/iterm.js', 'read-only capability probe over itermBridge, which its own suite covers'],
  ['server/routes/runs.js', 'returns the toolkit runs router unchanged; the toolkit route suite owns the contract'],
]);

/** `server/routes/...` paths imported by `server/index.js`, repo-relative. */
function mountedRouteModules(indexSource) {
  return [...indexSource.matchAll(/(?:from\s+|import\(\s*)['"](\.\/routes\/[^'"]+)['"]/g)]
    .map((m) => `server/${m[1].slice(2)}`);
}

/** Every relative module a test file names, resolved repo-relative. */
function importedModules(testFile, source) {
  return [...source.matchAll(/['"](\.{1,2}\/[^'"\n]+\.[cm]?js)['"]/g)]
    .map((m) => relative(ROOT, resolve(ROOT, dirname(testFile), m[1])).split('\\').join('/'));
}

function trackedTests() {
  return workingTreeFiles(ROOT, ['server', 'scripts', 'lib', 'autofixer']).filter((f) => /\.test\.[cm]?js$/.test(f));
}

function untestedMounted() {
  const mounted = mountedRouteModules(readText(join(ROOT, 'server/index.js')));
  const imported = new Set(trackedTests().flatMap((f) => importedModules(f, readText(join(ROOT, f)))));
  return { mounted, untested: mounted.filter((m) => !imported.has(m)) };
}

describe('mounted route modules are reached by a test (#12048)', () => {
  it('reads the mounts and resolves test imports the way the scan relies on', () => {
    expect(mountedRouteModules("import a from './routes/apps/index.js';\nimport { b } from \"./routes/x.js\";\nconst c = createLazyRouter(() => import('./routes/c.js'));"))
      .toEqual(['server/routes/apps/index.js', 'server/routes/x.js', 'server/routes/c.js']);
    expect(importedModules('server/routes/foo.test.js', "vi.mock('../services/a.js');\nconst { default: r } = await import('./foo.js');"))
      .toEqual(['server/services/a.js', 'server/routes/foo.js']);
  });

  it('has no untested mounted route module outside the burn-down list', () => {
    const { mounted, untested } = untestedMounted();
    expect(mounted.length).toBeGreaterThan(100);
    const offenders = untested.filter((m) => !UNTESTED_ALLOWLIST.has(m));
    expect(
      offenders,
      'add a route contract test (request(app) at the mounted path: refusals, derived arguments, error mapping), or for a router with no validation and no derivation add it to UNTESTED_ALLOWLIST with a reason naming the service suite that covers it.',
    ).toEqual([]);
  });

  it('drops allowlist entries once their module is tested or unmounted', () => {
    const { untested } = untestedMounted();
    const stale = [...UNTESTED_ALLOWLIST.keys()].filter((m) => !untested.includes(m));
    expect(stale, 'these modules are now imported by a test or no longer mounted — remove them from UNTESTED_ALLOWLIST').toEqual([]);
    for (const reason of UNTESTED_ALLOWLIST.values()) expect(reason.length).toBeGreaterThan(10);
  });
});
