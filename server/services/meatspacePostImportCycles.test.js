/**
 * Regression guard for the MeatSpace POST service ring (#5690).
 *
 * `meatspacePost.js` used to import `getPostStats` from `meatspacePostStats.js`
 * and re-export both that symbol and `getPostRecommendations`, purely so
 * callers could write `import { getPostStats } from './meatspacePost.js'`.
 * Both analytics modules import `meatspacePost.js` back for their raw inputs,
 * so each convenience forward closed a static ESM ring. In a static cycle
 * whichever member evaluates first sees `undefined` for the others' bindings,
 * so any future top-level `const` derived from an imported value in the ring
 * becomes a boot-time TDZ crash — and no behavior test notices until a load
 * order change surfaces it.
 *
 * The layering the guard pins: `meatspacePost.js` owns raw sessions and ladder
 * level history, `meatspacePostStats.js` derives the aggregates from it, and
 * `meatspacePostAdaptive.js` / `meatspacePostRecommendations.js` sit above BOTH
 * as the policy layer. Edges only ever point down, so a re-added re-export off
 * the data module fails here with the reason rather than as an opaque ring.
 */

import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { buildStaticImportGraph, findImportCycles } from '../lib/staticImportGraph.js';

const SERVICES_DIR = dirname(fileURLToPath(import.meta.url));

const DATA_MODULE = 'meatspacePost.js';
// Every POST module that participates in the stats/recommendation/adaptive
// layering. A cycle anywhere in `server/services` is reported by the walk, but
// only one TOUCHING this cluster fails here — unrelated pre-existing cycles
// (the pipeline autopilot ring) have their own issues.
const CLUSTER = [
  DATA_MODULE,
  'meatspacePostStats.js',
  'meatspacePostRecommendations.js',
  'meatspacePostAdaptive.js',
];

// The data module must not reach UP into the layers built on top of it — the
// exact edges (a plain import, or an `export … from` re-export) that closed the
// two rings this guard exists for.
const FORBIDDEN_UPWARD_EDGES = CLUSTER.filter(module => module !== DATA_MODULE);

describe('MeatSpace POST services — no static import cycles (#5690)', () => {
  const graph = buildStaticImportGraph(SERVICES_DIR);

  it('sees the whole services graph', () => {
    // A resolver gap would make every negative assertion below pass vacuously.
    expect(graph.size, 'services graph looks empty — did the scan root move?').toBeGreaterThan(100);
    for (const module of CLUSTER) expect([...graph.keys()], `${module} is missing from the graph`).toContain(module);
  });

  it('has no static import cycle touching the POST cluster', () => {
    const offending = findImportCycles(graph).filter(cycle =>
      CLUSTER.some(module => cycle.split(' -> ').includes(module)));
    expect(offending, `static import cycle(s) reintroduced:\n${offending.join('\n')}`).toEqual([]);
  });

  it('keeps meatspacePost.js from importing or re-exporting the layers above it', () => {
    const deps = graph.get(DATA_MODULE) || [];
    for (const module of FORBIDDEN_UPWARD_EDGES) {
      expect(
        deps,
        `${DATA_MODULE} must not depend on ${module} — that module reads raw POST data back out of it. Callers name the declaring module instead.`
      ).not.toContain(module);
    }
  });

  it('keeps the analytics layers naming the data module directly', () => {
    // The downward edges are the ones that SHOULD exist; asserting them keeps
    // the cycle assertion above from passing because an edge simply vanished.
    for (const module of ['meatspacePostStats.js', 'meatspacePostRecommendations.js', 'meatspacePostAdaptive.js']) {
      expect(graph.get(module) || [], `${module} must read its inputs from ${DATA_MODULE}`).toContain(DATA_MODULE);
    }
    expect(
      graph.get('meatspacePostAdaptive.js') || [],
      'meatspacePostAdaptive.js must read the adaptive signal from meatspacePostStats.js'
    ).toContain('meatspacePostStats.js');
    expect(
      graph.get('meatspacePostRecommendations.js') || [],
      'meatspacePostRecommendations.js must read getPostStats from meatspacePostStats.js'
    ).toContain('meatspacePostStats.js');
  });
});
