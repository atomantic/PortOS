/** OpenAPI 3.0.3 builders for PortOS's exposed and complete HTTP API surfaces. */

import { API_OPERATION_CONTRACTS } from './apiOperationContracts.js';
import {
  buildApiCatalog,
  expressPathToOpenApiPath,
  pathParametersFor,
} from './apiCatalog.js';
import { resolveApiAccess } from './apiRegistry.js';
import { OPENAPI_VERSION, toOpenApi30Operation } from './openapiDowngrade.js';

const SECURITY_SCHEMES = {
  bearerAuth: { type: 'http', scheme: 'bearer', description: 'PortOS session token, when instance authentication is enabled.' },
  basicAuth: { type: 'http', scheme: 'basic', description: 'PortOS password via HTTP Basic; the username is ignored.' },
};

const authenticatedSecurity = [{ bearerAuth: [] }, { basicAuth: [] }];

const applySecurity = (pathItem, requireAuth) => Object.fromEntries(
  Object.entries(pathItem).map(([method, operation]) => [
    method,
    { ...operation, security: requireAuth ? authenticatedSecurity : [] },
  ]),
);

const commonEnvelope = ({ title, description, baseUrl, version, tags, paths }) => ({
  openapi: OPENAPI_VERSION,
  info: { title, version, description },
  servers: baseUrl ? [{ url: baseUrl }] : [],
  tags,
  paths,
  components: { securitySchemes: SECURITY_SCHEMES },
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
  return {
    operationId: apiOperationId(operation.method, operation.path),
    summary: operation.summary,
    description: `Generated from the mounted Express route inventory. Detailed request and response schemas are not modeled yet. Source: ${operation.sources.join(', ')}.`,
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

// The contract's schemas are JSON Schema; this document declares 3.0.3, so they
// convert on the way in. Generated operations model no schemas and need none.
const modeledOperation = (operation, contract) => toOpenApi30Operation({
  ...generatedOperation(operation),
  ...contract,
  operationId: apiOperationId(operation.method, operation.path),
  tags: [operation.domain],
  security: operation.access === 'always-public' ? [] : authenticatedSecurity,
  'x-portos-contract-status': 'modeled',
});

/** Build the OpenAPI document for public APIs currently exposed in Settings. */
export const buildOpenApiSpec = (settings, { baseUrl, version = '0.0.0' } = {}) => {
  const paths = {};
  const tags = [];

  for (const api of resolveApiAccess(settings)) {
    if (!api.exposed) continue;
    tags.push({ name: api.id, description: api.description });
    for (const path of api.docPaths) {
      const pathItem = API_OPERATION_CONTRACTS[path];
      if (!pathItem) continue;
      const tagged = Object.fromEntries(
        Object.entries(pathItem).map(([method, operation]) => [
          method,
          toOpenApi30Operation({ tags: [api.id], ...operation }),
        ]),
      );
      paths[path] = applySecurity(tagged, api.requireAuth);
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
