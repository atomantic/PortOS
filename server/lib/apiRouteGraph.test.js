import { afterEach, describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildApiRouteCatalog } from './apiRouteGraph.js';

const tempRoots = [];
const makeRoot = () => {
  const root = mkdtempSync(join(tmpdir(), 'portos-api-route-graph-'));
  tempRoots.push(root);
  return root;
};
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const write = (root, path, source) => {
  const target = join(root, path);
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, source, 'utf8');
};

describe('API route graph scanner', () => {
  it.each(['', ', { helper }'])('resolves mounts and aliases with default imports followed by %s', (named) => {
    const root = makeRoot();
    write(root, 'server/index.js', `
      import widgetsRoutes${named} from './routes/widgets.js';
      app.use('/api/widgets', widgetsRoutes);
      app.use('/api/legacy-widgets', widgetsRoutes);
    `);
    write(root, 'server/routes/widgets.js', `
      import { Router } from 'express';
      import childRoutes${named} from './widgets-child.js';
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
    const root = makeRoot();
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
    const root = makeRoot();
    write(root, 'server/index.js', `
      import unusedDefault, { createRuns } from './routes/runs.js';
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
