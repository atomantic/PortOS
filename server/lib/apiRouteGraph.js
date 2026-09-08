/**
 * The mounted HTTP route graph, derived from source at first use.
 *
 * Express routers are the runtime source of truth, but Express 5 deliberately
 * hides a nested router's mount path inside a matcher closure. Introspecting
 * private router internals would lose paths such as `/api/brain/songbook/*`
 * and couple PortOS to an undocumented Express representation. This scanner
 * follows the checked-in source graph instead:
 *
 *   server/index.js app.use('/api/...', router)
 *     -> route module imports
 *     -> router.use('/optional-prefix', childRouter)
 *     -> router.get/post/put/patch/delete(...)
 *
 * PortOS route paths are string literals by convention, so the scan is
 * deterministic, and it reads exactly the route modules the server is running,
 * so it cannot be stale. `getApiRouteCatalog()` runs it once per process, the
 * way `socketEventInventory.js` derives the Socket.IO inventory; why it is not
 * a committed manifest is in `server/AGENTS.md` ("Generated manifests").
 *
 * `scanRouteGraph()` also returns every declaration's content key
 * (`routeDeclarationKey`) so `apiRouteGraph.test.js` can prove the walk reaches
 * every declaration under `server/routes/` by comparing two in-memory scans.
 */

import { readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { resolveCodeRootForModule } from './dataRoot.js';
import { toModuleKey } from './staticImportGraph.js';

const DEFAULT_REPO_ROOT = resolveCodeRootForModule(import.meta.url);

const INDEX_RELATIVE_PATH = 'server/index.js';
const DERIVED_FROM = Object.freeze(['server/index.js', 'server/routes/**/*.js', 'server/lib/aiToolkit/routes/*.js']);
const ROUTE_METHODS = Object.freeze(['delete', 'get', 'head', 'options', 'patch', 'post', 'put']);
const ROUTE_METHOD_SET = new Set([...ROUTE_METHODS, 'all']);

const DEFAULT_IMPORT_RE = /\bimport\s+([A-Za-z_$][\w$]*)\s+from\s*(['"])(\.{1,2}\/[^'"\n]+)\2\s*;?/g;
// `[^}]*` rather than a lazy `[\s\S]*?`: the lazy form can run from a bare
// package import (`import { Router } from 'express'`) into the next relative
// import and swallow that statement's first binding.
const NAMED_IMPORT_RE = /\bimport\s*\{([^}]*)\}\s*from\s*(['"])(\.{1,2}\/[^'"\n]+)\2\s*;?/g;
const ROUTER_DECL_RE = /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:express\.)?Router\s*\(/g;
const DEFAULT_EXPORT_RE = /\bexport\s+default\s+([A-Za-z_$][\w$]*)\s*;?/;
const ROUTE_DECL_RE = /\b([A-Za-z_$][\w$]*)\.(get|post|put|patch|delete|head|options|all)\(\s*(['"])([^'"\n]*)\3/g;
const ROUTER_USE_RE = /\b([A-Za-z_$][\w$]*)\.use\(\s*(?:(['"])([^'"\n]*)\2\s*,\s*)?([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\)/g;
const APP_MOUNT_RE = /\bapp\.use\(\s*(['"])(\/(?:api|sdapi)[^'"\n]*)\1\s*,\s*([A-Za-z_$][\w$]*)(?:\s*\([^;]*?\))?\s*\)/g;
const COMPOSED_ROUTER_RE = /^([A-Za-z_$][\w$]*)\.routes\.([A-Za-z_$][\w$]*)$/;
const RETURN_COMPOSED_ROUTER_RE = /\breturn\s+([A-Za-z_$][\w$]*\.routes\.[A-Za-z_$][\w$]*)\s*;/;

const isFile = (path) => statSync(path, { throwIfNoEntry: false })?.isFile() === true;

const isDirectory = (path) => statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;

const resolveLocalModule = (fromFile, specifier) => {
  const candidate = resolve(dirname(fromFile), specifier);
  if (extname(candidate) && isFile(candidate)) return candidate;
  if (isFile(`${candidate}.js`)) return `${candidate}.js`;
  if (isDirectory(candidate) && isFile(join(candidate, 'index.js'))) return join(candidate, 'index.js');
  return null;
};

const importedName = (fragment) => {
  const normalized = fragment.trim().replace(/^type\s+/, '');
  if (!normalized) return null;
  const match = normalized.match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
  return match ? { imported: match[1], local: match[2] || match[1] } : null;
};

const parseImports = (source, filePath) => {
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
};

/**
 * Content identity for one `router.<method>('<path>')` call, stable across
 * the two scans the coverage guard compares.
 *
 * Two declarations collide when the same file registers the same method and
 * path on the same router *name* — normally a duplicate registration rather
 * than two distinct bindings. The exception is shadowing: a module-level
 * `const router = Router()` and a second one inside a factory share the id
 * `router`, so distinct bindings could collide and silently undercount. That
 * is why `scanRouteGraph` reports `duplicateDeclarationKeys` instead of just
 * folding them into a Set — see the collision assertion in the test.
 */
export const routeDeclarationKey = ({ source, routerId, method, path }) =>
  `${source}#${routerId} ${method.toUpperCase()} ${path || '/'}`;

const resolveComposedRouter = (expression, repoRoot) => {
  const routeName = expression.match(COMPOSED_ROUTER_RE)?.[2];
  if (!routeName) return null;
  const file = join(repoRoot, 'server', 'lib', 'aiToolkit', 'routes', `${routeName}.js`);
  return isFile(file) ? { file, imported: 'factory-router' } : null;
};

export function parseRouteModule(filePath, repoRoot = DEFAULT_REPO_ROOT) {
  const source = readFileSync(filePath, 'utf8');
  const moduleKey = toModuleKey(relative(repoRoot, filePath));
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
      routes.push({ routerId: match[1], method, path: match[4], source: moduleKey });
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

const parseTopLevelMounts = ({ source, filePath }) => {
  const imports = parseImports(source, filePath);
  const mounts = [];
  for (const match of source.matchAll(APP_MOUNT_RE)) {
    const imported = imports.get(match[3]);
    if (!imported) continue;
    mounts.push({ mountPath: match[2], filePath: imported.file });
  }
  return mounts;
};

/**
 * Walk the mounted route graph and return everything the scan learned,
 * including the `declarationKeys` that never reach the catalog —
 * `buildApiRouteCatalog` narrows this to the serializable subset.
 */
export function scanRouteGraph({ repoRoot = DEFAULT_REPO_ROOT, indexSource } = {}) {
  const indexPath = join(repoRoot, INDEX_RELATIVE_PATH);
  const source = indexSource ?? readFileSync(indexPath, 'utf8');
  const topLevelMounts = parseTopLevelMounts({ source, filePath: indexPath });
  const moduleCache = new Map();
  const operations = new Map();
  const declarationKeys = new Set();

  const readModule = (filePath) => {
    if (!moduleCache.has(filePath)) moduleCache.set(filePath, parseRouteModule(filePath, repoRoot));
    return moduleCache.get(filePath);
  };

  const record = ({ method, path, mountPath, declaration }) => {
    const key = `${method.toUpperCase()} ${path}`;
    declarationKeys.add(routeDeclarationKey(declaration));
    const existing = operations.get(key) || {
      method: method.toUpperCase(),
      path,
      mountPath,
      sources: [],
    };
    existing.sources.push(declaration.source);
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
    .map((operation) => ({ ...operation, sources: [...new Set(operation.sources)].sort() }))
    .sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));

  // Collisions are counted PER MODULE, from the parsed declarations rather than
  // from `record`: one router mounted at two prefixes reaches `record` twice
  // with the same declaration, which is the same binding seen twice, not two
  // bindings sharing a key. Within a single file, a repeated key is the real
  // thing — a duplicate registration, or two shadowed routers sharing a name.
  const duplicateDeclarationKeys = [...moduleCache.values()].flatMap((module) => {
    const seen = new Set();
    return module.routes
      .map((declaration) => routeDeclarationKey(declaration))
      .filter((key) => {
        if (seen.has(key)) return true;
        seen.add(key);
        return false;
      });
  }).sort();

  return {
    mounts: [...new Set(topLevelMounts.map((mount) => mount.mountPath))].sort(),
    routes,
    declarationKeys,
    duplicateDeclarationKeys,
    sourceFileCount: moduleCache.size,
  };
}

/** The serializable route inventory: `{ derivedFrom, mounts, routes, stats }`. */
export function buildApiRouteCatalog(options = {}) {
  const { mounts, routes, declarationKeys, sourceFileCount } = scanRouteGraph(options);
  return {
    derivedFrom: DERIVED_FROM,
    mounts,
    routes,
    stats: {
      mounts: mounts.length,
      operations: routes.length,
      declarations: declarationKeys.size,
      sourceFiles: sourceFileCount,
    },
  };
}

// Once per process, on the first request that needs it: route modules cannot
// change under a running server without a restart, and deferring the ~50 ms
// scan past import keeps it off every suite that merely reaches this module.
let cachedCatalog = null;
export const getApiRouteCatalog = () => (cachedCatalog ??= buildApiRouteCatalog());
