/**
 * Searchable metadata projection of the generated HTTP route inventory.
 *
 * The generated manifest answers what is mounted. This module adds stable,
 * explicitly-inferred documentation metadata without importing Express route
 * modules or their service graphs.
 */

import { readFileSync } from 'node:fs';
import { ALWAYS_PUBLIC_API_PATHS } from './apiAccessPolicy.js';
import { modeledApiOperationKeys } from './apiOperationContracts.js';
import { API_REGISTRY, resolveApiAccess } from './apiRegistry.js';

const routeManifest = JSON.parse(readFileSync(
  new URL('./apiRouteCatalog.generated.json', import.meta.url),
  'utf8',
));

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const PROCESS_ACTION_RE = /\/(start|stop|restart|launch|open|install|uninstall|execute|run|cancel|interrupt|resume|pause|reload|sync|update)(?:\/|$)/i;
const DESTRUCTIVE_ACTION_RE = /\/(delete|remove|clear|reset|revoke|terminate|logout|archive)(?:\/|$)/i;
const alwaysPublicPaths = new Set(ALWAYS_PUBLIC_API_PATHS);
const modeledOperationKeys = modeledApiOperationKeys();

const titleCase = (value) => value
  .replace(/[-_]+/g, ' ')
  .replace(/\b\w/g, (char) => char.toUpperCase());

export const expressPathToOpenApiPath = (path) => path
  .replace(/:([A-Za-z0-9_]+)\??/g, '{$1}')
  .replace(/\*([A-Za-z0-9_]+)/g, '{$1}');

export const apiDomainForPath = (path) => {
  const parts = path.split('/').filter(Boolean);
  if (parts[0] === 'api') return parts[1] || 'api';
  return parts[0] || 'root';
};

export const apiSideEffectFor = (method, path) => {
  if (READ_METHODS.has(method)) return 'read';
  if (method === 'DELETE' || DESTRUCTIVE_ACTION_RE.test(path)) return 'destructive';
  if (PROCESS_ACTION_RE.test(path)) return 'process-control';
  return 'write';
};

export const apiAccessForPath = (path) => {
  if (alwaysPublicPaths.has(path)) return 'always-public';
  if (path.startsWith('/api/agent-context/')) return 'loopback';
  if (API_REGISTRY.some((entry) => entry.publicPrefixes.some((prefix) => path.startsWith(prefix)))) {
    return 'externally-exposable';
  }
  return 'authenticated-ui';
};

export const apiSummaryFor = (method, path) => {
  const segments = path.split('/').filter(Boolean).slice(path.startsWith('/api/') ? 2 : 1);
  const resource = segments
    .filter((segment) => !segment.startsWith(':') && !segment.startsWith('*'))
    .slice(-2)
    .join(' ');
  const verbs = { GET: 'Read', POST: 'Create or run', PUT: 'Replace', PATCH: 'Update', DELETE: 'Delete' };
  return `${verbs[method] || titleCase(method.toLowerCase())} ${titleCase(resource || apiDomainForPath(path))}`;
};

export const pathParametersFor = (path) => {
  const matches = [...path.matchAll(/(?:^|\/)(?::([A-Za-z0-9_]+)\??|\*([A-Za-z0-9_]+))/g)];
  return matches.map((match) => ({
    name: match[1] || match[2],
    in: 'path',
    required: true,
    schema: { type: 'string' },
  }));
};

export const getApiRouteCatalog = () => routeManifest;

export const buildApiCatalog = (settings = {}) => {
  const operations = routeManifest.routes.map((route) => {
    const domain = apiDomainForPath(route.path);
    const key = `${route.method} ${route.path}`;
    return {
      ...route,
      openApiPath: expressPathToOpenApiPath(route.path),
      domain,
      domainLabel: titleCase(domain),
      summary: apiSummaryFor(route.method, route.path),
      access: apiAccessForPath(route.path),
      sideEffect: apiSideEffectFor(route.method, route.path),
      contractStatus: modeledOperationKeys.has(key) ? 'modeled' : 'generated',
    };
  });

  const domains = [...new Set(operations.map((operation) => operation.domain))]
    .map((id) => ({ id, label: titleCase(id), operations: operations.filter((operation) => operation.domain === id).length }));
  const modeled = operations.filter((operation) => operation.contractStatus === 'modeled').length;

  return {
    schemaVersion: 1,
    generatedFrom: 'server/index.js and mounted Express routers',
    regenerateCommand: 'node scripts/generate-api-route-catalog.js',
    stats: { ...routeManifest.stats, domains: domains.length, modeled, generated: operations.length - modeled },
    domains,
    externallyExposableApis: resolveApiAccess(settings),
    operations,
  };
};
