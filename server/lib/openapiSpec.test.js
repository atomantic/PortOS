import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { buildInternalOpenApiSpec, buildOpenApiSpec } from './openapiSpec.js';
import { synthesizeBodySchema as routeSchema } from '../routes/voicePublic.js';
import { voiceSynthesizeBodySchema } from './apiContractSchemas.js';

const exposed = (apiAccess) => ({ apiAccess });

describe('buildOpenApiSpec', () => {
  it('produces a valid 3.1 envelope with security schemes', () => {
    const spec = buildOpenApiSpec({}, { baseUrl: 'https://host:5555', version: '1.2.3' });
    expect(spec.openapi).toBe('3.1.0');
    expect(spec.info.version).toBe('1.2.3');
    expect(spec.servers).toEqual([{ url: 'https://host:5555' }]);
    expect(spec.components.securitySchemes.bearerAuth).toBeDefined();
    expect(spec.components.securitySchemes.basicAuth).toBeDefined();
  });

  it('includes NO paths when nothing is exposed', () => {
    const spec = buildOpenApiSpec({}, {});
    expect(Object.keys(spec.paths)).toHaveLength(0);
    expect(spec.tags).toHaveLength(0);
  });

  it('includes voice paths only when voice is exposed', () => {
    const spec = buildOpenApiSpec(exposed({ voice: { exposed: true, requireAuth: false } }), {});
    expect(spec.paths['/api/voice/public/synthesize']).toBeDefined();
    expect(spec.paths['/api/voice/public/voices']).toBeDefined();
    expect(spec.paths['/sdapi/v1/txt2img']).toBeUndefined();
    expect(spec.tags.map((t) => t.name)).toContain('voice');
  });

  it('reuses the synthesize Zod schema as the request body JSON Schema', () => {
    const spec = buildOpenApiSpec(exposed({ voice: { exposed: true, requireAuth: false } }), {});
    const body = spec.paths['/api/voice/public/synthesize'].post.requestBody.content['application/json'].schema;
    expect(body.type).toBe('object');
    expect(body.properties.text).toBeDefined();
    expect(body.required).toContain('text');
    expect(body.properties.engine.enum).toEqual(['kokoro', 'piper']);
    // OpenAPI path schemas must not carry the JSON-Schema dialect marker.
    expect(body.$schema).toBeUndefined();
  });

  it('omits security on passwordless operations, requires it when requireAuth', () => {
    const passwordless = buildOpenApiSpec(exposed({ voice: { exposed: true, requireAuth: false } }), {});
    expect(passwordless.paths['/api/voice/public/synthesize'].post.security).toEqual([]);

    const gated = buildOpenApiSpec(exposed({ voice: { exposed: true, requireAuth: true } }), {});
    expect(gated.paths['/api/voice/public/synthesize'].post.security).toEqual([
      { bearerAuth: [] },
      { basicAuth: [] },
    ]);
  });

  it('tags each operation with its API id', () => {
    const spec = buildOpenApiSpec(exposed({ sdapi: { exposed: true, requireAuth: false } }), {});
    expect(spec.paths['/sdapi/v1/txt2img'].post.tags).toEqual(['sdapi']);
  });

  it('emits empty servers when no baseUrl given', () => {
    const spec = buildOpenApiSpec({}, {});
    expect(spec.servers).toEqual([]);
  });

  it('route validation and OpenAPI consume the same synthesize schema object', () => {
    expect(routeSchema).toBe(voiceSynthesizeBodySchema);
    const spec = buildOpenApiSpec(exposed({ voice: { exposed: true, requireAuth: false } }), {});
    const documented = spec.paths['/api/voice/public/synthesize'].post.requestBody.content['application/json'].schema;
    const route = z.toJSONSchema(routeSchema);
    delete route.$schema;
    expect(documented).toEqual(route);
    expect((documented.required || []).sort()).toEqual((route.required || []).sort());
  });
});

describe('buildInternalOpenApiSpec', () => {
  it('documents every generated operation with unique operation ids', () => {
    const spec = buildInternalOpenApiSpec({}, { baseUrl: 'http://host:5555', version: '1.2.3' });
    const operations = Object.values(spec.paths).flatMap((pathItem) => Object.values(pathItem));
    expect(operations.length).toBeGreaterThan(2000);
    expect(new Set(operations.map((operation) => operation.operationId)).size).toBe(operations.length);
    expect(spec.paths['/api/apps/{id}'].delete.parameters).toContainEqual({
      name: 'id', in: 'path', required: true, schema: { type: 'string' },
    });
  });

  it('distinguishes detailed contracts from generated inventory', () => {
    const spec = buildInternalOpenApiSpec({}, {});
    expect(spec.paths['/api/voice/public/synthesize'].post['x-portos-contract-status']).toBe('modeled');
    expect(spec.paths['/api/voice/public/synthesize'].post.requestBody).toBeDefined();
    expect(spec.paths['/api/apps'].get['x-portos-contract-status']).toBe('generated');
    expect(spec.paths['/api/apps'].get.responses.default).toBeDefined();
  });
});
