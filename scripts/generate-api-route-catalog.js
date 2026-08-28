#!/usr/bin/env node
/**
 * Generate the complete HTTP route inventory consumed by the PortOS API
 * Explorer and internal OpenAPI document.
 *
 * Express routers are the runtime source of truth, but Express 5 deliberately
 * hides a nested router's mount path inside a matcher closure. Introspecting
 * private router internals would therefore lose paths such as
 * `/api/brain/songbook/*` and would couple PortOS to an undocumented Express
 * representation. This scanner follows the checked-in source graph instead:
 *
 *   server/index.js app.use('/api/...', router)
 *     -> route module imports
 *     -> router.use('/optional-prefix', childRouter)
 *     -> router.get/post/put/patch/delete(...)
 *
 * PortOS route paths are string literals by convention, so the generated file
 * is deterministic, works in packaged installs without a source scan, and is
 * guarded against drift by `generate-api-route-catalog.test.js`.
 *
 * Usage: node scripts/generate-api-route-catalog.js
 */

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectlyInvoked } from './lib/directInvocation.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..');
export const MANIFEST_RELATIVE_PATH = 'server/lib/apiRouteCatalog.generated.json';
export const REGENERATE_COMMAND = 'node scripts/generate-api-route-catalog.js';

const INDEX_RELATIVE_PATH = 'server/index.js';
const ROUTE_METHODS = Object.freeze(['delete', 'get', 'head', 'options', 'patch', 'post', 'put']);
const ROUTE_METHOD_SET = new Set([...ROUTE_METHODS, 'all']);

const DEFAULT_IMPORT_RE = /\bimport\s+([A-Za-z_$][\w$]*)\s+from\s*(['"])(\.{1,2}\/[^'"\n]+)\2\s*;?/g;
const NAMED_IMPORT_RE = /\bimport\s*\{([\s\S]*?)\}\s*from\s*(['"])(\.{1,2}\/[^'"\n]+)\2\s*;?/g;
const ROUTER_DECL_RE = /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:express\.)?Router\s*\(/g;
const DEFAULT_EXPORT_RE = /\bexport\s+default\s+([A-Za-z_$][\w$]*)\s*;?/;
const ROUTE_DECL_RE = /\b([A-Za-z_$][\w$]*)\.(get|post|put|patch|delete|head|options|all)\(\s*(['"])([^'"\n]*)\3/g;
const ROUTER_USE_RE = /\b([A-Za-z_$][\w$]*)\.use\(\s*(?:(['"])([^'"\n]*)\2\s*,\s*)?([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\)/g;
const APP_MOUNT_RE = /\bapp\.use\(\s*(['"])(\/(?:api|sdapi)[^'"\n]*)\1\s*,\s*([A-Za-z_$][\w$]*)(?:\s*\([^;]*?\))?\s*\)/g;
const COMPOSED_ROUTER_RE = /^([A-Za-z_$][\w$]*)\.routes\.([A-Za-z_$][\w$]*)$/;
const RETURN_COMPOSED_ROUTER_RE = /\breturn\s+([A-Za-z_$][\w$]*\.routes\.[A-Za-z_$][\w$]*)\s*;/;

const toPosix = (path) => path.split(sep).join('/');

const isFile = (path) => {
  return existsSync(path) && statSync(path).isFile();
};

const isDirectory = (path) => {
  return existsSync(path) && statSync(path).isDirectory();
};

export function resolveLocalModule(fromFile, specifier) {
  const candidate = resolve(dirname(fromFile), specifier);
  if (extname(candidate) && isFile(candidate)) return candidate;
  if (isFile(`${candidate}.js`)) return `${candidate}.js`;
  if (isDirectory(candidate) && isFile(join(candidate, 'index.js'))) return join(candidate, 'index.js');
  return null;
}

const importedName = (fragment) => {
  const normalized = fragment.trim().replace(/^type\s+/, '');
  if (!normalized) return null;
  const match = normalized.match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
  return match ? { imported: match[1], local: match[2] || match[1] } : null;
};

export function parseImports(source, filePath) {
  const imports = new Map();
  for (const match of source.matchAll(DEFAULT_IMPORT_RE)) {
    const resolved = resolveLocalModule(filePath, match[3]);
    if (resolved) imports.set(match[1], { file: resolved, imported: 'default' });
  }
  for (const match of source.matchAll(NAMED_IMPORT_RE)) {
    const resolved = resolveLocalModule(filePath, match[3]);
    if (!resolved) continue;
    for (const fragment of match[1].split(',')) {
      const name = importedName(fragment);
      if (name) imports.set(name.local, { file: resolved, imported: name.imported });
    }
  }
  return imports;
}

const sourceLineFor = (source, index) => source.slice(0, index).split('\n').length;

const resolveComposedRouter = (expression, repoRoot) => {
  const routeName = expression.match(COMPOSED_ROUTER_RE)?.[2];
  if (!routeName) return null;
  const file = join(repoRoot, 'server', 'lib', 'aiToolkit', 'routes', `${routeName}.js`);
  return isFile(file) ? { file, imported: 'factory-router' } : null;
};

export function parseRouteModule(filePath, repoRoot = REPO_ROOT) {
  const source = readFileSync(filePath, 'utf8');
  const routerIds = new Set([...source.matchAll(ROUTER_DECL_RE)].map((match) => match[1]));
  const imports = parseImports(source, filePath);
  const defaultExport = source.match(DEFAULT_EXPORT_RE)?.[1] || null;
  const rootChild = resolveComposedRouter(source.match(RETURN_COMPOSED_ROUTER_RE)?.[1] || '', repoRoot);
  const routes = [];
  const mounts = [];

  for (const match of source.matchAll(ROUTE_DECL_RE)) {
    if (!routerIds.has(match[1]) || !ROUTE_METHOD_SET.has(match[2])) continue;
    const methods = match[2] === 'all' ? ROUTE_METHODS : [match[2]];
    for (const method of methods) {
      routes.push({
        routerId: match[1],
        method,
        path: match[4],
        source: toPosix(relative(repoRoot, filePath)),
        line: sourceLineFor(source, match.index),
      });
    }
  }

  for (const match of source.matchAll(ROUTER_USE_RE)) {
    if (!routerIds.has(match[1])) continue;
    const childId = match[4];
    const child = imports.get(childId) || resolveComposedRouter(childId, repoRoot);
    if (!routerIds.has(childId) && !child) continue;
    mounts.push({
      routerId: match[1],
      prefix: match[3] || '',
      childId,
      child,
    });
  }

  const rootRouterId = defaultExport && routerIds.has(defaultExport)
    ? defaultExport
    : routerIds.has('router') ? 'router' : [...routerIds][0] || null;

  return { filePath, source, routerIds, imports, defaultExport, rootRouterId, rootChild, routes, mounts };
}

const joinRoutePath = (...parts) => {
  const joined = parts
    .filter((part) => typeof part === 'string' && part.length > 0)
    .map((part) => part.replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');
  return `/${joined}`.replace(/\/{2,}/g, '/');
};

const uniqueSortedSources = (sources) => [...new Map(
  sources
    .sort((a, b) => a.source.localeCompare(b.source) || a.line - b.line)
    .map((entry) => [`${entry.source}:${entry.line}`, entry]),
).values()];

export function parseTopLevelMounts({ source, filePath, repoRoot = REPO_ROOT }) {
  const imports = parseImports(source, filePath);
  const mounts = [];
  for (const match of source.matchAll(APP_MOUNT_RE)) {
    const imported = imports.get(match[3]);
    if (!imported) continue;
    mounts.push({
      mountPath: match[2],
      routerName: match[3],
      filePath: imported.file,
      imported: imported.imported,
      source: toPosix(relative(repoRoot, filePath)),
      line: sourceLineFor(source, match.index),
    });
  }
  return mounts;
}

export function buildApiRouteCatalog({ repoRoot = REPO_ROOT, indexSource } = {}) {
  const indexPath = join(repoRoot, INDEX_RELATIVE_PATH);
  const source = indexSource ?? readFileSync(indexPath, 'utf8');
  const topLevelMounts = parseTopLevelMounts({ source, filePath: indexPath, repoRoot });
  const moduleCache = new Map();
  const operations = new Map();
  const declarationKeys = new Set();

  const readModule = (filePath) => {
    if (!moduleCache.has(filePath)) moduleCache.set(filePath, parseRouteModule(filePath, repoRoot));
    return moduleCache.get(filePath);
  };

  const record = ({ method, path, mountPath, declaration }) => {
    const key = `${method.toUpperCase()} ${path}`;
    declarationKeys.add(`${declaration.source}:${declaration.line}:${method}`);
    const existing = operations.get(key) || {
      method: method.toUpperCase(),
      path,
      mountPath,
      sources: [],
    };
    existing.sources.push({ source: declaration.source, line: declaration.line });
    operations.set(key, existing);
  };

  const walkRouter = ({ filePath, routerId, prefix, mountPath, ancestry }) => {
    const cycleKey = `${filePath}#${routerId}`;
    if (ancestry.has(cycleKey)) return;
    const nextAncestry = new Set(ancestry).add(cycleKey);
    const parsed = readModule(filePath);
    if (!routerId) {
      if (parsed.rootChild) {
        const childModule = readModule(parsed.rootChild.file);
        walkRouter({
          filePath: parsed.rootChild.file,
          routerId: childModule.rootRouterId,
          prefix,
          mountPath,
          ancestry: nextAncestry,
        });
      }
      return;
    }

    for (const route of parsed.routes.filter((entry) => entry.routerId === routerId)) {
      record({
        method: route.method,
        path: joinRoutePath(prefix, route.path),
        mountPath,
        declaration: route,
      });
    }

    for (const mount of parsed.mounts.filter((entry) => entry.routerId === routerId)) {
      if (mount.child) {
        const childModule = readModule(mount.child.file);
        walkRouter({
          filePath: mount.child.file,
          routerId: childModule.rootRouterId,
          prefix: joinRoutePath(prefix, mount.prefix),
          mountPath,
          ancestry: nextAncestry,
        });
      } else {
        walkRouter({
          filePath,
          routerId: mount.childId,
          prefix: joinRoutePath(prefix, mount.prefix),
          mountPath,
          ancestry: nextAncestry,
        });
      }
    }
  };

  for (const mount of topLevelMounts) {
    const parsed = readModule(mount.filePath);
    walkRouter({
      filePath: mount.filePath,
      routerId: parsed.rootRouterId,
      prefix: mount.mountPath,
      mountPath: mount.mountPath,
      ancestry: new Set(),
    });
  }

  const routes = [...operations.values()]
    .map((operation) => ({ ...operation, sources: uniqueSortedSources(operation.sources) }))
    .sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));

  return {
    schemaVersion: 1,
    mounts: [...new Set(topLevelMounts.map((mount) => mount.mountPath))].sort(),
    routes,
    stats: {
      mounts: new Set(topLevelMounts.map((mount) => mount.mountPath)).size,
      operations: routes.length,
      declarations: declarationKeys.size,
      sourceFiles: moduleCache.size,
    },
  };
}

export const serializeApiRouteCatalog = (catalog) => `${JSON.stringify(catalog, null, 2)}\n`;

export function generateApiRouteCatalog(repoRoot = REPO_ROOT) {
  return buildApiRouteCatalog({ repoRoot });
}

export function readApiRouteCatalog(repoRoot = REPO_ROOT) {
  return JSON.parse(readFileSync(join(repoRoot, MANIFEST_RELATIVE_PATH), 'utf8'));
}

function main() {
  const catalog = generateApiRouteCatalog();
  writeFileSync(join(REPO_ROOT, MANIFEST_RELATIVE_PATH), serializeApiRouteCatalog(catalog), 'utf8');
  console.log(`📚 Wrote ${MANIFEST_RELATIVE_PATH}: ${catalog.stats.operations} operations from ${catalog.stats.declarations} declarations across ${catalog.stats.mounts} mounts`);
}

if (isDirectlyInvoked(import.meta.url)) main();
