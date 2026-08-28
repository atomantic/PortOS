import { describe, it, expect } from 'vitest';
import { OPENAPI_VERSION, toOpenApi30Schema } from './openapiDowngrade.js';
import { zodToOpenApiSchema, sdapiTxt2imgBodySchema } from './apiContractSchemas.js';

describe('toOpenApi30Schema', () => {
  it('collapses an anyOf null branch into nullable on the surviving branch', () => {
    expect(toOpenApi30Schema({ anyOf: [{ type: 'string', maxLength: 10 }, { type: 'null' }] }))
      .toEqual({ type: 'string', maxLength: 10, nullable: true });
  });

  it('keeps a multi-branch union but marks each branch nullable', () => {
    expect(toOpenApi30Schema({ anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'null' }] }))
      .toEqual({ anyOf: [{ type: 'string', nullable: true }, { type: 'number', nullable: true }] });
  });

  it('leaves a union with no null branch untouched', () => {
    const input = { oneOf: [{ type: 'string' }, { type: 'number' }] };
    expect(toOpenApi30Schema(input)).toEqual(input);
  });

  it('does not treat a null branch carrying other keywords as the nullable marker', () => {
    // Collapsing it would silently discard `title`, so the branch survives as a
    // branch — converted to the 3.0.3 spelling, but never folded into the parent.
    expect(toOpenApi30Schema({ anyOf: [{ type: 'string' }, { type: 'null', title: 'explicitly absent' }] }))
      .toEqual({ anyOf: [{ type: 'string' }, { nullable: true, title: 'explicitly absent' }] });
  });

  it('collapses a type array into a single type plus nullable', () => {
    expect(toOpenApi30Schema({ type: ['string', 'null'], minLength: 1 }))
      .toEqual({ type: 'string', nullable: true, minLength: 1 });
  });

  it('drops an unrepresentable multi-type constraint rather than emitting an invalid type array', () => {
    expect(toOpenApi30Schema({ type: ['string', 'number'] })).toEqual({});
  });

  it('converts numeric exclusive bounds to the 3.0 boolean form', () => {
    expect(toOpenApi30Schema({ type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 10 }))
      .toEqual({ type: 'number', minimum: 0, exclusiveMinimum: true, maximum: 10, exclusiveMaximum: true });
  });

  it('rewrites const to a single-value enum and examples to example', () => {
    expect(toOpenApi30Schema({ const: 'portos' })).toEqual({ enum: ['portos'] });
    expect(toOpenApi30Schema({ type: 'string', examples: ['a', 'b'] })).toEqual({ type: 'string', example: 'a' });
  });

  it('keeps an existing example rather than overwriting it from examples', () => {
    expect(toOpenApi30Schema({ example: 'kept', examples: ['ignored'] })).toEqual({ example: 'kept' });
  });

  it('drops keywords 3.0.3 has no equivalent for', () => {
    // `propertyNames` comes from z.record() and makes the whole document
    // invalid: the OAS 3.0 meta-schema closes the Schema Object.
    expect(toOpenApi30Schema({ $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', propertyNames: { type: 'string' } }))
      .toEqual({ type: 'object' });
  });

  it('converts a tuple to a bounded array instead of dropping its members', () => {
    expect(toOpenApi30Schema({ type: 'array', prefixItems: [{ type: 'string' }, { type: 'number' }] }))
      .toEqual({ type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'number' }] }, minItems: 2, maxItems: 2 });
  });

  it('leaves a tuple with a rest schema open-ended', () => {
    const result = toOpenApi30Schema({ type: 'array', prefixItems: [{ type: 'string' }], items: { type: 'number' } });
    expect(result.minItems).toBe(1);
    expect(result.maxItems).toBeUndefined();
  });

  it('collapses a bare null type, which 3.0.3 cannot express', () => {
    expect(toOpenApi30Schema({ type: 'null' })).toEqual({ nullable: true });
  });

  it('collapses a null branch that only surfaces after the branches convert', () => {
    // The inner union converts to `{nullable:true}`, which the second collapse
    // pass then recognizes as the null marker.
    expect(toOpenApi30Schema({ anyOf: [{ type: 'string' }, { type: 'null' }] }))
      .toEqual({ type: 'string', nullable: true });
    expect(toOpenApi30Schema({ anyOf: [{ anyOf: [{ type: 'string' }, { type: 'null' }] }, { type: 'null' }] }))
      .toEqual({ type: 'string', nullable: true });
  });

  it('refuses a $ref/$defs schema rather than emitting a broken pointer', () => {
    // Zod emits `$ref: '#'` for a recursive contract; inlined into a path item
    // that resolves to the ROOT DOCUMENT, not the schema.
    expect(() => toOpenApi30Schema({ $ref: '#' })).toThrow(/\$ref/);
    expect(() => toOpenApi30Schema({ type: 'object', $defs: { Node: { type: 'object' } } })).toThrow(/\$ref/);
  });

  it('lets the parent keep its own keywords when a sole survivor inlines', () => {
    // Survivor-wins would WIDEN maxLength from 5 to 10 and silently replace the
    // outer description Zod puts at the parent level.
    expect(toOpenApi30Schema({ maxLength: 5, description: 'outer', anyOf: [{ type: 'string', maxLength: 10, description: 'inner' }, { type: 'null' }] }))
      .toEqual({ type: 'string', maxLength: 5, description: 'outer', nullable: true });
  });

  it('recurses through properties, items, and nested unions', () => {
    const result = toOpenApi30Schema({
      type: 'object',
      properties: {
        tags: { type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'null' }] } },
        nested: { type: 'object', properties: { seed: { type: ['integer', 'null'] } } },
      },
    });
    expect(result.properties.tags.items).toEqual({ type: 'string', nullable: true });
    expect(result.properties.nested.properties.seed).toEqual({ type: 'integer', nullable: true });
  });

  it('never mutates the input schema', () => {
    const input = { anyOf: [{ type: 'string' }, { type: 'null' }] };
    const snapshot = structuredClone(input);
    toOpenApi30Schema(input);
    expect(input).toEqual(snapshot);
  });

  it('passes a boolean additionalProperties through untouched', () => {
    expect(toOpenApi30Schema({ type: 'object', additionalProperties: false }))
      .toEqual({ type: 'object', additionalProperties: false });
  });
});

describe('zodToOpenApiSchema', () => {
  it('stays plain JSON Schema so its other consumers are not corrupted', () => {
    // The AsyncAPI payloads, the CoS provider tool definitions, and the tool
    // resource all read this as JSON Schema. Downgrading here (as an earlier
    // revision did) turns `exclusiveMinimum: 0` into the draft-4 boolean form,
    // which a JSON Schema validator ignores — silently widening `> 0` to `>= 0`.
    const schema = zodToOpenApiSchema(sdapiTxt2imgBodySchema);
    expect(schema.$schema).toBeUndefined();
    expect(schema.properties.negative_prompt)
      .toEqual({ anyOf: [{ type: 'string', maxLength: 8000 }, { type: 'null' }] });
  });

  it('converts to 3.0.3 only at the document boundary', () => {
    const converted = toOpenApi30Schema(zodToOpenApiSchema(sdapiTxt2imgBodySchema));
    expect(JSON.stringify(converted)).not.toContain('"type":"null"');
    expect(converted.properties.negative_prompt).toEqual({ type: 'string', maxLength: 8000, nullable: true });
  });
});

describe('OPENAPI_VERSION', () => {
  it('is the 3.0.x version PortOS publishes', () => {
    expect(OPENAPI_VERSION).toBe('3.0.3');
  });
});

// The findings that motivated this module were all "the document says 3.0.3 but
// contains a construct 3.0.3 rejects". Scan the real published documents rather
// than trusting the unit cases above to have enumerated every source.
describe('the published documents are actually 3.0.3', () => {
  const FORBIDDEN_IN_30 = ['"type":"null"', '$schema', '"propertyNames"', '"prefixItems"', '"$defs"', '"$ref"', '"const":'];

  it.each([
    ['public', (m) => m.buildOpenApiSpec({ apiAccess: { voice: { exposed: true }, sdapi: { exposed: true } } }, { version: '1.0.0' })],
    ['internal', (m) => m.buildInternalOpenApiSpec({}, { version: '1.0.0' })],
  ])('%s document carries no 3.1-only construct', async (_label, build) => {
    const spec = build(await import('./openapiSpec.js'));
    expect(spec.openapi).toBe(OPENAPI_VERSION);
    const serialized = JSON.stringify(spec);
    for (const construct of FORBIDDEN_IN_30) expect(serialized).not.toContain(construct);
    // A type array is the other 3.1-only spelling and needs a regex.
    expect(serialized).not.toMatch(/"type":\s*\[/);
  });

  it('leaves the AsyncAPI document as JSON Schema', async () => {
    // AsyncAPI 3 payloads are JSON Schema, NOT OAS 3.0 — the draft-4 boolean
    // `exclusiveMinimum` a downgrade would introduce reads as a type error
    // there, widening `lines > 0` into `lines >= 0`.
    const { buildAsyncApiSpec } = await import('./asyncApiSpec.js');
    const serialized = JSON.stringify(buildAsyncApiSpec({ version: '1.0.0' }));
    expect(serialized).not.toContain('"exclusiveMinimum":true');
    expect(serialized).not.toContain('"nullable"');
  });
});
