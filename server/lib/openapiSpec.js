/** OpenAPI 3.0 builders for PortOS's exposed and complete HTTP API surfaces. */

import { API_OPERATION_CONTRACTS } from './apiOperationContracts.js';
import {
  buildApiCatalog,
  expressPathToOpenApiPath,
  pathParametersFor,
} from './apiCatalog.js';
import { resolveApiAccess } from './apiRegistry.js';

const SECURITY_SCHEMES = {
  bearerAuth: { type: 'http', scheme: 'bearer', description: 'PortOS session token, when instance authentication is enabled.' },
  basicAuth: { type: 'http', scheme: 'basic', description: 'PortOS password via HTTP Basic; the username is ignored.' },
};

const authenticatedSecurity = [{ bearerAuth: [] }, { basicAuth: [] }];

export const STANDARD_API_ERRORS = Object.freeze([
  { code: 'VALIDATION_ERROR', status: 400, retry: 'fix_arguments', description: 'The request body, path, or query parameters failed validation.' },
  { code: 'UNAUTHENTICATED', status: 401, retry: 'authenticate', description: 'A valid PortOS session or configured HTTP credential is required.' },
  { code: 'FORBIDDEN', status: 403, retry: 'do_not_retry', description: 'The caller is authenticated but lacks access to this operation.' },
  { code: 'NOT_FOUND', status: 404, retry: 'refresh_state', description: 'The requested route or resource does not exist.' },
  { code: 'CONFLICT', status: 409, retry: 'refresh_state', description: 'The requested state transition conflicts with current state.' },
  { code: 'RATE_LIMITED', status: 429, retry: 'backoff', description: 'The caller must honor Retry-After before retrying.' },
  { code: 'SERVICE_UNAVAILABLE', status: 503, retry: 'backoff', description: 'A required local service is unavailable.' },
  { code: 'UPSTREAM_ERROR', status: 502, retry: 'backoff_if_retryable', description: 'An external dependency failed; no secret or stack trace is exposed.' },
  { code: 'INTERNAL_ERROR', status: 500, retry: 'surface_request_id', description: 'PortOS failed unexpectedly; retain the request ID for diagnosis.' },
  { code: 'TOOL_NOT_FOUND', status: 404, retry: 'refresh_catalog', description: 'The semantic tool name is not in the current catalog.' },
  { code: 'TOOL_UNAVAILABLE', status: 409, retry: 'report_setup', description: 'The tool exists but its feature, provider, or account is not ready.' },
  { code: 'TOOL_SCOPE_DENIED', status: 403, retry: 'do_not_retry', description: 'The caller scope cannot use this semantic tool.' },
  { code: 'TOOL_CAPABILITY_DENIED', status: 403, retry: 'do_not_retry', description: 'The caller lacks a required server-side capability grant.' },
  { code: 'TOOL_AUTH_REQUIRED', status: 403, retry: 'authenticate', description: 'A mutation requires an authenticated trusted UI session.' },
  { code: 'TOOL_VALIDATION_ERROR', status: 400, retry: 'fix_arguments', description: 'Tool arguments failed the tool input schema.' },
  { code: 'TOOL_IDEMPOTENCY_CONFLICT', status: 409, retry: 'new_request_id', description: 'A request ID was already bound to different arguments.' },
  { code: 'TOOL_IDEMPOTENCY_EXPIRED', status: 409, retry: 'do_not_retry', description: 'The original result expired and cannot be safely replayed.' },
  { code: 'TOOL_CALL_NOT_FOUND', status: 404, retry: 'refresh_state', description: 'No retained result exists for the requested tool call.' },
  { code: 'TOOL_IDEMPOTENCY_MISMATCH', status: 400, retry: 'fix_request_id', description: 'The Idempotency-Key does not match the requestId body field.' },
]);

const errorSchema = {
  type: 'object',
  required: ['error', 'code', 'timestamp'],
  properties: {
    error: { type: 'string', description: 'Safe human-readable error summary.' },
    code: { type: 'string', enum: STANDARD_API_ERRORS.map(({ code }) => code), description: 'Stable machine-readable PortOS error code.' },
    timestamp: { type: 'integer', format: 'int64' },
    context: { type: 'object', additionalProperties: true },
  },
};

const applySecurity = (pathItem, requireAuth) => Object.fromEntries(
  Object.entries(pathItem).map(([method, operation]) => [
    method,
    { ...operation, security: requireAuth ? authenticatedSecurity : [] },
  ]),
);

const commonEnvelope = ({ title, description, baseUrl, version, tags, paths }) => ({
  openapi: '3.0.3',
  info: { title, version, description, 'x-portos-contract-version': 1 },
  servers: baseUrl ? [{ url: baseUrl }] : [],
  tags,
  paths,
  components: {
    securitySchemes: SECURITY_SCHEMES,
    schemas: { PortosError: errorSchema },
    responses: Object.fromEntries(STANDARD_API_ERRORS.map(({ code, status, description }) => [code, {
      description,
      content: { 'application/json': { schema: { $ref: '#/components/schemas/PortosError' } } },
      'x-portos-error-code': code,
      'x-portos-status': status,
    }])),
  },
});

const operationHash = (value) => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
};

export const apiOperationId = (method, path) => {
  const readable = `${method.toLowerCase()}_${path}`
    .replace(/[{}:*?]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
  return `${readable}_${operationHash(`${method} ${path}`)}`;
};

const generatedOperation = (operation) => {
  const parameters = pathParametersFor(operation.path);
  const source = operation.sources.map(({ source: file, line }) => `${file}:${line}`).join(', ');
  return {
    operationId: apiOperationId(operation.method, operation.path),
    summary: operation.summary,
    description: `Generated from the mounted Express route inventory. Detailed request and response schemas are not modeled yet. Source: ${source}.`,
    tags: [operation.domain],
    ...(parameters.length ? { parameters } : {}),
    responses: { default: { description: 'Response shape is not yet modeled.' } },
    security: operation.access === 'always-public' ? [] : authenticatedSecurity,
    'x-portos-contract-status': 'generated',
    'x-portos-express-path': operation.path,
    'x-portos-mount': operation.mountPath,
    'x-portos-source': operation.sources,
    'x-portos-access': operation.access,
    'x-portos-side-effect': operation.sideEffect,
  };
};

const modeledOperation = (operation, contract) => ({
  ...generatedOperation(operation),
  ...contract,
  operationId: apiOperationId(operation.method, operation.path),
  tags: [operation.domain],
  security: operation.access === 'always-public' ? [] : authenticatedSecurity,
  'x-portos-contract-status': 'modeled',
});

/** Build the OpenAPI document for public APIs currently exposed in Settings. */
export const buildOpenApiSpec = (settings, { baseUrl, version = '0.0.0', includeUnexposed = false } = {}) => {
  const paths = {};
  const tags = [];

  for (const api of resolveApiAccess(settings)) {
    if (!api.exposed && !includeUnexposed) continue;
    tags.push({ name: api.id, description: api.description });
    for (const path of api.docPaths) {
      const pathItem = API_OPERATION_CONTRACTS[path];
      if (!pathItem) continue;
      const tagged = Object.fromEntries(
        Object.entries(pathItem).map(([method, operation]) => [method, { tags: [api.id], ...operation }]),
      );
      paths[path] = applySecurity(tagged, api.requireAuth || !api.exposed);
    }
  }

  return commonEnvelope({
    title: 'PortOS Public API',
    description: 'Externally callable PortOS services. Only APIs exposed in Settings > API Access appear here.',
    baseUrl,
    version,
    tags,
    paths,
  });
};

/** Build the complete internal API reference from the generated route catalog. */
export const buildInternalOpenApiSpec = (settings, { baseUrl, version = '0.0.0' } = {}) => {
  const catalog = buildApiCatalog(settings);
  const paths = {};

  for (const operation of catalog.operations) {
    const openApiPath = expressPathToOpenApiPath(operation.path);
    const method = operation.method.toLowerCase();
    const contract = API_OPERATION_CONTRACTS[operation.path]?.[method];
    paths[openApiPath] ||= {};
    paths[openApiPath][method] = contract
      ? modeledOperation(operation, contract)
      : generatedOperation(operation);
  }

  return commonEnvelope({
    title: 'PortOS Internal HTTP API',
    description: 'Complete mounted HTTP route inventory for developers and local agents. Generated operations are discoverable but remain explicitly marked until their request and response schemas are modeled.',
    baseUrl,
    version,
    tags: catalog.domains.map((domain) => ({ name: domain.id, description: `${domain.label} API (${domain.operations} operations)` })),
    paths,
  });
};

const inputSchemaFor = (operation, spec) => {
  const body = operation.requestBody?.content?.['application/json']?.schema;
  if (body) return body;
  const parameters = (operation.parameters || []).filter((parameter) => ['path', 'query'].includes(parameter.in));
  return {
    type: 'object',
    additionalProperties: false,
    properties: Object.fromEntries(parameters.map((parameter) => [parameter.name, parameter.schema || {}])),
    ...(parameters.some((parameter) => parameter.required)
      ? { required: parameters.filter((parameter) => parameter.required).map((parameter) => parameter.name) }
      : {}),
  };
};

const dereferenceSchema = (schema, spec) => {
  const prefix = '#/components/schemas/';
  if (!schema?.$ref?.startsWith(prefix)) return schema;
  return spec.components.schemas[schema.$ref.slice(prefix.length)] || schema;
};

const outputSchemaFor = (operation, spec) => {
  const response = operation.responses?.['200'] || operation.responses?.default;
  const content = response?.content || {};
  const mediaType = Object.keys(content).find((type) => type === 'application/json') || Object.keys(content)[0];
  return mediaType ? dereferenceSchema(content[mediaType]?.schema || {}, spec) : { type: 'object' };
};

/**
 * Project only explicitly annotated semantic operations into a small,
 * provider-neutral resource. The exhaustive HTTP inventory never becomes a
 * model tool implicitly; adding `x-portos-tool` is an intentional review gate.
 */
export const buildToolCallingResource = (spec) => {
  const tools = [];
  const names = new Set();

  for (const [path, pathItem] of Object.entries(spec?.paths || {})) {
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
      const metadata = operation['x-portos-tool'];
      if (!metadata) continue;
      if (names.has(metadata.name)) throw new Error(`Duplicate PortOS tool name: ${metadata.name}`);
      names.add(metadata.name);
      tools.push({
        name: metadata.name,
        version: metadata.version || 1,
        description: metadata.description || operation.summary || operation.description || metadata.name,
        input_schema: inputSchemaFor(operation, spec),
        output_schema: outputSchemaFor(operation, spec),
        transport: { method: method.toUpperCase(), path },
        policy: {
          ...metadata.policy,
          requiresAuth: (operation.security || []).length > 0,
        },
      });
    }
  }

  tools.sort((left, right) => left.name.localeCompare(right.name));
  return {
    type: 'portos_tool_resource',
    schemaVersion: 1,
    source: { format: 'openapi', version: spec?.openapi || '3.0.3' },
    server: spec?.servers?.[0]?.url || null,
    errors: STANDARD_API_ERRORS,
    tools,
  };
};
