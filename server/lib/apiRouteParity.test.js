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
import { parse } from '@babel/parser';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getApiRouteCatalog } from './apiRouteGraph.js';
import { findUncalledServerRoutes, findUnmountedClientPaths, scanClientApiPaths } from './clientApiPaths.js';
import { OPERATOR_SCRIPT_CALLER_FILES, ROUTE_CALLER_CLASSES, UNCALLED_ROUTE_ALLOWLIST } from './apiRouteCallerAllowlist.js';

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

const allowlistEntries = Object.values(UNCALLED_ROUTE_ALLOWLIST).flat();
const routeKey = ({ method, path }) => `${method} ${path}`;
const expandRoutes = (routes) => routes.flatMap(({ path, methods }) =>
  methods.map((method) => ({ path, method })));
const covers = (entry, route) => entry === route.path || entry === routeKey(route);

// These are the transports actually used by the listed scripts. Parse their call
// expressions so comments, prose, and standalone path constants cannot pass.
const propertyValue = (object, key) => object?.properties?.find((property) =>
  !property.computed && (property.key?.name ?? property.key?.value) === key)?.value;

function scriptRequestKey({ callee, arguments: [input, options] }) {
  const stream = callee.object?.name === 'client' && callee.property?.name === 'stream';
  const request = ['read', 'fetch'].includes(callee.name)
    || (callee.operator === '??' && callee.right.name === 'requestApi');
  if (!stream && !request) return null;

  const url = stream ? propertyValue(input, 'path') : input;
  const method = stream ? propertyValue(input, 'method')?.value
    : options ? propertyValue(options, 'method')?.value : 'GET';
  const urlText = url?.type === 'TemplateLiteral'
    ? url.quasis.map((part) => part.value.cooked).join(':p').replace(/^:p(?=\/api\/)/, '')
    : url?.value;
  if (typeof urlText !== 'string' || !urlText.startsWith('/api/') || typeof method !== 'string') return null;
  return `${method.toUpperCase()} ${urlText.split(/[?#]/, 1)[0]}`;
}

function scriptRequestKeys(source) {
  const keys = new Set();
  function visit(node) {
    if (!node?.type) return;
    if (node.type === 'CallExpression') {
      const key = scriptRequestKey(node);
      if (key) keys.add(key);
    }
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) child.forEach(visit);
      else visit(child);
    }
  }
  visit(parse(source, { sourceType: 'module' }).program);
  return keys;
}

const describeSite = (site) => `${site.file}: ${site.expression}`;
const describeSitePath = (site) => `${describeSite(site)} → ${site.path}`;

const catalog = getApiRouteCatalog();
const serverPaths = catalog.routes.map((route) => route.path);
const { paths: clientPaths, unresolved, referenced } = scanClientApiPaths({ repoRoot: REPO_ROOT });
const uncalledRoutes = expandRoutes(findUncalledServerRoutes(catalog.routes, referenced));

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

  it('has a client caller or a justified allowlist entry for every mounted method', () => {
    expect(
      uncalledRoutes.filter((route) => !allowlistEntries.some((entry) => covers(entry, route))).map(routeKey),
      'mounted methods with no production caller: delete the handler and any unused wrapper, or cite its caller in apiRouteCallerAllowlist.js',
    ).toEqual([]);
  });

  it('keeps the allowlist honest: every entry covers only mounted, uncalled methods', () => {
    const uncalled = new Set(uncalledRoutes.map(routeKey));
    expect(new Set(allowlistEntries).size, 'duplicate entries').toBe(allowlistEntries.length);
    expect(Object.keys(UNCALLED_ROUTE_ALLOWLIST).filter((callerClass) => !ROUTE_CALLER_CLASSES[callerClass])).toEqual([]);
    expect(allowlistEntries.filter((entry) => !catalog.routes.some((route) => covers(entry, route))),
      'entries for methods or paths that are no longer mounted').toEqual([]);
    expect(catalog.routes.filter((route) => allowlistEntries.filter((entry) => covers(entry, route)).length > 1).map(routeKey),
      'methods covered by multiple entries').toEqual([]);
    expect(catalog.routes.filter((route) => allowlistEntries.some((entry) => covers(entry, route)) && !uncalled.has(routeKey(route))).map(routeKey),
      'allowlisted methods a client now calls').toEqual([]);
  });

  it('requires a first-party script request with the matching HTTP method for each operator-script route', () => {
    const requests = new Set(OPERATOR_SCRIPT_CALLER_FILES.flatMap((file) =>
      [...scriptRequestKeys(readFileSync(path.join(REPO_ROOT, file), 'utf8'))]));
    const uncovered = catalog.routes
      .filter((route) => UNCALLED_ROUTE_ALLOWLIST['operator-script'].some((entry) => covers(entry, route)))
      .map(routeKey)
      .filter((key) => !requests.has(key.replace(/\/:[\w]+/g, '/:p')));
    expect(uncovered, 'cite and register a calling script or remove the unused route').toEqual([]);
  });

  it('does not treat prose, comments, URL values or the wrong HTTP method as script callers', () => {
    const keys = scriptRequestKeys([
      "// fetch('/api/probe/ignored');",
      'const docs = "fetch(\'/api/probe/quoted\')";',
      "const unused = '/api/probe/unused';",
      "fetch('/api/probe/unknown-method', { method });",
      'fetch(`${base}/api/probe/${encodeURIComponent(id)}`, { method: "POST" });',
    ].join('\n'));
    expect([...keys]).toEqual(['POST /api/probe/:p']);
    expect(keys.has('GET /api/probe/:p')).toBe(false);
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

  it('checks every route supplied by an imported API factory callback', () => {
    const factory = 'export function createFilmApi(pathOf) { return { render: id => request(`${pathOf(id)}/render`, { method: "POST" }) }; }';
    const { paths, referenced, unresolved } = scanClientApiPaths({
      sources: {
        'apiFilm.js': factory,
        'apiTrackFilm.js': "import { createFilmApi } from './apiFilm.js'; export const tracks = createFilmApi(id => `/tracks/${id}/film`);",
        'apiShowFilm.js': "import { createFilmApi } from './apiFilm.js'; export const shows = createFilmApi((id) => `/shows/${id}/film`);",
        'pages/Probe.jsx': [
          "import { tracks } from '../services/apiTrackFilm.js';",
          "import { shows } from '../services/apiShowFilm.js';",
          'tracks.render(id); shows.render(id);',
        ].join('\n'),
      },
    });
    expect(unresolved).toEqual([]);
    expect(referenced).toEqual([
      { path: '/api/tracks/:p/film/render', method: 'POST' },
      { path: '/api/shows/:p/film/render', method: 'POST' },
    ]);
    expect(findUnmountedClientPaths(paths, ['/api/tracks/:id/film/render']).map(site => site.path))
      .toEqual(['/api/shows/:p/film/render']);
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
    expect(expandRoutes(uncalled).filter((route) => !allowlistEntries.some((entry) => covers(entry, route))).map(routeKey))
      .toEqual(['GET /api/definitely-uncalled-probe', 'POST /api/definitely-uncalled-probe']);
    // An empty client scan must leave every mounted route uncalled rather than pass silently.
    expect(findUncalledServerRoutes(catalog.routes, []).length).toBeGreaterThan(1000);
  });

  // ── widened client scan (#18656): each call shape marks a route reached; a mention does not ──

  const scanProbe = (sources) => scanClientApiPaths({ sources });
  const reachedBy = (sources) => scanProbe(sources).referenced.map(({ path }) => path);

  it('marks a route reached from a URL builder, api.<verb>, request and a component fetch/EventSource (call-shape bypass probes)', () => {
    const scanned = scanProbe({
      'apiProbe.js': [
        "import api from './apiCore';",
        "import { API_BASE } from './apiCore';",
        'export const probeStreamUrl = (id) => `${API_BASE}/probe-builder/${encodeURIComponent(id)}/stream`;',
        "export const sendProbe = (id) => api.post(`/probe-verb/${id}/send`, {});",
      ].join('\n'),
      'components/ProbePanel.jsx': [
        "import { probeStreamUrl, sendProbe } from '../services/apiProbe';",
        "const load = () => fetch('/api/probe-component/list');",
        'const open = (id) => new EventSource(`/api/probe-events/${id}`);',
        "const ask = () => request('/probe-request/ask');",
        'const icon = (base, id) => `${base}/api/probe-icon/${id}`;',
        "const forward = () => api.get('/probe-page/read');",
        'const render = id => sendProbe(probeStreamUrl(id));',
      ].join('\n'),
    });
    expect(scanned.referenced.map(({ path }) => path)).toEqual(expect.arrayContaining([
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
    expect(findUncalledServerRoutes(server, scanned.referenced).map((route) => route.path))
      .toEqual(['/api/probe-never-called']);
  });

  it('does not let unused exports supply a caller for a mounted method', () => {
    const probe = [
      { method: 'GET', path: '/api/probe/dead' },
      { method: 'GET', path: '/api/probe/dead-url' },
      { method: 'GET', path: '/api/probe/helper' },
      { method: 'GET', path: '/api/probe/called' },
    ];
    const { referenced, paths } = scanProbe({
      'apiProbe.js': [
        "const requestProbe = (path) => request(path);",
        "export const dead = () => requestProbe('/probe/dead');",
        "export const deadUrl = () => '/api/probe/dead-url';",
        "export function helper() { return request('/probe/helper'); }",
        "export const live = () => Promise.all([helper(), request('/probe/called')]);",
      ].join('\n'),
      'apiProbeBarrel.js': "export { live as load, dead } from './apiProbe.js';",
      'pages/Probe.jsx': "import * as probe from '../services/apiProbeBarrel'; probe.load();",
      'pages/Probe.test.jsx': "import { dead } from '../services/apiProbe'; dead();",
    });

    expect(findUncalledServerRoutes(probe, referenced).map(({ path }) => path))
      .toEqual(['/api/probe/dead', '/api/probe/dead-url']);
    expect(paths.map(({ path }) => path)).toContain('/api/probe/dead');
  });

  it.each([
    ['request default', 'apiProbe.js', 'request(`/probe/${id}`)'],
    ['request options without a method', 'apiProbe.js', "request(`/probe/${id}`, { headers: { method: 'DELETE' } })"],
    ['API verb', 'pages/Probe.jsx', 'api.get(`/probe/${id}`)'],
    ['direct fetch', 'pages/Probe.jsx', 'fetch(`/api/probe/${id}`)'],
    ['API_BASE fetch', 'apiProbe.js', 'fetch(`${API_BASE}/probe/${id}`)'],
    ['EventSource', 'pages/Probe.jsx', 'new EventSource(`/api/probe/${id}`, options)'],
  ])('reports an uncalled DELETE next to a GET reached by %s', (_name, file, call) => {
    const probe = [{ method: 'GET', path: '/api/probe/:id' }, { method: 'DELETE', path: '/api/probe/:id' }];
    const scanned = scanProbe({ [file]: `const load = (id) => ${call};` });
    expect(findUncalledServerRoutes(probe, scanned.referenced)).toEqual([{ path: '/api/probe/:id', methods: ['DELETE'] }]);
  });

  it.each([
    ['request(`/probe/${id}`, options)', null],
    ["fetch(`/api/probe/${id}`, { method })", null],
    ["request(`/probe/${id}`, { method: 'GET', ...options })", null],
    ["request(`/probe/${id}`, { ...options, 'method': 'delete' })", 'DELETE'],
    ["api.get(`/probe/${id}`, { method: 'DELETE' })", 'DELETE'],
    ["api.post(`/probe/${id}`, { method: 'DELETE' })", 'POST'],
  ])('resolves the method for %s when the transport determines it statically', (call, method) => {
    const probe = [{ method: 'GET', path: '/api/probe/:id' }, { method: 'DELETE', path: '/api/probe/:id' }];
    const scanned = scanProbe({ 'apiProbe.js': `const send = (id) => ${call};` });
    expect(scanned.referenced).toEqual([{ path: '/api/probe/:p', method }]);
    if (method === null) expect(findUncalledServerRoutes(probe, scanned.referenced)).toEqual([]);
  });

  it('does not let a component literal reach the forward check, and reads no unresolved site from one', () => {
    const scanned = scanProbe({ 'pages/Help.jsx': "const url = '/api/probe-help/not-mounted';" });
    expect(scanned.referenced).toEqual([{ path: '/api/probe-help/not-mounted', method: null }]);
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
