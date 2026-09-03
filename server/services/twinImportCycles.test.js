/**
 * Regression guard for the identity / digital-twin barrel back-edges (#5687).
 *
 * `digital-twin.js` and `identity.js` are pure re-export barrels over their
 * `digital-twin-*.js` / `identity/*.js` leaves. Three leaves used to import a
 * symbol back THROUGH the barrel instead of from the module that declares it
 * (`digitalTwinEvents`, `getChronotype`/`getLongevity`/`getGoals`), and because
 * each barrel transitively reaches those same leaves, every one-symbol forward
 * closed a static ESM ring. In a static cycle whichever member evaluates first
 * sees `undefined` for the others' bindings, so a top-level `const` derived
 * from an imported value anywhere in the ring becomes a boot-time TDZ crash —
 * and no behavior test notices until a boot-order change surfaces it.
 *
 * The rule is the one the agent cluster already documents: a barrel is a public
 * entry point for callers OUTSIDE the cluster (routes, tools); members of the
 * cluster must name the declaring module. Static edges only — `await import()`
 * is deferred to call time and cannot produce a load-time cycle.
 */

import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { buildStaticImportGraph, findImportCycles } from '../lib/staticImportGraph.js';

const SERVICES_DIR = dirname(fileURLToPath(import.meta.url));

// The two barrels plus the three leaves that used to reach back through them. A
// cycle anywhere in `server/services` is reported by the walk, but only one
// TOUCHING this cluster fails here — unrelated pre-existing cycles (meatspacePost,
// the pipeline autopilot ring) have their own issues.
const CLUSTER = [
  'digital-twin.js',
  'identity.js',
  'taste-questionnaire.js',
  'digital-twin-export.js',
  'digital-twin-avatar-bio.js',
];

// The declaring module each leaf must name, keyed by the barrel it must not.
const BACK_EDGES = [
  { leaf: 'taste-questionnaire.js', barrel: 'digital-twin.js', declaring: ['digital-twin-meta.js'], symbols: 'digitalTwinEvents' },
  { leaf: 'digital-twin-export.js', barrel: 'identity.js', declaring: ['identity/chronotype.js', 'identity/longevity.js', 'identity/goals.js'], symbols: 'getChronotype/getLongevity/getGoals' },
  { leaf: 'digital-twin-avatar-bio.js', barrel: 'identity.js', declaring: ['identity/goals.js'], symbols: 'getGoals' },
];

describe('identity / digital-twin cluster — no static import cycles (#5687)', () => {
  const graph = buildStaticImportGraph(SERVICES_DIR);

  it('sees the whole services graph', () => {
    // A resolver gap would make every negative assertion below pass vacuously.
    expect(graph.size, 'services graph looks empty — did the scan root move?').toBeGreaterThan(100);
    for (const module of CLUSTER) expect([...graph.keys()], `${module} is missing from the graph`).toContain(module);
  });

  it('has no static import cycle touching the identity / digital-twin cluster', () => {
    const offending = findImportCycles(graph).filter(cycle =>
      CLUSTER.some(module => cycle.split(' -> ').includes(module)));
    expect(offending, `static import cycle(s) reintroduced:\n${offending.join('\n')}`).toEqual([]);
  });

  it('keeps each cluster leaf naming the module that declares the symbol, never the barrel', () => {
    // Named directly so a reintroduced one-symbol import of a barrel fails with
    // the reason rather than as an opaque ring — and so the rule still holds if
    // some future edge happens not to close a cycle today.
    for (const { leaf, barrel, declaring, symbols } of BACK_EDGES) {
      const deps = graph.get(leaf) || [];
      expect(deps, `${leaf} must import ${symbols} from ${declaring.join(', ')} — not the ${barrel} barrel`).not.toContain(barrel);
      for (const module of declaring) expect(deps, `${leaf} must import from ${module}`).toContain(module);
    }
  });
});
