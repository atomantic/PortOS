import { describe, expect, it } from 'vitest';
import {
  apiAccessForPath,
  apiSideEffectFor,
  buildApiCatalog,
  expressPathToOpenApiPath,
  pathParametersFor,
} from './apiCatalog.js';

describe('apiCatalog', () => {
  it('projects every generated route with searchable metadata', () => {
    const catalog = buildApiCatalog({});
    expect(catalog.stats.operations).toBe(catalog.operations.length);
    expect(catalog.stats.domains).toBe(catalog.domains.length);
    expect(catalog.stats.modeled + catalog.stats.generated).toBe(catalog.stats.operations);
    expect(catalog.operations.length).toBeGreaterThan(2000);
    expect(catalog.operations.find((operation) => operation.path === '/api/cos/mind/tools')).toMatchObject({
      method: 'GET', domain: 'cos', sideEffect: 'read', access: 'authenticated-ui',
    });
  });

  it('converts Express parameters and wildcards to OpenAPI path templates', () => {
    expect(expressPathToOpenApiPath('/api/apps/:id/documents/:filename')).toBe('/api/apps/{id}/documents/{filename}');
    expect(expressPathToOpenApiPath('/api/music/models/:engine/*id')).toBe('/api/music/models/{engine}/{id}');
    expect(pathParametersFor('/api/music/models/:engine/*id').map((parameter) => parameter.name)).toEqual(['engine', 'id']);
  });

  it('classifies access from the shared auth policy and public registry', () => {
    expect(apiAccessForPath('/api/system/health')).toBe('always-public');
    expect(apiAccessForPath('/api/agent-context/mcp')).toBe('loopback');
    expect(apiAccessForPath('/api/voice/public/synthesize')).toBe('externally-exposable');
    expect(apiAccessForPath('/api/settings')).toBe('authenticated-ui');
  });

  it('makes inferred side effects explicit', () => {
    expect(apiSideEffectFor('GET', '/api/apps')).toBe('read');
    expect(apiSideEffectFor('PATCH', '/api/apps/:id')).toBe('write');
    expect(apiSideEffectFor('POST', '/api/apps/:id/restart')).toBe('process-control');
    expect(apiSideEffectFor('DELETE', '/api/apps/:id')).toBe('destructive');
  });

  it('returns registry metadata and resolved exposure without a client mirror', () => {
    const catalog = buildApiCatalog({ apiAccess: { voice: { exposed: true, requireAuth: true } } });
    expect(catalog.externallyExposableApis.find((entry) => entry.id === 'voice')).toMatchObject({
      publicBase: '/api/voice/public',
      exposed: true,
      requireAuth: true,
      example: { method: 'POST', path: '/api/voice/public/synthesize' },
    });
  });
});
