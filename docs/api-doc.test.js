/**
 * Parity guard for docs/API.md.
 *
 * API.md is the hand-written REST reference — the page an integrator, a
 * companion-app author, or an agent reads before calling PortOS — and its
 * route-domain index claims to list "every mounted API prefix". Nothing
 * enforced either claim, and the document drifted in the worst direction a
 * reference can: it described endpoints that do not exist. Seventeen rows
 * pointed at paths no router had — a "Legacy OpenWorld / CyberCity" section
 * still promised that `/api/city/*` "remain[s] available" after #5890 removed
 * the router, the Digital Twin table used `/completeness` and
 * `/enrichment/categories` for routes that shipped as `/validate/completeness`
 * and `/enrich/categories`, and the genome table documented a per-rsid ClinVar
 * lookup that was never built. A reader following any of those got a 404.
 *
 * These assertions move that failure to the commit that introduces it. They
 * compare the document against `buildApiRouteCatalog()` — the same
 * source-derived inventory the API Explorer serves (`server/lib/apiRouteGraph.js`)
 * — so the guard reads exactly the route modules the server runs and cannot
 * itself be stale. Only paths are checked, never descriptions: a row's prose
 * is the author's, and a wrong path is what sends a reader to a dead URL.
 *
 * The test is colocated with the document it guards; `server/vitest.config.js`
 * globs `../docs/**` so `cd server && npm test` picks it up.
 */
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import { buildApiRouteCatalog } from '../server/lib/apiRouteGraph.js';

const DOCS_DIR = dirname(fileURLToPath(import.meta.url));
const DOC = readFileSync(join(DOCS_DIR, 'API.md'), 'utf8');
const CATALOG = buildApiRouteCatalog({ repoRoot: join(DOCS_DIR, '..') });

const REST_HEADING = '## REST Endpoints';
const INDEX_HEADING = '## Route Domain Index';
const EVENTS_HEADING = '## WebSocket Events';

const section = (from, to) => {
  const start = DOC.indexOf(from);
  const end = DOC.indexOf(to);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`API.md must keep the "${from}" section ahead of "${to}" — this guard slices on those headings`);
  }
  return DOC.slice(start, end);
};

/**
 * Route params compare by position, not by name: `/markers/:id` and
 * `/markers/:rsid` are the same operation, and renaming a param is not a
 * change any caller can observe. Query strings are documentation, not path.
 */
const normalizePath = (path) => path
  .replace(/[?#].*$/, '')
  .replace(/:[A-Za-z0-9_]+/g, ':param')
  .replace(/\/+$/, '') || '/';

/** Endpoint cells are written relative to `/api` unless they name the mount themselves. */
const absolutePath = (path) => (path.startsWith('/api/') || path.startsWith('/sdapi/') ? path : `/api${path}`);

const isApiPath = (path) => path.startsWith('/api/') || path.startsWith('/sdapi/');

/** `| METHOD | \`/path\` | description |` rows from the REST section. */
const documentedOperations = [...section(REST_HEADING, INDEX_HEADING).matchAll(/^\|\s*(GET|POST|PUT|PATCH|DELETE)\s*\|\s*`([^`]+)`/gm)]
  .map(([, method, path]) => ({ method, path: absolutePath(path) }));

/** Every backticked prefix in the route-domain index table, `/api/*` and `/sdapi/*` only. */
const indexedPrefixes = [...section(INDEX_HEADING, EVENTS_HEADING).matchAll(/^\|\s*((?:`[^`]+`(?:,\s*)?)+)\s*\|/gm)]
  .flatMap(([, cell]) => [...cell.matchAll(/`([^`]+)`/g)].map(([, prefix]) => prefix))
  .filter(isApiPath);

const liveOperations = new Set(CATALOG.routes.map(({ method, path }) => `${method} ${normalizePath(path)}`));
const livePaths = CATALOG.routes.map(({ path }) => normalizePath(path));

const isUnder = (path, prefix) => path === prefix || path.startsWith(`${prefix}/`);

describe('docs/API.md matches the mounted route graph', () => {
  it('parses the tables it guards', () => {
    // A regex that silently matches nothing would pass every assertion below.
    expect(documentedOperations.length).toBeGreaterThan(100);
    expect(indexedPrefixes.length).toBeGreaterThan(50);
    expect(CATALOG.routes.length).toBeGreaterThan(500);
  });

  it('documents no endpoint the server does not mount', () => {
    const phantom = documentedOperations
      .filter(({ method, path }) => !liveOperations.has(`${method} ${normalizePath(path)}`))
      .map(({ method, path }) => `${method} ${path}`);
    expect(phantom, [
      'docs/API.md documents endpoints no router declares. Fix the row or delete it —',
      'the live inventory is GET /api/api-docs/catalog.json (or buildApiRouteCatalog()).',
    ].join('\n')).toEqual([]);
  });

  it('indexes no route-domain prefix that has no live operation under it', () => {
    const phantom = indexedPrefixes.filter((prefix) => {
      const wanted = normalizePath(prefix);
      return !livePaths.some((path) => isUnder(path, wanted));
    });
    expect(phantom, 'docs/API.md route-domain index lists prefixes the server no longer mounts').toEqual([]);
  });

  it('covers every mounted API prefix in the index or a detailed table', () => {
    // The index says "Every mounted API prefix ... Domains documented in detail
    // above are omitted", so a mount is covered by an index row or by an
    // endpoint row at or below it. An ancestor row does not count: the index
    // already lists sub-routers such as `/api/eidoverse/world` on their own.
    const documentedPrefixes = [
      ...indexedPrefixes.map(normalizePath),
      ...documentedOperations.map(({ path }) => normalizePath(path)),
    ];
    const uncovered = CATALOG.mounts
      .filter(isApiPath)
      .filter((mount) => {
        const wanted = normalizePath(mount);
        return !documentedPrefixes.some((prefix) => isUnder(prefix, wanted));
      });
    expect(uncovered, 'server/index.js mounts API prefixes docs/API.md never mentions — add a route-domain index row').toEqual([]);
  });
});
