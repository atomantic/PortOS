import { describe, expect, it } from 'vitest';
import { getApiRouteCatalog } from './apiRouteGraph.js';
import { HOST_CONTROL_ROUTES, hostControlRouteFor, isHostControlRoute } from './hostControlRoutes.js';

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
  });
});
