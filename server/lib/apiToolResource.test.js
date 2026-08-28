import { describe, it, expect } from 'vitest';
import { buildToolResource, TOOL_RESOURCE_TYPE } from './apiToolResource.js';
import { API_OPERATION_CONTRACTS } from './apiOperationContracts.js';
import { ERROR_CODES_BY_STATUS } from './errorHandler.js';

const resource = buildToolResource({ version: '9.9.9' });
const byName = (name) => resource.tools.find((tool) => tool.name === name);

describe('buildToolResource', () => {
  it('declares the resource envelope and the source document version', () => {
    expect(resource.type).toBe(TOOL_RESOURCE_TYPE);
    expect(resource.schemaVersion).toBe(1);
    expect(resource.portosVersion).toBe('9.9.9');
    expect(resource.source).toEqual({ document: 'openapi', version: '3.0.3' });
  });

  it('publishes JSON Schema, not the 3.0.3 dialect, so the schemas work as provider tool definitions', () => {
    expect(resource.schemaDialect).toBe('https://json-schema.org/draft/2020-12/schema');
    // A 3.0.3 `nullable: true` is not a JSON Schema keyword — converting here
    // would DROP the null branch and make a legal `null` argument invalid.
    expect(byName('image.generate').input_schema.properties.negative_prompt)
      .toEqual({ anyOf: [{ type: 'string', maxLength: 8000 }, { type: 'null' }] });
  });

  it('includes exactly the operations carrying an x-portos-tool annotation', () => {
    const annotated = Object.values(API_OPERATION_CONTRACTS)
      .flatMap((pathItem) => Object.values(pathItem))
      .filter((operation) => operation['x-portos-tool']);
    expect(resource.tools).toHaveLength(annotated.length);
    expect(resource.tools.map((tool) => tool.name).sort())
      .toEqual(annotated.map((operation) => operation['x-portos-tool'].name).sort());
  });

  it('is not filtered by API exposure settings', () => {
    // The registry enforces reachability at call time; hiding a tool here would
    // leave an agent unable to learn why its call was refused.
    expect(buildToolResource().tools).toHaveLength(resource.tools.length);
  });

  it('binds each tool to its HTTP method and path', () => {
    expect(byName('voice.synthesize').binding)
      .toEqual({ protocol: 'http', method: 'POST', path: '/api/voice/public/synthesize' });
    expect(byName('image.list-models').binding)
      .toEqual({ protocol: 'http', method: 'GET', path: '/sdapi/v1/sd-models' });
  });

  it('derives a snake_case provider name from the dotted canonical name', () => {
    expect(byName('image.list-models').providerName).toBe('image_list_models');
    expect(byName('voice.synthesize').providerName).toBe('voice_synthesize');
  });

  it('flattens an object request body into the argument schema and keeps property descriptions', () => {
    const input = byName('voice.synthesize').input_schema;
    expect(input.required).toEqual(['text']);
    expect(input.properties.engine.enum).toEqual(['kokoro', 'piper']);
    // The description is what lets a model pick a valid rate — minimization must not strip it.
    expect(input.properties.rate.description).toMatch(/Speech rate/);
    expect(input.additionalProperties).toBe(false);
  });

  it('turns query parameters into input properties', () => {
    const input = byName('voice.list-voices').input_schema;
    expect(input.properties.engine).toEqual({ type: 'string', enum: ['kokoro', 'piper'] });
    expect(input.required).toBeUndefined(); // the engine param is optional
  });

  it('preserves an open body contract rather than closing it', () => {
    // sdapiTxt2imgBodySchema is .passthrough() for A1111 compatibility.
    expect(byName('image.generate').input_schema.additionalProperties).not.toBe(false);
  });

  it('reports a non-JSON success payload by media type instead of claiming JSON', () => {
    expect(byName('voice.synthesize').output_schema)
      .toEqual({ type: 'string', format: 'binary', 'x-portos-media-type': 'audio/wav' });
  });

  it('uses the modeled JSON response schema when the contract has one', () => {
    expect(byName('image.list-models').output_schema).toEqual({ type: 'array', items: { type: 'object' } });
  });

  it('falls back to an open object when no success payload is modeled', () => {
    expect(byName('image.generate').output_schema).toEqual({ type: 'object', additionalProperties: true });
  });

  it('publishes the error code a route actually throws, not one derived from the status', () => {
    // errorHandler resolves `err.code || getErrorCode(status)`, and both write
    // routes pass an explicit code — so a status-derived guess would publish
    // BAD_REQUEST for a 400 that really reports VALIDATION_ERROR. One status can
    // carry several codes: a schema-valid request naming an unknown voice is a
    // 400 UNKNOWN_VOICE (see routes/voicePublic.test.js).
    expect(byName('voice.synthesize').failures).toEqual([
      { status: 400, code: 'VALIDATION_ERROR' },
      { status: 400, code: 'UNKNOWN_VOICE' },
    ]);
  });

  it('declares the router-wide exposure gate on every sdapi tool, not just the write one', () => {
    // routes/sdapi.js gates the WHOLE router with `router.use(...)`, so a read
    // tool returns 403 too when A1111 exposure is off. An agent that never saw
    // that failure has no way to explain the refusal.
    for (const name of ['image.list-models', 'image.list-samplers', 'image.get-options', 'image.get-progress']) {
      expect(byName(name).failures).toEqual([{ status: 403, code: 'FORBIDDEN' }]);
    }
  });

  it('emits one entry per code when a status carries several', () => {
    expect(byName('image.generate').failures).toEqual([
      { status: 400, code: 'VALIDATION_ERROR' },
      { status: 403, code: 'FORBIDDEN' }, // undeclared: falls back to the status map
      { status: 500, code: 'GEN_FAILED' },
      { status: 500, code: 'GEN_OUTPUT_MISSING' },
      { status: 504, code: 'GEN_TIMEOUT' },
    ]);
  });

  it('omits failures entirely for a tool that declares no error responses', () => {
    expect(byName('voice.list-voices').failures).toBeUndefined();
  });

  it('marks read tools idempotent and side-effecting tools not', () => {
    expect(byName('image.list-models').policy).toMatchObject({ sideEffect: 'read', idempotent: true });
    expect(byName('image.generate').policy).toMatchObject({ sideEffect: 'local-compute', idempotent: false, async: true });
  });

  it('publishes the full error vocabulary from the shared status map', () => {
    expect(resource.errors).toEqual(
      Object.entries(ERROR_CODES_BY_STATUS).map(([status, code]) => ({ status: Number(status), code })),
    );
    expect(resource.errors.some((error) => error.code === 'VALIDATION_ERROR')).toBe(true);
  });

  it('counts read versus side-effecting tools', () => {
    expect(resource.stats.total).toBe(resource.tools.length);
    expect(resource.stats.read + resource.stats.write).toBe(resource.tools.length);
  });

  it('stays smaller than the OpenAPI document it is derived from', async () => {
    // The point of the resource is that an agent can read it whole.
    const { buildInternalOpenApiSpec } = await import('./openapiSpec.js');
    const internal = JSON.stringify(buildInternalOpenApiSpec({}, { version: '9.9.9' }));
    expect(JSON.stringify(resource).length).toBeLessThan(internal.length / 100);
  });
});
