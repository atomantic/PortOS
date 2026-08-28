/**
 * OpenAPI 3.0.3 compatibility for JSON Schema produced against draft 2020-12.
 *
 * PortOS publishes 3.0.3 rather than 3.1 because the documents are consumed by
 * agent tooling (tool-schema converters, validators, generators) whose 3.1
 * support is still thin, while 3.0.3 is universally understood. The gap is
 * narrow but real: `zodToOpenApiSchema` emits draft 2020-12, which uses
 * constructs 3.0.3 rejects outright. `toOpenApi30Schema` rewrites them so a
 * document labeled 3.0.3 actually validates as 3.0.3.
 *
 * APPLY THIS ONLY AT THE OPENAPI DOCUMENT BOUNDARY (`openapiSpec.js`), never
 * inside `zodToOpenApiSchema` itself. Three other surfaces consume that helper's
 * output as ORDINARY JSON SCHEMA — the AsyncAPI document's `payload`, the CoS
 * provider tool definitions, and the semantic tool resource — and these rewrites
 * are wrong there. `exclusiveMinimum: true` is a draft-4 spelling that a JSON
 * Schema validator reads as a type error and ignores, silently widening
 * `value > 0` to `value >= 0`; `nullable: true` is not a JSON Schema keyword at
 * all, so the null branch is simply lost. Both turn a correct contract into a
 * quietly wrong one.
 *
 * Rewrites applied:
 * - a `null` branch in `anyOf`/`oneOf` becomes `nullable: true` on the
 *   surviving branches (3.0 has no `null` type); a sole survivor is inlined,
 *   with the PARENT's keywords winning any collision so an inner constraint
 *   can't widen an outer one
 * - `type: ['string', 'null']` and a bare `type: 'null'` collapse the same way
 * - numeric `exclusiveMinimum`/`exclusiveMaximum` become the 3.0 boolean form
 *   paired with `minimum`/`maximum`
 * - `const: x` becomes `enum: [x]`
 * - `examples: [...]` becomes `example: examples[0]`
 * - `prefixItems` (a tuple) becomes `items: { anyOf: [...] }` plus
 *   `minItems`/`maxItems`, preserving arity and member types even though 3.0.3
 *   cannot express positional typing
 * - `$schema` and `propertyNames` (no 3.0 equivalent) are dropped
 *
 * `$ref`/`$defs` are REFUSED rather than mangled — see `assertNoReferences`.
 */

import { isPlainObject } from './objects.js';

/** The OpenAPI version every PortOS-generated document declares. */
export const OPENAPI_VERSION = '3.0.3';

// A `null` union member, in either the pre-conversion (`{type:'null'}`) or
// post-conversion (`{nullable:true}`) spelling — the second appears when a
// nested branch was converted before its parent union was collapsed. Only a
// BARE marker counts; a null branch carrying other keywords is left alone
// rather than silently dropping those keywords.
const isNullBranch = (branch) => isPlainObject(branch)
  && Object.keys(branch).length === 1
  && (branch.type === 'null' || branch.nullable === true);

const collapseNullableUnion = (schema, keyword) => {
  const branches = schema[keyword];
  if (!Array.isArray(branches) || !branches.some(isNullBranch)) return schema;
  const survivors = branches.filter((branch) => !isNullBranch(branch));
  const { [keyword]: _dropped, ...rest } = schema;
  if (survivors.length === 0) return { ...rest, nullable: true };
  // A single survivor inlines. The parent's own keywords are applied LAST so a
  // branch constraint cannot overwrite (and possibly widen) an outer one, and
  // an outer `description` survives an inner one.
  if (survivors.length === 1) return { ...survivors[0], ...rest, nullable: true };
  // Several survivors stay a union; 3.0 has no way to mark the union itself
  // nullable, so each branch carries the flag.
  return { ...rest, [keyword]: survivors.map((branch) => ({ ...branch, nullable: true })) };
};

const collapseNullableType = (schema) => {
  if (schema.type === 'null') {
    const { type: _dropped, ...rest } = schema;
    return { ...rest, nullable: true };
  }
  if (!Array.isArray(schema.type)) return schema;
  const types = schema.type.filter((type) => type !== 'null');
  const { type: _dropped, ...rest } = schema;
  const nullable = types.length !== schema.type.length ? { nullable: true } : {};
  // 3.0 allows exactly one `type`; a genuine multi-type union has no 3.0
  // equivalent, so drop the constraint rather than emit an invalid document.
  return types.length === 1 ? { ...rest, type: types[0], ...nullable } : { ...rest, ...nullable };
};

// Draft 2020-12 makes these numeric; 3.0.3 keeps draft-4's boolean flag beside
// `minimum`/`maximum`.
const convertExclusiveBounds = (schema) => {
  const out = { ...schema };
  if (typeof out.exclusiveMinimum === 'number') {
    out.minimum = out.exclusiveMinimum;
    out.exclusiveMinimum = true;
  }
  if (typeof out.exclusiveMaximum === 'number') {
    out.maximum = out.exclusiveMaximum;
    out.exclusiveMaximum = true;
  }
  return out;
};

// 3.0.3 has no positional array typing. `items: {anyOf: [...members]}` plus a
// fixed arity keeps every member type and the length, which is strictly better
// than dropping to "array of anything".
const convertTuple = (schema) => {
  const { prefixItems, ...rest } = schema;
  if (!Array.isArray(prefixItems)) return rest;
  return {
    ...rest,
    items: prefixItems.length === 1 ? prefixItems[0] : { anyOf: prefixItems },
    minItems: rest.minItems ?? prefixItems.length,
    // An open-ended `items` schema means extra members are allowed past the
    // prefix, so only a closed tuple gets a maximum.
    ...(rest.items === undefined ? { maxItems: rest.maxItems ?? prefixItems.length } : {}),
  };
};

/**
 * Refuse a schema carrying `$ref`/`$defs` rather than publishing a broken one.
 *
 * Zod emits `$ref: '#'` for a self-recursive contract. Inlined into a path item
 * that `#` resolves to the ROOT OPENAPI DOCUMENT, not the schema — a silently
 * broken pointer for every consumer — and in 3.0.3 a `$ref` ignores its
 * siblings, so an adjacent `nullable` is dropped too. Correctly supporting this
 * means hoisting `$defs` into `#/components/schemas` and rewriting pointers;
 * until a contract actually needs that, failing loudly at build time beats
 * shipping a document whose references don't resolve.
 */
const assertNoReferences = (schema) => {
  if (schema.$ref !== undefined || schema.$defs !== undefined) {
    throw new Error(
      'OpenAPI 3.0.3 downgrade cannot represent a $ref/$defs schema (recursive or reused Zod contract). '
      + 'Inline the contract, or add $defs hoisting to openapiDowngrade.js before registering it.',
    );
  }
};

// Keywords with no 3.0.3 Schema Object equivalent. The OAS 3.0 meta-schema
// closes the Schema Object, so leaving one in makes the whole document invalid.
// `propertyNames` comes from `z.record()` and its key constraint is simply not
// expressible in 3.0.
const UNSUPPORTED_KEYWORDS = ['$schema', 'propertyNames'];

const NESTED_SCHEMA_KEYS = ['items', 'not', 'additionalProperties'];
const NESTED_SCHEMA_LIST_KEYS = ['anyOf', 'oneOf', 'allOf'];

/**
 * Rewrite a draft-2020-12 JSON Schema into the OpenAPI 3.0.3 Schema Object
 * dialect. Returns a new object; the input is never mutated.
 *
 * @throws when the schema uses `$ref`/`$defs` (see `assertNoReferences`).
 */
export const toOpenApi30Schema = (schema) => {
  if (Array.isArray(schema)) return schema.map(toOpenApi30Schema);
  if (!isPlainObject(schema)) return schema;

  assertNoReferences(schema);

  let out = { ...schema };
  for (const keyword of UNSUPPORTED_KEYWORDS) delete out[keyword];

  if (out.const !== undefined) {
    out.enum = [out.const];
    delete out.const;
  }
  if (Array.isArray(out.examples)) {
    if (out.example === undefined && out.examples.length > 0) out.example = out.examples[0];
    delete out.examples;
  }

  out = convertTuple(out);
  out = convertExclusiveBounds(out);
  out = collapseNullableType(out);
  for (const keyword of ['anyOf', 'oneOf']) out = collapseNullableUnion(out, keyword);

  for (const key of NESTED_SCHEMA_KEYS) {
    if (out[key] !== undefined && typeof out[key] !== 'boolean') out[key] = toOpenApi30Schema(out[key]);
  }
  for (const key of NESTED_SCHEMA_LIST_KEYS) {
    if (Array.isArray(out[key])) out[key] = out[key].map(toOpenApi30Schema);
  }
  if (isPlainObject(out.properties)) {
    out.properties = Object.fromEntries(
      Object.entries(out.properties).map(([name, value]) => [name, toOpenApi30Schema(value)]),
    );
  }

  // Converting the branches above can turn a nested `{type:'null'}` into the
  // `{nullable:true}` marker, exposing a collapse the first pass couldn't see.
  for (const keyword of ['anyOf', 'oneOf']) out = collapseNullableUnion(out, keyword);

  return out;
};

// Every spot an OpenAPI Operation Object can carry a Schema Object.
const convertContent = (content) => (isPlainObject(content)
  ? Object.fromEntries(Object.entries(content).map(([mediaType, media]) => [
    mediaType,
    isPlainObject(media?.schema) ? { ...media, schema: toOpenApi30Schema(media.schema) } : media,
  ]))
  : content);

const convertPayload = (payload) => (isPlainObject(payload?.content)
  ? { ...payload, content: convertContent(payload.content) }
  : payload);

/**
 * Downgrade every schema an OpenAPI operation carries — request body, response
 * bodies, and parameters. This is the boundary the conversion belongs at: the
 * operation is on its way into a document that declares 3.0.3, whereas the same
 * contract schemas reach other consumers as plain JSON Schema.
 */
export const toOpenApi30Operation = (operation) => {
  if (!isPlainObject(operation)) return operation;
  const out = { ...operation };
  if (out.requestBody) out.requestBody = convertPayload(out.requestBody);
  if (isPlainObject(out.responses)) {
    out.responses = Object.fromEntries(
      Object.entries(out.responses).map(([status, response]) => [status, convertPayload(response)]),
    );
  }
  if (Array.isArray(out.parameters)) {
    out.parameters = out.parameters.map((parameter) => (isPlainObject(parameter?.schema)
      ? { ...parameter, schema: toOpenApi30Schema(parameter.schema) }
      : parameter));
  }
  return out;
};
