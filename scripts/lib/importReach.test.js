/**
 * Dynamic-aware reach contract (#12285): a lazy `import()` is invisible to the
 * static proxy but links modules for `vitest related` selection, so the report
 * must count it — and the CI plan summary must show it without changing what
 * runs.
 */

import { describe, expect, it } from 'vitest';
import { buildImportGraph, formatReachSummary, importReachReport } from './importReach.js';
import { buildCiTestPlan } from '../ci-test-plan.js';

const SOURCES = new Map([
  ['svc/caller.js', [
    "import { leaf } from './leaf.js';",
    '// await import(\'./ghost.js\') in a comment is not an edge',
    "export const load = (name) => import(`./${name}.js`);",
    "export async function rare() { return (await import('./heavy.js')).run(); }",
    "/* lazy */ export const lazyLeaf = () => import('./lazyLeaf.js');",
    "export const tagged = () => import(/* webpackChunkName: x */ './taggedLeaf.js');",
    "export const gen = {\n  *walk() { return import('./genLeaf.js'); }\n};",
  ].join('\n')],
  ['svc/heavy.js', "import { core } from './core.js';\nexport const run = () => core;\n"],
  ['svc/core.js', 'export const core = 1;\n'],
  ['svc/leaf.js', 'export const leaf = 1;\n'],
  ['svc/lazyLeaf.js', 'export const a = 1;\n'],
  ['svc/taggedLeaf.js', 'export const c = 1;\n'],
  ['svc/genLeaf.js', 'export const b = 1;\n'],
  ['svc/ghost.js', 'export const ghost = 1;\n'],
  ['svc/caller.test.js', "import { load } from './caller.js';\n"],
  ['svc/core.test.js', "import { core } from './core';\n"],
]);
const isTest = (rel) => rel.endsWith('.test.js');
const graph = buildImportGraph([...SOURCES.keys()], (rel) => SOURCES.get(rel) ?? null);

describe('importReachReport', () => {
  it('counts a dynamic edge for selection while the static view stops at it', () => {
    expect([...graph.get('svc/caller.js').dynamic]).toEqual(['svc/heavy.js', 'svc/lazyLeaf.js', 'svc/taggedLeaf.js', 'svc/genLeaf.js']);
    const { rows, selected } = importReachReport(graph, ['svc/core.js', 'svc/heavy.js', 'svc/ghost.js'], isTest);
    expect(rows).toEqual([
      // core.test.js resolves `./core` without an extension, like Vite.
      { source: 'svc/core.js', staticReach: 1, dynamicReach: 2 },
      { source: 'svc/heavy.js', staticReach: 0, dynamicReach: 1 },
      // A comment-only line and a computed specifier add no edge.
      { source: 'svc/ghost.js', staticReach: 0, dynamicReach: 0 },
    ]);
    expect(selected).toBe(2);
  });
});

describe('CI plan summary', () => {
  const serverReach = importReachReport(graph, ['svc/core.js'], isTest);
  const trackedFiles = ['server/services/core.js', 'server/services/core.test.js', 'server/index.js'];

  it('appends the widest changed source to a related server plan', () => {
    expect(formatReachSummary(serverReach)).toBe('dynamic-aware fan-out 2 suite(s): svc/core.js 2 (static 1)');
    const plan = buildCiTestPlan(['server/services/core.js'], { trackedFiles, serverReach });
    expect(plan.server.mode).toBe('related');
    expect(plan.suiteReasons.server).toMatch(/; dynamic-aware fan-out 2 suite\(s\): svc\/core\.js 2 \(static 1\)$/);
    const without = buildCiTestPlan(['server/services/core.js'], { trackedFiles });
    expect(plan.server).toEqual(without.server);
  });

  it('leaves a full plan reason alone', () => {
    const plan = buildCiTestPlan(['server/services/core.js'], { trackedFiles, serverReach, forceFull: true });
    expect(plan.suiteReasons.server).not.toContain('dynamic-aware');
  });
});
