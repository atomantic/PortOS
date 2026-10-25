/**
 * Repo-wide guard: every route module `server/index.js` mounts is imported by
 * at least one test (#12048).
 *
 * A router no test imports ships green with a handler that returns the wrong
 * shape or 500s on an edge path, and the CI planner's related-test selection has
 * nothing to select when the file changes. The fix is a contract test at the
 * HTTP boundary (`request(app)` from `lib/testHelper.js`, success path plus the
 * materially different failure path), not an entry here.
 *
 * `UNTESTED_ALLOWLIST` is the burn-down of mounted modules that no test imports
 * yet. It only SHRINKS: a module that gains a test must leave the list (the
 * stale-entry assertion fails otherwise), and a newly mounted untested module
 * fails outright.
 *
 * "Imported" means a relative specifier in a tracked test file (a static or
 * dynamic import, or a `vi.mock` path) resolves to the module. A route reached
 * only through another module (a sub-router mounted by a barrel) is covered by
 * the barrel's test and is not itself listed.
 */
import { existingPaths } from '../scripts/lib/trackedFiles.js';

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Mounted route modules no test imports yet, each with why it can wait. */
const UNTESTED_ALLOWLIST = new Map([
  ['server/routes/alerts.js', 'read-only pass-through over proactiveAlerts, which its own suite covers'],
  ['server/routes/autoFixMetrics.js', 'read-only pass-through over autoFixMetrics, which its own suite covers'],
  ['server/routes/iterm.js', 'read-only capability probe over itermBridge, which its own suite covers'],
  ['server/routes/runs.js', 'returns the toolkit runs router unchanged; the toolkit route suite owns the contract'],
]);

/** `server/routes/...` paths imported by `server/index.js`, repo-relative. */
function mountedRouteModules(indexSource) {
  return [...indexSource.matchAll(/from\s+['"](\.\/routes\/[^'"]+)['"]/g)]
    .map((m) => `server/${m[1].slice(2)}`);
}

/** Every relative module a test file names, resolved repo-relative. */
function importedModules(testFile, source) {
  return [...source.matchAll(/['"](\.{1,2}\/[^'"\n]+\.[cm]?js)['"]/g)]
    .map((m) => relative(ROOT, resolve(ROOT, dirname(testFile), m[1])).split('\\').join('/'));
}

function trackedTests() {
  return existingPaths(ROOT, execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', 'server', 'scripts', 'lib', 'autofixer'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0').filter(Boolean)).filter((f) => /\.test\.[cm]?js$/.test(f));
}

function untestedMounted() {
  const mounted = mountedRouteModules(readFileSync(join(ROOT, 'server/index.js'), 'utf8'));
  const imported = new Set(trackedTests().flatMap((f) => importedModules(f, readFileSync(join(ROOT, f), 'utf8'))));
  return { mounted, untested: mounted.filter((m) => !imported.has(m)) };
}

describe('mounted route modules are reached by a test (#12048)', () => {
  it('reads the mounts and resolves test imports the way the scan relies on', () => {
    expect(mountedRouteModules("import a from './routes/apps/index.js';\nimport { b } from \"./routes/x.js\";"))
      .toEqual(['server/routes/apps/index.js', 'server/routes/x.js']);
    expect(importedModules('server/routes/foo.test.js', "vi.mock('../services/a.js');\nconst { default: r } = await import('./foo.js');"))
      .toEqual(['server/services/a.js', 'server/routes/foo.js']);
  });

  it('has no untested mounted route module outside the burn-down list', () => {
    const { mounted, untested } = untestedMounted();
    expect(mounted.length).toBeGreaterThan(100);
    const offenders = untested.filter((m) => !UNTESTED_ALLOWLIST.has(m));
    expect(
      offenders,
      'add a route contract test (request(app) at the mounted path: success plus the materially different failure). Do NOT add to UNTESTED_ALLOWLIST — it only shrinks.',
    ).toEqual([]);
  });

  it('drops allowlist entries once their module is tested or unmounted', () => {
    const { untested } = untestedMounted();
    const stale = [...UNTESTED_ALLOWLIST.keys()].filter((m) => !untested.includes(m));
    expect(stale, 'these modules are now imported by a test or no longer mounted — remove them from UNTESTED_ALLOWLIST').toEqual([]);
    for (const reason of UNTESTED_ALLOWLIST.values()) expect(reason.length).toBeGreaterThan(10);
  });
});
