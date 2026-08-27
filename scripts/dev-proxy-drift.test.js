/**
 * Drift guard for the server's owned URL prefixes, in both directions.
 *
 * Under `npm run dev` (and under PM2, which runs the UI as the Vite dev server)
 * the browser talks to :5554, so anything the API serves must be proxied to
 * :5555 — and anything the CLIENT routes must NOT be. Both mistakes fail
 * quietly, which is why they are pinned here rather than left to review:
 *
 *   - a MISSING proxy context is answered by Vite's SPA fallback with
 *     index.html and a 200, so a binary loader parses HTML and reports
 *     something unrelated to the cause (`/data/image-to-3d` was absent, and the
 *     GLB viewer died on "Unexpected token '<' ... is not valid JSON");
 *   - an OVER-BROAD context steals a page: Vite matches a plain context with a
 *     bare `url.startsWith`, so a `'/data'` key would also capture the `/data`
 *     and `/datadog` routes and hand the browser the API's built index.html.
 *
 * Production has the same hole on the other side — the SPA fallback in
 * `server/index.js` skips a request only when its path carries a file
 * extension. `SERVER_OWNED_PREFIXES` is what closes it, and the third section
 * below covers the one failure neither the proxy nor the terminator can see
 * alone: a client route added UNDER a server-owned prefix, which the terminator
 * would 404 with nothing failing near the new route.
 *
 * Full story in docs/PORTS.md.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { NAV_COMMANDS } from '../server/lib/navManifest.js';
import { ASSET_ROUTE_PREFIXES, SERVER_OWNED_PREFIXES } from '../server/lib/assetRoutePrefixes.js';
import { ASSET_MOUNTS } from '../server/services/assetMounts.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(REPO_ROOT, rel), 'utf8');

/**
 * Every proxy context in the dev server config.
 *
 * Read out of the source text rather than by importing the config and calling
 * it: this suite runs on the SERVER test runner, whose CI job installs only the
 * server's dependencies, so `import('../client/vite.config.js')` dies on
 * `@vitejs/plugin-react` with ERR_MODULE_NOT_FOUND (it passes locally, where
 * every workspace is installed — don't "improve" it back into an import).
 * The capture keeps a leading `^` because that character is what makes a
 * context a regex, and telling those apart is the whole point below.
 */
function devProxyContexts(source) {
  const proxyBlock = source.slice(source.indexOf('proxy: {'));
  return [...proxyBlock.matchAll(/['"](\^?\/[^'"]*)['"]\s*:\s*\{/g)].map(([, context]) => context);
}

/**
 * Vite's own matcher, mirrored from `doesProxyContextMatchUrl` — a leading `^`
 * makes the context a regex, anything else is a bare prefix test. Re-deriving
 * it here is the point: the bug this guards is a context whose match is wider
 * than it looks.
 */
const proxyMatches = (context, url) =>
  (context[0] === '^' && new RegExp(context).test(url)) || url.startsWith(context);

const navPaths = NAV_COMMANDS.map((command) => command.path);

/**
 * Every path the client router declares, with nesting resolved.
 *
 * NOT just `NAV_COMMANDS`: `client/src/AGENTS.md` requires a selectable view to
 * register only its BASE path in the nav manifest while its `:id` detail route
 * lives in `App.jsx` alone. A convention-following `<Route path="data/:category">`
 * would therefore be invisible to a nav-manifest-only check — and the terminator
 * would 404 it in production with nothing failing near the new route.
 *
 * Nesting has to be RESOLVED, not read off each tag, because App.jsx nests:
 * `<Route path="media" …><Route path="image" …/></Route>` is `/media/image`.
 * That takes both halves — matching each opener's real end, and popping on its
 * closer — and getting either wrong fails SILENTLY, as a guard that passes.
 * Hence the hand-rolled scan below rather than a regex per tag: a tag's
 * attributes contain `>` inside JSX expressions (`element={<MediaGen />}`), so
 * anything matching `<Route[^>]*>` ends the tag mid-attribute. Parsing properly
 * would mean pulling a JSX parser into the SERVER test runner, whose CI job
 * installs only the server's dependencies — so this tracks depth itself.
 */
function clientRoutePaths(source) {
  const paths = [];
  const stack = [];
  // Drive off BOTH tags: the closer is what unwinds nesting. Reading only
  // openers makes the stack grow forever, so everything after the first
  // container route inherits its segment (`/sprites` becomes `/media/sprites`)
  // and a later `/data/...` page hides behind that prefix — a silent false pass
  // in exactly the case this scan exists for.
  const TAGS = /<Route(?![A-Za-z])|<\/Route\s*>/g;
  let match;
  while ((match = TAGS.exec(source)) !== null) {
    if (match[0][1] === '/') { stack.pop(); continue; }
    // Find the real end of the tag. `>` also appears INSIDE attributes
    // (`element={<MediaGen />}`), so track brace depth and quotes rather than
    // stopping at the first one.
    let depth = 0;
    let quote = null;
    let end = -1;
    for (let j = TAGS.lastIndex; j < source.length; j++) {
      const char = source[j];
      if (quote) { if (char === quote) quote = null; continue; }
      if (char === '"' || char === "'" || char === '`') { quote = char; continue; }
      if (char === '{') depth += 1;
      else if (char === '}') depth -= 1;
      else if (char === '>' && depth === 0) { end = j; break; }
    }
    if (end === -1) break;
    const attrs = source.slice(TAGS.lastIndex, end);
    const selfClosing = attrs.trimEnd().endsWith('/');
    // An index route (no `path`) resolves to its parent, and a pathless layout
    // route adds no segment — both are a null frame on the stack.
    const path = attrs.match(/\bpath="([^"]*)"/)?.[1] ?? null;
    if (path !== null) {
      const joined = [...stack, path].filter((segment) => segment).join('/').replace(/\/+/g, '/');
      paths.push(joined.startsWith('/') ? joined : `/${joined}`);
    }
    if (!selfClosing) stack.push(path);
    TAGS.lastIndex = end + 1;
  }
  return paths;
}

describe('vite dev proxy vs the server and the client router', () => {
  // The mounts come from the table `server/index.js` mounts from, not from a
  // regex over its source — that table is why the two cannot disagree.
  const contexts = devProxyContexts(read('client/vite.config.js'));

  it('finds the prefixes and the proxy contexts it is comparing', () => {
    // An empty list on either side would make every assertion below vacuously
    // true — this is the one that fails if the wiring itself breaks.
    expect(ASSET_ROUTE_PREFIXES.length).toBeGreaterThan(5);
    expect(contexts).toContain('^/api(?:/|$)');
    expect(navPaths.length).toBeGreaterThan(5);
  });

  it('proxies an asset under every mount the server serves', () => {
    const unproxied = ASSET_ROUTE_PREFIXES.filter(
      (route) => !contexts.some((context) => proxyMatches(context, `${route}/probe.bin`)),
    );
    expect(unproxied).toEqual([]);
  });

  it('leaves every client route to the dev server', () => {
    const stolen = navPaths.filter(
      (path) => contexts.some((context) => proxyMatches(context, path)),
    );
    expect(stolen).toEqual([]);
  });
});

describe('the asset table vs what the server mounts', () => {
  it('has a mount, in order, for every asset route prefix', () => {
    // `ASSET_MOUNTS` is what actually gets mounted; the prefix list is what the
    // dev proxy is checked against. A route in one and not the other is drift.
    expect(ASSET_MOUNTS.map((mount) => mount.route)).toEqual(ASSET_ROUTE_PREFIXES);
    expect(ASSET_MOUNTS.every((mount) => typeof mount.dir === 'function')).toBe(true);
  });

  it('serves every asset route from inside a terminated namespace', () => {
    // A mount outside every `SERVER_OWNED_PREFIXES` entry keeps the pre-#4688
    // behaviour: an extensionless path under it answered with the SPA index.
    const prefixes = SERVER_OWNED_PREFIXES.map(({ prefix }) => prefix);
    const unterminated = ASSET_ROUTE_PREFIXES.filter(
      (route) => !prefixes.some((prefix) => route.startsWith(`${prefix}/`)),
    );
    expect(unterminated).toEqual([]);
  });
});

describe('server-owned prefixes vs the client router', () => {
  const routePaths = [...new Set([...navPaths, ...clientRoutePaths(read('client/src/App.jsx'))])];

  it('resolves App.jsx\'s nesting in BOTH directions', () => {
    // Asserting on the UNION would prove nothing — NAV_COMMANDS alone satisfies
    // it, so `clientRoutePaths` could return [] and stay green. Both halves of
    // the scan get their own probe because each fails silently, as a PASS:
    const scanned = clientRoutePaths(read('client/src/App.jsx'));

    // ...a child must inherit its parent's segment (a per-tag regex ends at the
    // `>` inside `element={<MediaGen />}` and reads this as a sibling, `/image`);
    expect(scanned).toContain('/media/image');
    expect(scanned).not.toContain('/image');

    // ...and a closer must POP it again. Without that the stack only grows, and
    // every route declared after the first container inherits its prefix — which
    // is what hides a later `/data/...` page from the check below.
    expect(scanned).toContain('/sprites');
    expect(scanned).toContain('/writers-room');
    expect(routePaths).toContain('/data');
  });

  it('declares every client route that lives under a server-owned prefix', () => {
    // The failure this catches: someone adds a `/data/backups` page. The
    // terminator 404s it, the page simply does not exist, and nothing points at
    // `assetRoutePrefixes.js`. Adding the route to that entry's `spaPaths` is
    // the fix — this test is what says so.
    const undeclared = SERVER_OWNED_PREFIXES.flatMap(({ prefix, spaPaths }) => (
      routePaths.filter((path) => (
        (path === prefix || path.startsWith(`${prefix}/`)) && !spaPaths.includes(path)
      ))
    ));
    expect(undeclared).toEqual([]);
  });
});

describe('server/index.js route registration order', () => {
  // `mountAssetRoutes` installs a terminating 404 on /api and /sdapi, so
  // registration order became load-bearing: a router added BELOW the call is
  // shadowed by that 404 and never runs. Nothing else reads this file any
  // more — the drift guard reads the tables — so this is what catches it.
  const source = read('server/index.js');

  it('registers every API router above the terminators', () => {
    const mountIndex = source.indexOf('mountAssetRoutes(app)');
    expect(mountIndex).toBeGreaterThan(0);
    const apiMounts = [...source.matchAll(/app\.use\(\s*'(\/(?:api|sdapi)[^']*)'/g)];
    // A refactor to non-literal mounts would leave the regex matching nothing
    // and the assertion below vacuously true.
    expect(apiMounts.length).toBeGreaterThan(20);
    const shadowed = apiMounts
      .filter((match) => match.index > mountIndex)
      .map(([, route]) => route);
    expect(shadowed).toEqual([]);
  });

  it('leaves no asset mount behind in the file the table replaced', () => {
    // An inline `app.use('/data/x', express.static(…))` added back here would sit
    // BELOW the terminator and be dead — and would miss the dev proxy too.
    expect(source).not.toMatch(/app\.use\(\s*'\/data[^']*',\s*express\.static/);
  });
});
