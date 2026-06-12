import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { buildOpenApiSpec } from './openapiSpec.js';
import { synthesizeBodySchema as routeSchema } from '../routes/voicePublic.js';

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

  it('synthesize body schema stays in sync with the route schema (parity)', () => {
    // The lib keeps a light copy of the route's schema (so it doesn't pull the
    // heavy TTS chain). Assert the documented body matches the route's actual
    // VALIDATION shape — every property's type/bounds + the required set — so
    // the two can't drift. `description` is doc-only (the lib copy adds a
    // per-engine rate note the route schema doesn't carry); strip it before
    // comparing so a deliberate doc annotation isn't read as a contract drift.
    const stripDescriptions = (props) =>
      Object.fromEntries(Object.entries(props).map(([k, v]) => {
        // eslint-disable-next-line no-unused-vars
        const { description, ...rest } = v;
        return [k, rest];
      }));
    const spec = buildOpenApiSpec(exposed({ voice: { exposed: true, requireAuth: false } }), {});
    const documented = spec.paths['/api/voice/public/synthesize'].post.requestBody.content['application/json'].schema;
    const route = z.toJSONSchema(routeSchema);
    expect(stripDescriptions(documented.properties)).toEqual(stripDescriptions(route.properties));
    expect((documented.required || []).sort()).toEqual((route.required || []).sort());
  });
});
