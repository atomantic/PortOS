/**
 * Client ↔ server API route parity.
 *
 * `client/src/services/api*.js` is where the browser learns which URL a feature
 * lives at, and each wrapper's co-located test asserts the wrapper produced the
 * string the wrapper produces. Nothing compared those strings to the routes
 * `server/index.js` actually mounts, so renaming an `app.use('/api/<x>', …)`
 * prefix — or moving a handler between routers — left the whole client suite
 * green while the feature 404'd in the browser (#5716).
 *
 * This closes that boundary by diffing two static scans of the real tree:
 * `scripts/generate-api-route-catalog.js` for the mounted server routes (the
 * inventory the API Explorer already ships) and `clientApiPaths.js` for the
 * paths the client wrappers request. The server side is REGENERATED here rather
 * than read from `apiRouteCatalog.generated.json`, so a rename that skipped the
 * regeneration step still fails this test.
 */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateApiRouteCatalog } from '../../scripts/generate-api-route-catalog.js';
import { findUnmountedClientPaths, scanClientApiPaths } from './clientApiPaths.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Call sites whose path this scanner cannot fold to a literal, each with the
 * reason. An entry is a review signal, not a silent skip: the scan's unresolved
 * set must equal this list EXACTLY, so a wrapper shape the scanner stops
 * understanding fails the suite instead of quietly shrinking the guard.
 *
 * Keyed by file plus the expression text — never by line number, so an edit
 * above a call site does not churn this list (root AGENTS.md, "Generated
 * manifests are addressed by content, never by position").
 */
const CALLER_SUPPLIED_PATH_SITES = [
  // `fetchByIds(path, ids)` is the shared id-batching wrapper; its path comes
  // from callers across client/src, outside the scanned services directory.
  { file: 'client/src/services/apiBatch.js', expression: '`${path}?${params}`' },
  // `importFile(path, file, …)` is a module-local multipart-upload helper with a
  // block body, so its `path` parameter is only bound at its own call sites.
  { file: 'client/src/services/apiTimeline.js', expression: 'path' },
];

const describeSite = (site) => `${site.file}: ${site.expression}`;

const catalog = generateApiRouteCatalog(REPO_ROOT);
const serverPaths = catalog.routes.map((route) => route.path);
const { paths: clientPaths, unresolved } = scanClientApiPaths({ repoRoot: REPO_ROOT });

describe('client ↔ server API route parity', () => {
  it('resolves every client API path to a mounted server route', () => {
    // Guards against a vacuously green run: a scan that stopped finding call
    // sites would report zero mismatches below.
    expect(clientPaths.length).toBeGreaterThan(1000);
    expect(clientPaths.map((entry) => entry.path)).toContain('/api/settings/features/:p');

    const unmounted = findUnmountedClientPaths(clientPaths, serverPaths);
    expect(unmounted.map((site) => `${describeSite(site)} → ${site.path}`)).toEqual([]);
  });

  it('declares every call site whose path it cannot resolve', () => {
    expect(unresolved.map(describeSite).sort())
      .toEqual(CALLER_SUPPLIED_PATH_SITES.map(describeSite).sort());
  });

  it('reports the client wrappers stranded by a renamed server mount prefix', () => {
    const renamed = serverPaths.map((route) =>
      route.replace(/^\/api\/games(?=\/|$)/, '/api/games-renamed'));
    expect(renamed).not.toEqual(serverPaths);

    const stranded = findUnmountedClientPaths(clientPaths, renamed);
    expect(stranded.length).toBeGreaterThan(0);
    // The failure has to name BOTH sides for a human to act on it: the client
    // module still pointing at the old prefix, and the path it now 404s on.
    expect([...new Set(stranded.map((site) => site.file))]).toContain('client/src/services/apiGames.js');
    expect(stranded.every((site) => site.path.startsWith('/api/games'))).toBe(true);
  });

  // ── bypass probes ─────────────────────────────────────────────────────────
  // Each proves the matcher still reports a real mismatch. Stub either scanner
  // to return nothing and its probe goes red, so neither extractor can degrade
  // into a permanently-passing parity assertion.

  it('reports an unmounted client path (client-extractor bypass probe)', () => {
    const scanned = scanClientApiPaths({
      sources: {
        'apiProbe.js': [
          "import { request } from './apiCore.js';",
          "const thing = (id, rest = '') => `/definitely-not-mounted/${encodeURIComponent(id)}${rest}`;",
          'export const getProbe = (id) => request(thing(id));',
          "export const listProbe = () => request('/sync/checksum-probe');",
          'export const streamProbe = () => fetch(`${API_BASE}/sync/stream-probe`);',
        ].join('\n'),
      },
    });

    expect(scanned.paths.map((entry) => entry.path))
      .toEqual(['/api/definitely-not-mounted/:p', '/api/sync/checksum-probe', '/api/sync/stream-probe']);
    const mounted = ['/api/sync/checksum-probe', '/api/sync/stream-probe'];
    expect(findUnmountedClientPaths(scanned.paths, mounted).map((site) => site.path))
      .toEqual(['/api/definitely-not-mounted/:p']);
  });

  it('builds a populated server route table covering a known route (server-extractor bypass probe)', () => {
    expect(catalog.routes.length).toBeGreaterThan(1000);
    expect(catalog.mounts).toContain('/api/sync');
    expect(serverPaths).toContain('/api/sync/:category/checksum');
    // An empty table must strand every client path rather than pass silently.
    expect(findUnmountedClientPaths(clientPaths, []).length).toBe(clientPaths.length);
  });
});
