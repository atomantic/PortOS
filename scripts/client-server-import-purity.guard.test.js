/**
 * Guard: client source and tests can only reach the server through browser-safe
 * `server/lib` leaves. Walk each leaf's imports and report the first impure edge
 * on each path so failures name the dependency chain that introduced it.
 *
 * This scans the tracked tree. It rides `ALWAYS_RUN_TESTS` because CI's import
 * graph cannot discover every source file the guard reads.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { moduleSpecifiers } from './lib/moduleGraph.js';
import { trackedFiles } from './lib/trackedFiles.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const isWithin = (root, file) => {
  const rel = posix.relative(root, file);
  return rel !== '..' && !rel.startsWith('../');
};

const resolveRelative = (file, specifier) => {
  const path = specifier.replaceAll('\\', '/').split(/[?#]/)[0];
  return /^\.{1,2}\//.test(path) ? posix.join(posix.dirname(file), path) : null;
};

function inspectClientImports(clientFiles, readSource) {
  const violations = [];
  const seen = new Set();
  const queue = [];
  for (const file of clientFiles) {
    const { statics: imports, deferred: dynamic } = moduleSpecifiers(readSource(file), file);
    for (const specifier of [...imports, ...dynamic]) {
      const target = resolveRelative(file, specifier);
      if (!target || !isWithin('server', target)) continue;
      if (!isWithin('server/lib', target) || target === 'server/lib') {
        violations.push(`${file} imports '${specifier}' → ${target} (resolves outside server/lib)`);
        continue;
      }
      queue.push({ file: target, chain: [file, target] });
    }
  }

  const entryCount = new Set(queue.map(({ file }) => file)).size;
  for (const { file, chain } of queue) {
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readSource(file);
    const trace = chain.join(' → ');
    if (source == null) {
      violations.push(`${trace} (module does not exist)`);
      continue;
    }
    const { statics: imports, deferred: dynamic } = moduleSpecifiers(source, file);
    for (const specifier of [...imports, ...dynamic]) {
      const target = resolveRelative(file, specifier);
      if (!target) {
        violations.push(`${trace} imports '${specifier}' (non-relative import (Node built-in or npm package))`);
      } else if (!isWithin('server/lib', target) || target === 'server/lib') {
        violations.push(`${trace} imports '${specifier}' → ${target} (resolves outside server/lib)`);
      } else {
        queue.push({ file: target, chain: [...chain, target] });
      }
    }
  }
  return { entryCount, violations };
}

describe('browser-safe server imports from the client (#6364, #16709)', () => {
  it('walks client imports and rejects direct or transitive edges outside server/lib', () => {
    const sources = trackedFiles(REPO_ROOT, ['client/src/*.js', 'client/src/*.jsx']);
    const { entryCount, violations } = inspectClientImports(sources, (file) => {
      const path = join(REPO_ROOT, file);
      return existsSync(path) ? readFileSync(path, 'utf8') : null;
    });
    // Detect a broken glob or parser producing a vacuous pass.
    expect(entryCount).toBeGreaterThan(10);
    expect(violations, 'The client may only import browser-safe server/lib modules. See the '
      + '"One pure module, one definition" rule in client/src/lib/README.md.').toEqual([]);
  });

  it.each([
    ['../../../server/services/universeBuilder/compile.js', (path) => `import { compile } from '${path}';`],
    ['../../../server/lib/../services/universeBuilder/compile.js', (path) => `export {
      compile,
    } from '${path}';`],
    ['../../../server/services/universeBuilder/compile.js?raw', (path) => `const lazy = () => import('${path}');`],
  ])('names the importing test and resolved edge for %s', (specifier, source) => {
    const file = 'client/src/lib/count.test.js';
    expect(inspectClientImports([file], () => source(specifier)).violations).toEqual([
      `${file} imports '${specifier}' → server/services/universeBuilder/compile.js (resolves outside server/lib)`,
    ]);
  });

  it('follows shared leaves and diagnoses impure edges with the import chain', () => {
    const file = 'client/src/lib/example.js';
    const modules = new Map([
      // A real backslash specifier (`\\` in source): Node's file-URL resolution reads `\` as `/`.
      [file, String.raw`export { result } from '..\\..\\..\\server\\lib\\leaf.js';`],
      ['server/lib/leaf.js', "import './nested.js';"],
      ['server/lib/nested.js', 'export const result = 1;'],
    ]);
    const inspect = () => inspectClientImports([file], (path) => modules.get(path));
    expect(inspect()).toEqual({ entryCount: 1, violations: [] });
    modules.set('server/lib/nested.js', "import 'node:fs';\nexport { helper } from '../services/helper.js';");
    expect(inspect().violations).toEqual(expect.arrayContaining([
      `${file} → server/lib/leaf.js → server/lib/nested.js imports 'node:fs' (non-relative import (Node built-in or npm package))`,
      `${file} → server/lib/leaf.js → server/lib/nested.js imports '../services/helper.js' → server/services/helper.js (resolves outside server/lib)`,
    ]));
  });

  it('ignores unrelated paths and comments', () => {
    const source = `// import '../../../server/index.js';
import './server/local.js';
export * from '../../../server-lookalike/index.js';`;
    expect(inspectClientImports(['client/src/lib/example.js'], () => source)).toEqual({ entryCount: 0, violations: [] });
  });
});
