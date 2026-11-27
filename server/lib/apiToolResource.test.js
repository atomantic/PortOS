import { describe, it, expect } from 'vitest';
const { buildToolResource, TOOL_RESOURCE_TYPE } = await import('./apiToolResource.js');
const { API_OPERATION_CONTRACTS } = await import('./apiOperationContracts.js');
const { ERROR_CODES_BY_STATUS } = await import('./errorHandler.js');

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
  });

  it('derives a snake_case provider name from the dotted canonical name', () => {
    expect(byName('voice.synthesize').providerName).toBe('voice_synthesize');
  });

  it('flattens an object request body into the argument schema and keeps property descriptions', () => {
    const input = byName('voice.synthesize').input_schema;
    expect(input.required).toEqual(['text']);
    expect(input.properties.engine.enum).toEqual(['auk', 'piper', 'qwen3-tts']);
    // The description is what lets a model pick a valid rate — minimization must not strip it.
    expect(input.properties.rate.description).toMatch(/Speech rate/);
    expect(input.additionalProperties).toBe(false);
  });

  it('turns query parameters into input properties', () => {
    const input = byName('voice.list-voices').input_schema;
    expect(input.properties.engine).toEqual({ type: 'string', enum: ['auk', 'piper', 'qwen3-tts'] });
    expect(input.required).toBeUndefined(); // the engine param is optional
  });

  it('reports a non-JSON success payload by media type instead of claiming JSON', () => {
    expect(byName('voice.synthesize').output_schema)
      .toEqual({ type: 'string', format: 'binary', 'x-portos-media-type': 'audio/wav' });
  });

  it('uses the modeled JSON response schema when the contract has one', () => {
    expect(byName('voice.list-voices').output_schema).toEqual({ type: 'object' });
  });

  it('publishes the error code a route actually throws, not one derived from the status', () => {
    // errorHandler resolves `err.code || getErrorCode(status)`. A status-derived
    // guess would publish BAD_REQUEST for a 400 that reports VALIDATION_ERROR. One status can
    // carry several codes: a schema-valid request naming an unknown voice is a
    // 400 UNKNOWN_VOICE (see routes/voicePublic.test.js).
    expect(byName('voice.synthesize').failures).toEqual([
      { status: 400, code: 'VALIDATION_ERROR' },
      { status: 400, code: 'UNKNOWN_VOICE' },
      { status: 403, code: 'HOST_CONTROL_FORBIDDEN' },
    ]);
  });

  it('omits failures entirely for a tool that declares no error responses', () => {
    expect(byName('voice.list-voices').failures).toBeUndefined();
  });

  it('marks read tools idempotent and side-effecting tools not', () => {
    expect(byName('voice.list-voices').policy).toMatchObject({ sideEffect: 'read', idempotent: true });
    expect(byName('voice.synthesize').policy).toMatchObject({ sideEffect: 'local-compute', idempotent: false, async: false });
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
