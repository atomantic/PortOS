/**
 * Contract for the graph-key mint in `staticImportGraph.js`.
 *
 * The keys are built two different ways — `listModuleFiles` concatenates
 * directory entry names, `buildStaticImportGraph` derives them from a resolved
 * absolute path via `path.relative` — and they are compared with `Set.has`. On
 * POSIX both spell a subdirectory module `identity/goals.js`, so a mismatch is
 * invisible there; on Windows `path.relative` spells it `identity\goals.js`,
 * every edge INTO a subdirectory module fails the lookup, and the graph loses
 * them silently. That is not a loud failure: an acyclicity guard built on the
 * graph then passes VACUOUSLY (a ring through a subdirectory module is
 * unreachable), while a "this leaf must import the declaring module" assertion
 * fails for a reason that has nothing to do with the leaf (#5909).
 *
 * The subdirectory-edge assertions below are the ones that would have caught
 * it. They pass on POSIX either way — the defect is Windows-only — so CI's
 * Windows job is where they earn their keep.
 */
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'url';
import { dirname, join, sep } from 'path';
import { buildStaticImportGraph, toModuleKey } from './staticImportGraph.js';

const SERVICES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'services');

describe('toModuleKey', () => {
  it('spells a native-separator relative path with forward slashes', () => {
    expect(toModuleKey(['identity', 'goals.js'].join(sep))).toBe('identity/goals.js');
    expect(toModuleKey(['a', 'b', 'c.js'].join(sep))).toBe('a/b/c.js');
  });

  it('leaves a top-level file and an already-posix path alone', () => {
    expect(toModuleKey('identity.js')).toBe('identity.js');
    expect(toModuleKey('identity/goals.js')).toBe('identity/goals.js');
  });
});

describe('buildStaticImportGraph — subdirectory modules are reachable (#5909)', () => {
  const graph = buildStaticImportGraph(SERVICES_DIR);
  const keys = [...graph.keys()];
  const edges = [...graph.values()].flat();

  it('sees the whole services graph', () => {
    // Guards every assertion below from passing vacuously on an empty scan.
    expect(graph.size, 'services graph looks empty — did the scan root move?').toBeGreaterThan(100);
  });

  it('keys every module with forward slashes, including nested ones', () => {
    expect(keys.filter(key => key.includes('/')).length,
      'no nested module keys — the recursive walk stopped at the top level').toBeGreaterThan(0);
    expect(keys.filter(key => key.includes('\\')),
      'a graph key kept a native path separator').toEqual([]);
  });

  it('records edges that TARGET a nested module, not just edges between top-level ones', () => {
    // The Windows defect: `known` holds `identity/goals.js` while the resolver
    // produces `identity\goals.js`, so this list comes back empty and every
    // subdirectory dependency vanishes from the graph.
    const nested = edges.filter(dep => dep.includes('/'));
    expect(nested.length,
      'no edge targets a nested module — the resolver and the key mint disagree').toBeGreaterThan(0);
    expect(edges.filter(dep => dep.includes('\\')),
      'an edge kept a native path separator').toEqual([]);
  });
});
