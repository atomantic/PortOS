import { describe, it, expect } from 'vitest';
import { join } from 'node:path';

import { getApiRouteCatalog, parseRouteModule, routeDeclarationKey, scanRouteGraph } from '../../../lib/apiRouteGraph.js';
import { SERVER_DIR, collectServerSources } from '../../guardSources.js';

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
  it('covers every HTTP declaration mounted below /api', () => {
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
      expect(route.path).toMatch(/^\/api(?:\/|$)/);
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
      'POST /api/code-animation/films/:id/blender/render',
      'POST /api/music-video/:id/blender/render',
      'POST /api/brain/songbook/import/url',
      'GET /api/providers/readiness',
      'DELETE /api/providers/:id',
      'POST /api/providers/:id/test',
      'POST /api/providers/:id/refresh-models',
      'GET /api/runs/:id',
      'GET /api/runs/:id/output',
      'POST /api/runs/:id/stop',
      'GET /api/cos/mind/tools',
      'POST /api/image-gen/generate',
    ]) expect(operations.has(operation), operation).toBe(true);
  });

  it('discovers all shared model artifact handlers under their owning routers', () => {
    const operations = new Set(getApiRouteCatalog().routes.map(({ method, path }) => `${method} ${path}`));
    for (const path of [
      '/api/image-gen/models/:modelId',
      '/api/video-gen/models/:modelId',
      '/api/video-gen/ic-loras/:mode',
      '/api/video-gen/text-encoders/:id',
      '/api/video-gen/text-encoder',
    ]) {
      expect(operations.has(`GET ${path}/download`), path).toBe(true);
      expect(operations.has(`POST ${path}/download`), path).toBe(true);
      expect(operations.has(`POST ${path}/repair`), path).toBe(true);
    }
    for (const kind of ['image', 'video']) {
      expect(operations.has(`POST /api/${kind}-gen/models/verify`)).toBe(true);
    }
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
