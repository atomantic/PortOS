/**
 * Minimized semantic tool resource for PortOS's HTTP surface.
 *
 * The internal OpenAPI document describes every one of the ~2000 mounted
 * operations, which is the wrong shape (and far too large) to hand an agent
 * that just wants to know what it can call. This builds the small counterpart:
 * only the operations that opted in with an `x-portos-tool` annotation, flattened
 * from an OpenAPI operation into one provider-neutral tool record with an
 * explicit HTTP binding.
 *
 * "Minimized" is about document overhead, not semantics — the OpenAPI envelope,
 * per-response prose, security schemes, and source annotations are dropped, and
 * the shared error vocabulary is hoisted to a single top-level `errors` list
 * instead of being repeated per operation. Property-level `description`s are
 * KEPT: they are what lets a model pick arguments correctly.
 *
 * Deliberately parallel to `services/cosToolRegistry.js`, which publishes the
 * in-process CoS tool catalog. Same `portos_tool` entry vocabulary
 * (`name` / `version` / `providerName` / `input_schema` / `output_schema` /
 * `policy`) so an agent reads one shape across both surfaces; this one adds
 * `binding` because these tools are called over HTTP rather than in-process.
 */

import { pathParametersFor } from './apiCatalog.js';
import { API_OPERATION_CONTRACTS } from './apiOperationContracts.js';
import { providerToolName } from './cosToolContracts.js';
import { ERROR_CODES_BY_STATUS } from './errorHandler.js';
import { OPENAPI_VERSION } from './openapiDowngrade.js';

export const TOOL_RESOURCE_TYPE = 'portos_tool_resource';

const OBJECT_OUTPUT_SCHEMA = Object.freeze({ type: 'object', additionalProperties: true });

// Query/header/path parameters become ordinary input properties so a caller
// sees one argument object instead of an OpenAPI parameter list.
const parametersToSchema = (parameters = []) => {
  const properties = {};
  const required = [];
  for (const parameter of parameters) {
    if (!parameter?.name || !parameter.schema) continue;
    properties[parameter.name] = parameter.description
      ? { ...parameter.schema, description: parameter.description }
      : parameter.schema;
    if (parameter.required === true) required.push(parameter.name);
  }
  return { properties, required };
};

const jsonSchemaOf = (payload) => payload?.content?.['application/json']?.schema;

/**
 * Merge an operation's request body and parameters into one argument schema.
 * A body that isn't an object (or isn't JSON at all) can't be merged with
 * parameters, so it is exposed under an explicit `body` property rather than
 * being silently flattened.
 */
const inputSchemaFor = (operation, path) => {
  // Path parameters are as required as body fields — a tool missing them is
  // uncallable. `pathParametersFor` is the same helper the OpenAPI builder uses.
  const { properties, required } = parametersToSchema([
    ...pathParametersFor(path),
    ...(operation.parameters ?? []),
  ]);
  const body = jsonSchemaOf(operation.requestBody);
  const bodyIsObject = body?.type === 'object';
  const bodyIsRequired = operation.requestBody?.required !== false;

  // An object body flattens into the argument object; anything else (an array,
  // a binary upload) can't merge with parameters and stays under `body`.
  const bodyProperties = bodyIsObject ? (body.properties ?? {}) : (body ? { body } : {});
  const bodyRequiredNames = !bodyIsRequired ? [] : bodyIsObject ? (body.required ?? []) : (body ? ['body'] : []);
  const allRequired = [...new Set([...required, ...bodyRequiredNames])];

  // A body field and a parameter sharing a name would collapse into one
  // property, silently dropping the parameter's constraint and leaving the
  // caller no way to address it. Refuse at build time rather than publish an
  // ambiguous tool. Unreachable from the contracts registered today.
  const collision = Object.keys(bodyProperties).find((name) => name in properties);
  if (collision) {
    throw new Error(`Tool argument collision on "${collision}": a request-body field shadows a parameter of the same name.`);
  }

  return {
    type: 'object',
    properties: { ...properties, ...bodyProperties },
    ...(allRequired.length > 0 ? { required: allRequired } : {}),
    // `additionalProperties` rides along from a passthrough body contract (the
    // A1111 txt2img schema is deliberately open); closed otherwise so a model
    // doesn't invent arguments.
    additionalProperties: bodyIsObject ? (body.additionalProperties ?? false) : false,
  };
};

/**
 * Describe the success payload. A modeled `application/json` 200 wins; a
 * non-JSON 200 (the WAV synthesize response) is reported by media type so a
 * caller knows not to parse it as JSON.
 */
const outputSchemaFor = (operation) => {
  const success = operation.responses?.[200];
  const json = jsonSchemaOf(success);
  if (json) return json;
  const mediaType = Object.keys(success?.content ?? {})[0];
  if (mediaType) return { type: 'string', format: 'binary', 'x-portos-media-type': mediaType };
  return OBJECT_OUTPUT_SCHEMA;
};

/**
 * The failures an operation declares, as `{ status, code }` pairs.
 *
 * These are the DECLARED failure modes — the ones the contract commits to — not
 * an exhaustive enumeration of every error an internal service can surface. A
 * caller should still handle an unlisted code, which is why the resource also
 * publishes the full status/code vocabulary at the top level.
 *
 * A status does NOT determine the code: `errorHandler` uses
 * `err.code || getErrorCode(status)`, so a route that passes an explicit code
 * (most do) emits something the status map would never produce — PortOS throws
 * `VALIDATION_ERROR` at 400, where the map says `BAD_REQUEST`. The contract
 * therefore declares the real codes in `x-portos-error-codes`, and the status
 * map is only the fallback for a response that didn't. One status can carry
 * several codes, so each pair gets its own entry.
 */
const failuresFor = (operation) => Object.entries(operation.responses ?? {})
  .map(([status, response]) => [Number(status), response])
  .filter(([status]) => Number.isFinite(status) && status >= 400)
  .sort(([a], [b]) => a - b)
  .flatMap(([status, response]) => {
    const declared = response?.['x-portos-error-codes'];
    const codes = Array.isArray(declared) && declared.length > 0
      ? declared
      : [ERROR_CODES_BY_STATUS[status] ?? 'INTERNAL_ERROR'];
    return codes.map((code) => ({ status, code }));
  });

const toolFor = ({ path, method, operation }) => {
  const annotation = operation['x-portos-tool'];
  const failures = failuresFor(operation);
  return {
    type: 'portos_tool',
    name: annotation.name,
    version: annotation.version,
    providerName: providerToolName(annotation.name),
    description: operation.description || operation.summary,
    input_schema: inputSchemaFor(operation, path),
    output_schema: outputSchemaFor(operation),
    policy: {
      ...annotation.policy,
      idempotent: annotation.policy?.sideEffect === 'read',
    },
    binding: { protocol: 'http', method: method.toUpperCase(), path },
    ...(failures.length > 0 ? { failures } : {}),
  };
};

/** Every contract operation carrying an `x-portos-tool` annotation, in declaration order. */
const annotatedOperations = () => Object.entries(API_OPERATION_CONTRACTS).flatMap(
  ([path, pathItem]) => Object.entries(pathItem)
    .filter(([, operation]) => operation['x-portos-tool'])
    .map(([method, operation]) => ({ path, method, operation })),
);

/**
 * Build the minimized semantic tool resource.
 *
 * Independent of Settings > API Access on purpose: like the internal OpenAPI
 * document, this describes the annotated surface itself. Whether a given tool
 * is currently reachable is enforced at call time by the API registry, not by
 * hiding it from the catalog — an agent that can't see a tool can't be told
 * why its call was refused.
 */
export const buildToolResource = ({ version = '0.0.0' } = {}) => {
  const tools = annotatedOperations().map(toolFor);
  return {
    type: TOOL_RESOURCE_TYPE,
    schemaVersion: 1,
    portosVersion: version,
    // Where the tools come from, and how to read their schemas — the two are
    // deliberately different. The operations are the ones the 3.0.3 document
    // publishes, but `input_schema`/`output_schema` stay plain JSON Schema
    // because that is what a provider tool definition takes; a 3.0.3 `nullable`
    // would be an unknown keyword there and the null branch would be lost.
    source: { document: 'openapi', version: OPENAPI_VERSION },
    schemaDialect: 'https://json-schema.org/draft/2020-12/schema',
    tools,
    errors: Object.entries(ERROR_CODES_BY_STATUS).map(([status, code]) => ({ status: Number(status), code })),
    stats: {
      total: tools.length,
      read: tools.filter((tool) => tool.policy.sideEffect === 'read').length,
      write: tools.filter((tool) => tool.policy.sideEffect !== 'read').length,
    },
  };
};
