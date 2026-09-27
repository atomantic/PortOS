import { describe, expect, it } from 'vitest';
import { getApiRouteCatalog } from './apiRouteGraph.js';
import { HOST_CONTROL_ROUTES, hostControlBodyKeys, hostControlRouteFor, isHostControlRoute } from './hostControlRoutes.js';

describe('HOST_CONTROL_ROUTES (#8716)', () => {
  it('names only mounted routes, so a rename cannot silently ungate one', () => {
    // A catalog path keeps its `:param` / `*wildcard` tokens, which the
    // compiled patterns accept as ordinary segment text.
    const reached = new Set(getApiRouteCatalog().routes
      .map(({ method, path }) => hostControlRouteFor(method, path))
      .filter(Boolean));
    expect(HOST_CONTROL_ROUTES.filter((route) => !reached.has(route))).toEqual([]);
  });

  it('matches the spellings Express routes to the same handler, and nothing wider', () => {
    expect(isHostControlRoute('post', '/API/Apps/example-app/START/')).toBe(true);
    expect(isHostControlRoute('POST', '/api/git/status')).toBe(true);
    expect(isHostControlRoute('PUT', '/api/apps/example-app/documents/docs/example.md')).toBe(true);
    // Read-only GETs and neighbouring paths stay open.
    expect(isHostControlRoute('GET', '/api/apps/example-app/start')).toBe(false);
    expect(isHostControlRoute('GET', '/api/git/submodules/status')).toBe(false);
    expect(isHostControlRoute('POST', '/api/apps/example-app/start-example')).toBe(false);
    expect(isHostControlRoute('POST', '/api/apps/example-app/archive')).toBe(false);
    // The policy-store body gate matches the same spellings (#8721).
    expect(hostControlBodyKeys('put', '/API/Settings/', { harnesses: {}, location: {} })).toEqual(['harnesses']);
    expect(hostControlBodyKeys('PUT', '/api/COS/config', { avatarStyle: 'svg', mcpServers: [] })).toEqual(['mcpServers']);
    expect(hostControlBodyKeys('PUT', '/api/settings/credentials/example', { harnesses: {} })).toEqual([]);
  });
});

// Every mutation in these audited routers must be gated or explicitly reviewed
// as a data/inference operation. A new route fails closed at review time instead
// of silently falling through the inventory's one-way "listed routes exist" check.
describe('browser/runtime/database mutation inventory (#8798, #8897)', () => {
  const dataOrInference = [
    'POST /api/browser/navigate',
    'DELETE /api/browser/downloads/:name',
    'POST /api/harnesses/models/refresh',
    ...[
      'laya-mlx/score',
      'security-guard/install/cancel',
      'jev/install/cancel', 'jev/score', 'jev/unload',
      'download-preflight', 'install', 'delete', 'switch', 'migrate', 'unload',
      'test', 'test/stream', 'compare',
      'assessments/run', 'assessments/sweep', 'assessments/sweep/cancel', 'assessments/delete',
      // /run is body-gated for sandbox-repair; ordinary inference stays open.
      'capability-tests/run', 'capability-tests/delete',
      'llama-server/download-model', 'llama-server/download-model/cancel', 'llama-server/download-model/remove',
      'mtplx/models/pull', 'mtplx/models/remove',
      'slotstream/models/download', 'slotstream/models/download/cancel',
    ].map(path => `POST /api/local-llm/${path}`),
    // Advisory and read-only: validates cutover preconditions, runs nothing (#8897).
    'POST /api/database/maintenance/preflight',
  ];

  it('classifies every mounted mutation and keeps reviewed data/inference operations open', () => {
    const mutations = getApiRouteCatalog().routes.filter(({ method, path }) =>
      /^(POST|PUT|PATCH|DELETE)$/.test(method)
      && /^\/api\/(browser|database|harnesses|local-llm)(\/|$)/.test(path));
    const open = mutations.filter(({ method, path }) => !isHostControlRoute(method, path))
      .map(({ method, path }) => `${method} ${path}`);
    expect([...new Set(open)].sort()).toEqual([...dataOrInference].sort());
  });
});

