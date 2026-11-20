/**
 * The shared module graph (#16998): one extractor and one resolver behind the
 * planner's closures, its reach report and pregate's local selection, so the
 * contract below is what every one of them can rely on.
 */

import { describe, expect, it } from 'vitest';
import { BOUNDED_DYNAMIC_IMPORTS, createModuleGraph, moduleSpecifiers, resolveModuleCandidates } from './moduleGraph.js';

const graphOf = (sources) => createModuleGraph([...Object.keys(sources)].sort(), (path) => sources[path] ?? null);

describe('resolveModuleCandidates', () => {
  const known = new Set(['lib/a.js', 'lib/a.ts', 'lib/dir/index.js', 'lib/data.json', 'lib/plain']);

  it('completes extensions and directory indexes like the loader, keeping every colliding candidate', () => {
    expect(resolveModuleCandidates('lib/x.js', './a', known)).toEqual(['lib/a.js', 'lib/a.ts']);
    expect(resolveModuleCandidates('lib/x.js', './dir', known)).toEqual(['lib/dir/index.js']);
    expect(resolveModuleCandidates('lib/x.js', './data.json', known)).toEqual(['lib/data.json']);
    expect(resolveModuleCandidates('lib/x.js', './plain', known)).toEqual(['lib/plain']);
    expect(resolveModuleCandidates('lib/dir/y.js', '../a.js?raw', known)).toEqual(['lib/a.js']);
    expect(resolveModuleCandidates('lib/dir/y.js', '..\\dir', known)).toEqual(['lib/dir/index.js']);
  });

  it('never resolves a package, a miss or a path above the repository', () => {
    expect(resolveModuleCandidates('lib/x.js', 'express', known)).toEqual([]);
    expect(resolveModuleCandidates('lib/x.js', './missing.js', known)).toEqual([]);
    expect(resolveModuleCandidates('lib/x.js', '../../outside.js', known)).toEqual([]);
  });
});

describe('moduleSpecifiers', () => {
  it('reads TypeScript without JSX and finds a second declaration on the same line', () => {
    expect(moduleSpecifiers("const id = <T>(v: T) => v; import('./typed.js');", 'a.ts').deferred).toEqual(['./typed.js']);
    expect(moduleSpecifiers("import { a } from './a.js';import { b } from './b.js'", 'x.js').statics)
      .toEqual(['./a.js', './b.js']);
  });
});

describe('createModuleGraph', () => {
  it('walks static edges for production closures and adds literal import() targets for tests', () => {
    const graph = graphOf({
      'svc/entry.js': "import { a } from './a.js';\nexport const lazy = () => import('./lazy.js');\n",
      'svc/a.js': "import data from './data.json' with { type: 'json' };\nexport const a = data;\n",
      'svc/data.json': '{}',
      'svc/lazy.js': "import './deep.js';\n",
      'svc/deep.js': 'export {};\n',
    });
    expect(graph.closure(['svc/entry.js'], graph.staticDependencies)).toEqual(['svc/a.js', 'svc/data.json', 'svc/entry.js']);
    expect(graph.closure(['svc/entry.js'], graph.testDependencies))
      .toEqual(['svc/a.js', 'svc/data.json', 'svc/deep.js', 'svc/entry.js', 'svc/lazy.js']);
  });

  it('fails a closure closed on an unresolved edge, an unbounded computed import or an unreadable member', () => {
    const graph = graphOf({
      'unresolved.js': "import './gone.js';\n",
      'computed.js': 'export const load = (name) => import(name);\n',
      'missing.js': "import './absent.js';\n",
      'fine.js': 'export {};\n',
    });
    expect(graph.closure(['unresolved.js'], graph.staticDependencies)).toBeNull();
    // A computed import only matters where the test view follows import().
    expect(graph.closure(['computed.js'], graph.staticDependencies)).toEqual(['computed.js']);
    expect(graph.closure(['computed.js'], graph.testDependencies)).toBeNull();
    expect(graph.closure(['fine.js', 'not-tracked.js'], graph.staticDependencies)).toBeNull();
    expect(graph.closure(['fine.js', 'notes.md'], graph.staticDependencies)).toEqual(['fine.js', 'notes.md']);
  });

  it('expands a bounded computed import site to its enumerated directory', () => {
    const runner = 'scripts/run-migrations.js';
    expect(BOUNDED_DYNAMIC_IMPORTS[runner].directory).toBe('scripts/migrations/');
    const graph = graphOf({
      [runner]: 'export const run = (file) => import(file);\n',
      'scripts/migrations/001-first.js': 'export default {};\n',
      'scripts/migrations/_lib.js': 'export {};\n',
    });
    expect(graph.closure([runner], graph.testDependencies)).toEqual(['scripts/migrations/001-first.js', runner]);
  });
});
