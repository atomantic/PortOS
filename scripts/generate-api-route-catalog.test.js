import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  MANIFEST_RELATIVE_PATH,
  REGENERATE_COMMAND,
  REPO_ROOT,
  buildApiRouteCatalog,
  generateApiRouteCatalog,
  parseRouteModule,
  readApiRouteCatalog,
  serializeApiRouteCatalog,
} from './generate-api-route-catalog.js';

const write = (root, path, source) => {
  const target = join(root, path);
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, source, 'utf8');
};

const walk = (dir) => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? walk(path) : [path];
});

describe('API route catalog scanner', () => {
  it('resolves top-level mounts, imported child routers, local subrouters, and aliases', () => {
    const root = mkdtempSync(join(tmpdir(), 'portos-api-catalog-'));
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
    const root = mkdtempSync(join(tmpdir(), 'portos-api-catalog-'));
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
    expect(catalog.routes[0].sources).toHaveLength(2);
    expect(catalog.stats.declarations).toBe(2);
  });

  it('follows named factory returns and composed toolkit router properties', () => {
    const root = mkdtempSync(join(tmpdir(), 'portos-api-catalog-'));
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

describe('generated API route catalog', () => {
  it('matches a fresh scan of the mounted route graph', () => {
    const stale = `${MANIFEST_RELATIVE_PATH} is stale — run \`${REGENERATE_COMMAND}\` and commit the result.`;
    const fresh = generateApiRouteCatalog();
    expect(fresh, stale).toEqual(readApiRouteCatalog());
    expect(readFileSync(join(REPO_ROOT, MANIFEST_RELATIVE_PATH), 'utf8'), stale)
      .toBe(serializeApiRouteCatalog(fresh));
  });

  it('covers every HTTP declaration mounted below /api or /sdapi', () => {
    const catalog = readApiRouteCatalog();
    const covered = new Set(catalog.routes.flatMap((route) => route.sources.map(
      (source) => `${source.source}:${source.line}:${route.method.toLowerCase()}`,
    )));
    const routeFiles = walk(join(REPO_ROOT, 'server', 'routes'))
      .filter((path) => path.endsWith('.js') && !path.endsWith('.test.js'));
    const omitted = [];
    for (const file of routeFiles) {
      for (const route of parseRouteModule(file).routes) {
        // The noVNC HTML viewer intentionally lives outside /api. Its actual
        // control API is mounted at /api/remote-desktop and is cataloged.
        if (route.source === 'server/routes/remoteDesktopViewer.js') continue;
        const key = `${route.source}:${route.line}:${route.method}`;
        if (!covered.has(key)) omitted.push(key);
      }
    }
    expect(omitted).toEqual([]);
  });

  it('is a unique, stable, complete inventory with source pointers', () => {
    const catalog = readApiRouteCatalog();
    expect(catalog.stats.mounts).toBeGreaterThan(140);
    expect(catalog.stats.operations).toBeGreaterThan(2_000);
    expect(catalog.routes).toHaveLength(catalog.stats.operations);
    expect(new Set(catalog.routes.map((route) => `${route.method} ${route.path}`)).size)
      .toBe(catalog.routes.length);
    for (const route of catalog.routes) {
      expect(route.path).toMatch(/^\/(?:api|sdapi)(?:\/|$)/);
      expect(route.sources.length).toBeGreaterThan(0);
      for (const source of route.sources) {
        expect(source.source).toMatch(/^server\/(?:routes|lib\/aiToolkit\/routes)\/[\w./-]+\.js$/);
        expect(source.line).toBeGreaterThan(0);
      }
    }
  });

  it('pins representative nested, aliased, toolkit, and public routes', () => {
    const operations = new Set(readApiRouteCatalog().routes.map((route) => `${route.method} ${route.path}`));
    for (const operation of [
      'POST /api/brain/songbook/import/url',
      'GET /api/city/introspection',
      'GET /api/openworld/introspection',
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
    const catalog = readApiRouteCatalog();
    const covered = new Set(catalog.routes.flatMap((route) => route.sources.map(
      (source) => `${source.source}:${source.line}:${route.method.toLowerCase()}`,
    )));
    for (const relativePath of [
      'server/lib/aiToolkit/routes/providers.js',
      'server/lib/aiToolkit/routes/runs.js',
    ]) {
      for (const route of parseRouteModule(join(REPO_ROOT, relativePath)).routes) {
        expect(covered.has(`${route.source}:${route.line}:${route.method}`), `${relativePath}:${route.line}:${route.method}`).toBe(true);
      }
    }
  });
});
