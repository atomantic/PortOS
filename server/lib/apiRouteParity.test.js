/**
 * Client ↔ server API route parity.
 *
 * `client/src/services/api*.js` is where the browser mostly learns which URL a feature
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
];

/**
 * Services-pass call sites whose LAST segment is chosen at run time from a closed set of server literals
 * (`controlFaceTime(action)` posts to `/facetime/call`, `/hangup` or `/probe`), so the forward check sees a
 * `:p` where the server mounts literals and cannot prove them. The unmounted set must equal this list EXACTLY:
 * a new site that fails the forward check is a real mismatch, and a listed one that starts matching must leave.
 * The server routes behind them sit in the `client-dynamic` class when the reverse scan cannot reach them.
 */
const DYNAMIC_SEGMENT_SITES = [
  { file: 'client/src/services/apiVoice.js', expression: '`/voice/facetime/${action}`', path: '/api/voice/facetime/:p' },
  // `fineTunePath(profileId, jobId)` also folds its no-job branch, which a cancel or promote never takes.
  // Only that synthetic path is exempt: the real `/fine-tune/:p/cancel` path still has to be mounted.
  { file: 'client/src/services/apiVoice.js', expression: '`${fineTunePath(profileId, jobId)}/cancel`', path: '/api/voice/profiles/:p/fine-tune/cancel' },
  { file: 'client/src/services/apiVoice.js', expression: '`${fineTunePath(profileId, jobId)}/promote`', path: '/api/voice/profiles/:p/fine-tune/promote' },
];
// What `controlFaceTime(action)` can reach: the forward check cannot see these, so pin that they stay mounted.
const FACETIME_ACTIONS = ['call', 'hangup', 'probe'];

const allowlistClassOf = new Map(Object.entries(UNCALLED_ROUTE_ALLOWLIST)
  .flatMap(([callerClass, paths]) => paths.map((route) => [route, callerClass])));
const describeRoute = (route) => `${route.methods.join('/')} ${route.path}`;

const describeSite = (site) => `${site.file}: ${site.expression}`;
const describeSitePath = (site) => `${describeSite(site)} → ${site.path}`;

const catalog = getApiRouteCatalog();
const serverPaths = catalog.routes.map((route) => route.path);
const { paths: clientPaths, unresolved, referenced } = scanClientApiPaths({ repoRoot: REPO_ROOT });
// Everything any client file reaches; the unmounted check keeps using `clientPaths` only.
const reachedPaths = [...clientPaths, ...referenced.map((path) => ({ path }))];

describe('client ↔ server API route parity', () => {
  it('resolves every client API path to a mounted server route', () => {
    // Guards against a vacuously green run: a scan that stopped finding call
    // sites would report zero mismatches below.
    expect(clientPaths.length).toBeGreaterThan(1000);
    expect(clientPaths.map((entry) => entry.path)).toContain('/api/settings/features/:p');

    const unmounted = findUnmountedClientPaths(clientPaths, serverPaths);
    expect([...new Set(unmounted.map(describeSitePath))].sort())
      .toEqual(DYNAMIC_SEGMENT_SITES.map(describeSitePath).sort());
    expect(FACETIME_ACTIONS.filter((action) => !serverPaths.includes(`/api/voice/facetime/${action}`)),
      'facetime actions the client can post that the server no longer mounts').toEqual([]);
  });

  it('declares every call site whose path it cannot resolve', () => {
    expect(unresolved.map(describeSite).sort())
      .toEqual(CALLER_SUPPLIED_PATH_SITES.map(describeSite).sort());
  });

  it('reports the client wrappers stranded by a renamed server mount prefix', () => {
    const renamed = serverPaths.map((route) =>
      route.replace(/^\/api\/games(?=\/|$)/, '/api/games-renamed'));
    expect(renamed).not.toEqual(serverPaths);

    const declared = new Set(DYNAMIC_SEGMENT_SITES.map(describeSitePath));
    const stranded = findUnmountedClientPaths(clientPaths, renamed).filter((site) => !declared.has(describeSitePath(site)));
    expect(stranded.length).toBeGreaterThan(0);
    // The failure has to name BOTH sides for a human to act on it: the client
    // module still pointing at the old prefix, and the path it now 404s on.
    expect([...new Set(stranded.map((site) => site.file))]).toContain('client/src/services/apiGames.js');
    expect(stranded.every((site) => site.path.startsWith('/api/games'))).toBe(true);
  });

  // ── reverse direction: mounted routes with no client caller ────────────────

  it('has a client caller or a justified allowlist entry for every mounted route', () => {
    const uncalled = findUncalledServerRoutes(catalog.routes, reachedPaths);
    expect(
      uncalled.filter((route) => !allowlistClassOf.has(route.path)).map(describeRoute),
      'mounted routes nothing calls: delete the route, or add it to apiRouteCallerAllowlist.js under the class of its caller',
    ).toEqual([]);
  });

  it('keeps the allowlist honest: every entry is mounted, still uncalled, unique and in a known class', () => {
    const uncalled = new Set(findUncalledServerRoutes(catalog.routes, reachedPaths).map((route) => route.path));
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

  // ── widened client scan (#18656): each call shape marks a route reached; a mention does not ──

  const scanProbe = (sources) => scanClientApiPaths({ sources });
  const reachedBy = (sources) => scanProbe(sources).referenced;

  it('marks a route reached from a URL builder, api.<verb>, request and a component fetch/EventSource (call-shape bypass probes)', () => {
    const scanned = scanProbe({
      'apiProbe.js': [
        "import api from './apiCore';",
        "import { API_BASE } from './apiCore';",
        'export const probeStreamUrl = (id) => `${API_BASE}/probe-builder/${encodeURIComponent(id)}/stream`;',
        "export const sendProbe = (id) => api.post(`/probe-verb/${id}/send`, {});",
      ].join('\n'),
      'components/ProbePanel.jsx': [
        "const load = () => fetch('/api/probe-component/list');",
        'const open = (id) => new EventSource(`/api/probe-events/${id}`);',
        "const ask = () => request('/probe-request/ask');",
        'const icon = (base, id) => `${base}/api/probe-icon/${id}`;',
        "const forward = () => api.get('/probe-page/read');",
      ].join('\n'),
    });
    expect(scanned.referenced).toEqual(expect.arrayContaining([
      '/api/probe-builder/:p/stream', '/api/probe-verb/:p/send', '/api/probe-component/list',
      '/api/probe-events/:p', '/api/probe-request/ask', '/api/probe-icon/:p', '/api/probe-page/read',
    ]));
    // The services pass folds api.<verb> and request the same way, and reports them to the forward check.
    expect(scanned.paths.map((entry) => entry.path)).toContain('/api/probe-verb/:p/send');
    const server = [
      { method: 'GET', path: '/api/probe-component/list' },
      { method: 'GET', path: '/api/probe-events/:id' },
      { method: 'GET', path: '/api/probe-never-called' },
    ];
    expect(findUncalledServerRoutes(server, scanned.referenced.map((path) => ({ path }))).map((route) => route.path))
      .toEqual(['/api/probe-never-called']);
  });

  it('does not let a component literal reach the forward check, and reads no unresolved site from one', () => {
    const scanned = scanProbe({ 'pages/Help.jsx': "const url = '/api/probe-help/not-mounted';" });
    expect(scanned.referenced).toEqual(['/api/probe-help/not-mounted']);
    expect(scanned.paths).toEqual([]);
    expect(scanned.unresolved).toEqual([]);
    expect(findUnmountedClientPaths(scanned.paths, [])).toEqual([]);
  });

  it('treats comments, logs, comparisons, prose, tests and fixtures as mentions, not calls (mention probes)', () => {
    const mentions = {
      'components/Mentions.jsx': [
        "// fetch('/api/probe-comment/one')",
        "/* const x = '/api/probe-block-comment/one'; */",
        "console.log('/api/probe-log/one');",
        "console.warn(`calling /api/probe-log/${id}`);",
        "const help = 'GET /api/probe-prose/one returns the list';",
        "const gone = '/api/probe-trailing-prose/one is gone';",
        "if (url.startsWith('/api/probe-startswith/')) return;",
        "if (url === '/api/probe-equals/one') return;",
        "switch (url) { case '/api/probe-case/one': break; }",
        "const docs = <code>GET /api/probe-jsx-text/one</code>;",
        "const bare = '/api/';",
        "console.log(\"api.get('/probe-quoted-verb/one')\");",
        "const example = \"request('/probe-quoted-request/one')\";",
        "const tail = `/api/${kind}-gen/${id}/events`;",
      ].join('\n'),
      'components/Mentions.test.jsx': "fetch('/api/probe-in-test/one');",
      'test/fixtureMocks.jsx': "const url = '/api/probe-fixture/one';",
    };
    expect(reachedBy(mentions)).toEqual([]);
    // Control: the same literal as a real URL value IS seen, so the probe is not vacuous.
    expect(reachedBy({ 'components/Real.jsx': "const url = '/api/probe-control/one';" })).toEqual(['/api/probe-control/one']);
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
