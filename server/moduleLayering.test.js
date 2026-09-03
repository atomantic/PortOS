/**
 * Layer-direction guard: nothing under `server/services/` or `server/lib/`
 * statically imports `server/routes/` (#5721).
 *
 * Root `AGENTS.md` puts Express handlers in `server/routes/`, domain
 * orchestration in `server/services/`, and pure helpers in `server/lib/` —
 * routes consume the lower layers, never the other way round. `appPortConfig.js`
 * had drifted the other way, importing `deriveUiPort` from
 * `routes/apps/shared.js`, which only re-exports it from
 * `services/appListEnrichment.js`. The cost was not a broken behavior — the
 * symbol was correct — so no behavior test could see it: loading a port-config
 * service simply dragged in `asyncHandler`, a route middleware factory, and
 * `services/apps.js`. That is precisely the class of regression a structural
 * assertion catches and a functional one cannot, and the inversion was a single
 * line, so the rule is enforceable as a hard zero rather than a baseline.
 *
 * Static edges only. `await import('../routes/x.js')` is deferred to call time
 * and does not pull the route layer into a service's initialization graph, so
 * it is out of scope here (as it is for the cycle ratchets).
 */

import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'url';
import { dirname, join, resolve, sep } from 'path';
import { listModuleFiles, staticImportSpecifiers } from './lib/staticImportGraph.js';

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROUTES_DIR = join(SERVER_DIR, 'routes');
const SCANNED_DIRS = ['services', 'lib'];

// True when `target` is `dir` itself or lives beneath it. The `sep` suffix is
// what keeps a sibling directory whose name merely starts the same
// (`routes-legacy/`) from reading as a violation.
const isUnder = (target, dir) => target === dir || target.startsWith(dir + sep);

/**
 * The specifiers in `specifiers` that resolve into `server/routes/` when read
 * from `fileAbs`. Resolution — not string matching — is the whole point: the
 * vendored toolkit at `lib/aiToolkit/index.js` legitimately imports
 * `./routes/providers.js`, its OWN self-contained route factories, and a
 * `includes('routes/')` test would flag it. Bare package specifiers can never
 * name a repo path, so they are dropped before resolving.
 */
const routeImportsOf = (fileAbs, specifiers) => specifiers
  .filter(spec => spec.startsWith('.'))
  .filter(spec => isUnder(resolve(dirname(fileAbs), spec), ROUTES_DIR));

describe('server module layering — services and lib never import routes (#5721)', () => {
  const modules = SCANNED_DIRS.flatMap((dir) => {
    const root = join(SERVER_DIR, dir);
    return listModuleFiles(root).map(rel => ({ label: `${dir}/${rel}`, abs: join(root, rel) }));
  });

  it('sees both module trees', () => {
    // The assertion below is a negative, so a scan that found nothing would read
    // as a clean sweep. Pin the scale, and pin it per directory so a moved root
    // cannot be masked by the other tree's count.
    for (const dir of SCANNED_DIRS) {
      const count = modules.filter(entry => entry.label.startsWith(`${dir}/`)).length;
      expect(count, `server/${dir} scan looks empty — did the root move?`).toBeGreaterThan(100);
    }
  });

  it('flags an import that resolves into routes, and only that', () => {
    // Bypass probe for the detector itself: without it, a `routeImportsOf` that
    // always returned `[]` would satisfy the real assertion forever.
    const service = join(SERVER_DIR, 'services', 'appPortConfig.js');
    expect(routeImportsOf(service, ['../routes/apps/shared.js'])).toEqual(['../routes/apps/shared.js']);
    expect(routeImportsOf(join(SERVER_DIR, 'services', 'pipeline', 'x.js'), ['../../routes/apps.js']))
      .toEqual(['../../routes/apps.js']);

    // And the converse — the legitimate shapes must NOT flag, or the guard would
    // be satisfied by a detector that flags everything.
    expect(routeImportsOf(service, ['./appListEnrichment.js', 'zod', '../lib/ports.js'])).toEqual([]);
    // The vendored toolkit's own `routes/` subtree is inside lib, not the
    // server's route layer.
    expect(routeImportsOf(join(SERVER_DIR, 'lib', 'aiToolkit', 'index.js'), ['./routes/providers.js']))
      .toEqual([]);
  });

  it('has no service or lib module importing the route layer', () => {
    const violations = modules.flatMap(({ label, abs }) =>
      routeImportsOf(abs, staticImportSpecifiers(abs)).map(spec => `${label} → ${spec}`));

    expect(violations, [
      'a module under server/services or server/lib statically imports server/routes:',
      ...violations,
      '',
      'Routes consume services and lib, never the reverse. Import the module that',
      'DECLARES the symbol — a route barrel that re-exports it is not a source.',
    ].join('\n')).toEqual([]);
  });
});
