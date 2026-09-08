import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildApiRouteCatalog,
  getApiRouteCatalog,
  parseRouteModule,
  routeDeclarationKey,
  scanRouteGraph,
} from './apiRouteGraph.js';
import { SERVER_DIR, collectServerSources } from './testHelper.js';

const write = (root, path, source) => {
  const target = join(root, path);
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, source, 'utf8');
};

describe('API route graph scanner', () => {
  it('resolves top-level mounts, imported child routers, local subrouters, and aliases', () => {
    const root = mkdtempSync(join(tmpdir(), 'portos-api-route-graph-'));
    write(root, 'server/index.js', `
      import widgetsRoutes from './routes/widgets.js';
      app.use('/api/widgets', widgetsRoutes);
      app.use('/api/legacy-widgets', widgetsRoutes);
    `);
    write(root, 'server/routes/widgets.js', `
      import { Router } from 'express';
      import childRoutes from './widgets-child.js';
      const router = Router();
      const setupRouter = Router();
      router.get('/', handler);
      setupRouter.post('/run/:runId', handler);
      router.use('/setup', setupRouter);
      router.use('/child', childRoutes);
      export default router;
    `);
    write(root, 'server/routes/widgets-child.js', `
      import { Router } from 'express';
      const router = Router();
      router.patch('/:id', handler);
      export default router;
    `);

    const catalog = buildApiRouteCatalog({ repoRoot: root });
    expect(catalog.routes.map(({ method, path }) => `${method} ${path}`)).toEqual([
      'GET /api/legacy-widgets',
      'PATCH /api/legacy-widgets/child/:id',
      'POST /api/legacy-widgets/setup/run/:runId',
      'GET /api/widgets',
      'PATCH /api/widgets/child/:id',
      'POST /api/widgets/setup/run/:runId',
    ]);
    expect(catalog.stats).toEqual({ mounts: 2, operations: 6, declarations: 3, sourceFiles: 2 });
  });

  it('deduplicates the same operation while retaining every declaration source', () => {
    const root = mkdtempSync(join(tmpdir(), 'portos-api-route-graph-'));
    write(root, 'server/index.js', `
      import routes from './routes/index.js';
      app.use('/api/demo', routes);
    `);
    write(root, 'server/routes/index.js', `
      import { Router } from 'express';
      import first from './first.js';
      import second from './second.js';
      const router = Router();
      router.use(first);
      router.use(second);
      export default router;
    `);
    for (const name of ['first', 'second']) {
      write(root, `server/routes/${name}.js`, `
        import { Router } from 'express';
        const router = Router();
        router.get('/status', handler);
        export default router;
      `);
    }

    const catalog = buildApiRouteCatalog({ repoRoot: root });
    expect(catalog.routes).toHaveLength(1);
    expect(catalog.routes[0].sources).toEqual(['server/routes/first.js', 'server/routes/second.js']);
    expect(catalog.stats.declarations).toBe(2);
  });

  it('follows named factory returns and composed toolkit router properties', () => {
    const root = mkdtempSync(join(tmpdir(), 'portos-api-route-graph-'));
    write(root, 'server/index.js', `
      import { createRuns } from './routes/runs.js';
      import { createProviders } from './routes/providers.js';
      app.use('/api/runs', createRuns(toolkit));
      app.use('/api/providers', createProviders(toolkit));
    `);
    write(root, 'server/routes/runs.js', `
      export function createRuns(toolkit) { return toolkit.routes.runs; }
    `);
    write(root, 'server/routes/providers.js', `
      import { Router } from 'express';
      export function createProviders(toolkit) {
        const router = Router();
        router.get('/readiness', handler);
        router.use('/', toolkit.routes.providers);
        return router;
      }
    `);
    write(root, 'server/lib/aiToolkit/routes/runs.js', `
      import { Router } from 'express';
      export function createRunsRoutes() {
        const router = Router();
        router.get('/:id', handler);
        router.post('/:id/stop', handler);
        return router;
      }
    `);
    write(root, 'server/lib/aiToolkit/routes/providers.js', `
      import { Router } from 'express';
      export function createProvidersRoutes() {
        const router = Router();
        router.delete('/:id', handler);
        router.post('/:id/test', handler);
        return router;
      }
    `);

    const operations = buildApiRouteCatalog({ repoRoot: root }).routes
      .map(({ method, path }) => `${method} ${path}`);
    expect(operations).toEqual([
      'DELETE /api/providers/:id',
      'POST /api/providers/:id/test',
      'GET /api/providers/readiness',
      'GET /api/runs/:id',
      'POST /api/runs/:id/stop',
    ]);
  });
});

describe('mounted route graph', () => {
  // The coverage guards need `declarationKeys`, which the cached catalog does
  // not carry, so they share one extra scan; everything else reads the
  // process-wide catalog.
  let scan;
  const routeGraph = () => (scan ??= scanRouteGraph());

  it('shares the first-use scan across the server process', () => {
    const first = getApiRouteCatalog();
    expect(getApiRouteCatalog()).toBe(first);
    expect(first.stats.operations).toBeGreaterThan(2_000);
  });

  // Content keying trades a line number's uniqueness for a name's, so the one
  // way it can lose a route is two declarations sharing a key. Left alone the
  // Set would just swallow the second one and undercount; this makes it loud.
  it('gives every declaration in a file a distinct key', () => {
    expect(routeGraph().duplicateDeclarationKeys, [
      'Two route declarations in one file produced the same key, so the second is',
      'invisible to the coverage guard and to stats.declarations. Either it is a',
      'genuine duplicate registration (delete one), or two routers in that file',
      'share a variable name through shadowing (rename one).',
    ].join(' ')).toEqual([]);
  });

  // Both sides are fresh in-memory scans: the walk from `server/index.js`
  // versus every declaration parsed straight out of `server/routes/`. A route
  // file nothing mounts, or a subrouter nothing `use()`s, shows up here.
  it('covers every HTTP declaration mounted below /api or /sdapi', () => {
    const { declarationKeys } = routeGraph();
    const routeFiles = collectServerSources(join(SERVER_DIR, 'routes')).map((path) => join(SERVER_DIR, path));
    expect(routeFiles.length).toBeGreaterThan(100);
    const omitted = [];
    for (const file of routeFiles) {
      for (const route of parseRouteModule(file).routes) {
        // The noVNC HTML viewer intentionally lives outside /api. Its actual
        // control API is mounted at /api/remote-desktop and is cataloged.
        if (route.source === 'server/routes/remoteDesktopViewer.js') continue;
        const key = routeDeclarationKey(route);
        if (!declarationKeys.has(key)) omitted.push(key);
      }
    }
    expect(omitted).toEqual([]);
  });

  it('is a unique, complete inventory with source pointers', () => {
    const { mounts, routes } = getApiRouteCatalog();
    expect(mounts.length).toBeGreaterThan(140);
    expect(new Set(routes.map((route) => `${route.method} ${route.path}`)).size).toBe(routes.length);
    for (const route of routes) {
      expect(route.path).toMatch(/^\/(?:api|sdapi)(?:\/|$)/);
      expect(route.sources.length).toBeGreaterThan(0);
      for (const source of route.sources) {
        expect(source).toMatch(/^server\/(?:routes|lib\/aiToolkit\/routes)\/[\w./-]+\.js$/);
      }
      expect(route.sources).toEqual([...new Set(route.sources)].sort());
    }
  });

  it('pins representative nested, aliased, toolkit, and public routes', () => {
    const operations = new Set(getApiRouteCatalog().routes.map((route) => `${route.method} ${route.path}`));
    for (const operation of [
      'POST /api/brain/songbook/import/url',
      'GET /api/providers/readiness',
      'DELETE /api/providers/:id',
      'POST /api/providers/:id/test',
      'POST /api/providers/:id/refresh-models',
      'GET /api/runs/:id',
      'GET /api/runs/:id/output',
      'POST /api/runs/:id/stop',
      'GET /api/cos/mind/tools',
      'POST /sdapi/v1/txt2img',
    ]) expect(operations.has(operation), operation).toBe(true);
  });

  it('covers every declaration in the mounted toolkit providers and runs routers', () => {
    const { declarationKeys } = routeGraph();
    for (const relativePath of ['lib/aiToolkit/routes/providers.js', 'lib/aiToolkit/routes/runs.js']) {
      for (const route of parseRouteModule(join(SERVER_DIR, relativePath)).routes) {
        const key = routeDeclarationKey(route);
        expect(declarationKeys.has(key), key).toBe(true);
      }
    }
  });
});
