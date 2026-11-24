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

describe('suiteClosure', () => {
  const tree = {
    'svc/subject.js': "import { hub } from './hub.js';\nexport const run = () => hub();\n",
    'svc/hub.js': "import './deep.js';\nexport const hub = () => import('./lazy.js');\n",
    'svc/deep.js': 'export {};\n',
    'svc/lazy.js': 'export {};\n',
    'svc/other.js': 'export {};\n',
  };
  const closureOf = (test, extra = {}) => graphOf({ ...tree, ...extra, 'svc/subject.test.js': test }).suiteClosure('svc/subject.test.js');
  const SUBJECT = "import './subject.js';\n";
  const PRUNED = ['svc/hub.js', 'svc/subject.js', 'svc/subject.test.js'];
  const FULL = ['svc/deep.js', 'svc/hub.js', 'svc/lazy.js', 'svc/subject.js', 'svc/subject.test.js'];

  it('stops at a module the suite replaces with a sealed factory and keeps that module', () => {
    expect(closureOf(SUBJECT)).toEqual(FULL);
    expect(closureOf(`vi.mock('./hub.js', () => ({ hub: vi.fn() }));\n${SUBJECT}`)).toEqual(PRUNED);
    expect(closureOf(`vi.mock('./hub.js', async () => ({ hub: vi.fn() }));\n${SUBJECT}`)).toEqual(PRUNED);
  });

  it('keeps a pruned subtree another edge reaches', () => {
    expect(closureOf(`vi.mock('./hub.js', () => ({}));\nawait import('./deep.js');\n${SUBJECT}`)).toEqual(['svc/deep.js', ...PRUNED]);
  });

  it.each([
    ['an automock', "vi.mock('./hub.js');"],
    ['a spy mock', "vi.mock('./hub.js', { spy: true });"],
    ['a factory that receives importOriginal', "vi.mock('./hub.js', async (importOriginal) => ({ ...await importOriginal() }));"],
    ['a factory passed by name', "vi.mock('./hub.js', factory);"],
    ['a doMock, which is not hoisted', "vi.doMock('./hub.js', () => ({}));"],
    ['an importActual', "vi.mock('./hub.js', () => ({}));\nawait vi.importActual('./hub.js');"],
    ['a later unmock', "vi.mock('./hub.js', () => ({}));\nvi.doUnmock('./hub.js');"],
    ['an importActual of a computed path', "vi.mock('./hub.js', () => ({}));\nawait vi.importActual(path);"],
    ['a destructured importActual', "vi.mock('./hub.js', () => ({}));\nconst { importActual } = vi;"],
    ['a computed mock target', "vi.mock('./hub.js', () => ({}));\nvi.mock(path, factory);"],
    ['a query that names the real module', "vi.mock('./hub.js', () => ({}));\nawait import('./hub.js?real');"],
  ])('walks the full subtree past %s', (_label, mocks) => {
    expect(closureOf(`${mocks}\n${SUBJECT}`)).toEqual(FULL);
  });

  it('walks the full subtree when a fixture in the closure loads the module behind the mock', () => {
    const extra = { 'svc/fixture.js': "export const actual = () => vi.importActual('./hub.js');\n" };
    expect(closureOf(`vi.mock('./hub.js', () => ({}));\nimport './fixture.js';\n${SUBJECT}`, extra)).toEqual(['svc/deep.js', 'svc/fixture.js', ...FULL.slice(1)]);
  });

  it('follows a module only importActual names', () => {
    expect(closureOf("await vi.importActual('./other.js');\n")).toEqual(['svc/other.js', 'svc/subject.test.js']);
  });

  it('ignores a mock whose target does not resolve and fails closed on an unresolved edge', () => {
    expect(closureOf(`vi.mock('./gone.js', () => ({}));\n${SUBJECT}`)).toEqual(FULL);
    expect(closureOf(`vi.mock('./hub.js', () => ({}));\nimport './gone.js';\n${SUBJECT}`)).toBeNull();
    // Uncertainty behind the mock is uncertainty the suite cannot reach.
    const computed = { 'svc/deep.js': 'export const load = (name) => import(name);\n' };
    expect(closureOf(SUBJECT, computed)).toBeNull();
    expect(closureOf(`vi.mock('./hub.js', () => ({}));\n${SUBJECT}`, computed)).toEqual(PRUNED);
  });
});
