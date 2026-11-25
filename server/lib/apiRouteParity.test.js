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
 * The reverse direction is checked too (#16393): a mounted route that no client
 * wrapper reaches must sit in `apiRouteCallerAllowlist.js` under the caller class
 * that justifies it, so an uncalled route is a decision rather than an accident.
 *
 * This closes that boundary by diffing two static scans of the real tree:
 * `apiRouteGraph.js` for the mounted server routes (the inventory the API
 * Explorer serves) and `clientApiPaths.js` for the paths the client wrappers
 * request. Both are derived fresh from source here, so neither side can be a
 * stale copy of the tree it describes.
 */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getApiRouteCatalog } from './apiRouteGraph.js';
import { findUncalledServerRoutes, findUnmountedClientPaths, scanClientApiPaths } from './clientApiPaths.js';
import { ROUTE_CALLER_CLASSES, UNCALLED_ROUTE_ALLOWLIST } from './apiRouteCallerAllowlist.js';

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

const allowlistClassOf = new Map(Object.entries(UNCALLED_ROUTE_ALLOWLIST)
  .flatMap(([callerClass, paths]) => paths.map((route) => [route, callerClass])));
const describeRoute = (route) => `${route.methods.join('/')} ${route.path}`;

const describeSite = (site) => `${site.file}: ${site.expression}`;

const catalog = getApiRouteCatalog();
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

  // ── reverse direction: mounted routes with no client caller ────────────────

  it('has a client caller or a justified allowlist entry for every mounted route', () => {
    const uncalled = findUncalledServerRoutes(catalog.routes, clientPaths);
    expect(
      uncalled.filter((route) => !allowlistClassOf.has(route.path)).map(describeRoute),
      'mounted routes nothing calls: delete the route, or add it to apiRouteCallerAllowlist.js under the class of its caller',
    ).toEqual([]);
  });

  it('keeps the allowlist honest: every entry is mounted, still uncalled, unique and in a known class', () => {
    const uncalled = new Set(findUncalledServerRoutes(catalog.routes, clientPaths).map((route) => route.path));
    const entries = Object.values(UNCALLED_ROUTE_ALLOWLIST).flat();
    expect(entries.filter((route, index) => entries.indexOf(route) !== index), 'duplicate entries').toEqual([]);
    expect(Object.keys(UNCALLED_ROUTE_ALLOWLIST).filter((callerClass) => !ROUTE_CALLER_CLASSES[callerClass])).toEqual([]);
    expect(entries.filter((route) => !serverPaths.includes(route)), 'entries for routes that are no longer mounted').toEqual([]);
    expect(entries.filter((route) => !uncalled.has(route)), 'entries whose route a client now calls').toEqual([]);
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

  it('reports a mounted route with no client caller and no allowlist entry (reverse bypass probe)', () => {
    const probe = [
      { method: 'GET', path: '/api/definitely-uncalled-probe' },
      { method: 'POST', path: '/api/definitely-uncalled-probe' },
      { method: 'GET', path: '/api/probe-called/:id' },
      { method: 'GET', path: '/api/probe-docs/*docPath' },
    ];
    const probeClient = [{ path: '/api/probe-called/:p' }, { path: '/api/probe-docs/:p/:p' }];
    const uncalled = findUncalledServerRoutes(probe, probeClient);
    expect(uncalled).toEqual([{ path: '/api/definitely-uncalled-probe', methods: ['GET', 'POST'] }]);
    expect(uncalled.filter((route) => !allowlistClassOf.has(route.path)).map(describeRoute))
      .toEqual(['GET/POST /api/definitely-uncalled-probe']);
    // An empty client scan must leave every mounted route uncalled rather than pass silently.
    expect(findUncalledServerRoutes(catalog.routes, []).length).toBeGreaterThan(1000);
  });

  it('does not count a client id wrapper as a caller of a static sibling route (sibling-param bypass probe, #18655)', () => {
    const probe = [
      { method: 'GET', path: '/api/probe/:id' },
      { method: 'GET', path: '/api/probe/static' },
      { method: 'GET', path: '/api/probe/:id/child' },
      { method: 'GET', path: '/api/probe/static/child' },
      { method: 'GET', path: '/api/probe-alone/static' },
    ];
    // `:p` is a fully dynamic client segment: it reaches the param routes, and a literal
    // only when no mounted sibling has a param at that position.
    const uncalled = findUncalledServerRoutes(probe, [{ path: '/api/probe/:p' }, { path: '/api/probe/:p/child' }, { path: '/api/probe-alone/:p' }]);
    expect(uncalled.map((route) => route.path)).toEqual(['/api/probe/static', '/api/probe/static/child']);
    // A wrapper that names the literal does reach it.
    expect(findUncalledServerRoutes(probe, [{ path: '/api/probe/:p' }, { path: '/api/probe/static' }, { path: '/api/probe/:p/child' }, { path: '/api/probe/static/child' }, { path: '/api/probe-alone/:p' }]))
      .toEqual([]);
  });
});
