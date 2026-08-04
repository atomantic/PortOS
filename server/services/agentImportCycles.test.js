/**
 * Regression guard for the agent-lifecycle circular-dependency cluster (#2837).
 *
 * The cluster — agentLifecycle / agentCliSpawning / agentTuiSpawning /
 * agentManagement / subAgentSpawner / cosAgents — used to contain two real
 * STATIC cycles plus three `await import(...)` workarounds whose only job was to
 * dodge the load-time cycle. Both were fixed by extracting the shared pieces
 * (finalize, summary extraction, runner sync, runner output batchers) into leaf
 * modules that nothing in the cluster is imported BY.
 *
 * This test re-derives the static import graph of `server/services` from source
 * and asserts the cluster is acyclic. It scans STATIC imports/re-exports only —
 * `await import()` is deferred to call time and therefore harmless for module
 * initialization order; a static cycle is what produces TDZ/undefined-binding
 * failures at boot.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, relative, resolve } from 'path';
import { staticImportSpecifiers } from '../lib/staticImportGraph.js';

const SERVICES_DIR = dirname(fileURLToPath(import.meta.url));

// The modules the #2837 audit named, plus the leaf modules extracted to break
// the cycle. A cycle anywhere in `server/services` will be reported, but only a
// cycle TOUCHING one of these fails the assertion — unrelated pre-existing
// cycles elsewhere are out of scope for this guard.
const CLUSTER = [
  'agentLifecycle.js',
  'agentCliSpawning.js',
  'agentTuiSpawning.js',
  'agentManagement.js',
  'subAgentSpawner.js',
  'cosAgents.js',
  'cosAgentLifecycle.js',
  'agentFinalization.js',
  'agentSummaryExtraction.js',
  'agentRunnerSync.js',
  'agentRunnerOutputBatchers.js',
  'agentOrchestrator.js',
];

// The static-import scan itself lives in `server/lib/staticImportGraph.js` so
// this guard and the sprites sharp-free guard share ONE parser — two copies is
// how a structural guard rots (a fix to one silently under-reports in the
// other). It matches static `import`/`export … from` and bare side-effect
// imports only, never `await import()` (deferred to call time, so it can't
// produce a load-time cycle) and never a specifier inside a comment.
// Every non-test `.js` under SERVICES_DIR, keyed by its path relative to that
// directory (`agentLifecycle.js`, `agentTuiSpawning/outputSpooler.js`). The
// walk recurses: scanning only top-level files left a hole big enough to drive
// the cycle back through, because a subdirectory module can import back up
// (`agentTuiSpawning/outputSpooler.js` → `../cosAgents.js` is a live example),
// so a cycle routed through one subdirectory hop was invisible to this guard.
function listServiceFiles(dir = SERVICES_DIR, prefix = '') {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listServiceFiles(join(dir, entry.name), rel));
    else if (entry.name.endsWith('.js') && !entry.name.includes('.test.')) out.push(rel);
  }
  return out;
}

function buildStaticGraph() {
  const files = listServiceFiles();
  const known = new Set(files);
  const graph = new Map();
  for (const file of files) {
    const abs = join(SERVICES_DIR, file);
    const deps = new Set();
    for (const spec of staticImportSpecifiers(abs)) {
      if (!spec.startsWith('.')) continue;
      // Resolve relative to the importing file, then re-key against SERVICES_DIR
      // so `./x.js` from a subdirectory and `../x.js` from a sibling land on the
      // same node. Anything resolving outside the services dir is out of scope.
      const rel = relative(SERVICES_DIR, resolve(dirname(abs), spec));
      if (known.has(rel)) deps.add(rel);
    }
    graph.set(file, [...deps]);
  }
  return graph;
}

function findCycles(graph) {
  const cycles = new Set();
  const stack = [];
  const state = new Map(); // 1 = on stack, 2 = done
  const visit = (node) => {
    state.set(node, 1);
    stack.push(node);
    for (const dep of graph.get(node) || []) {
      if (state.get(dep) === 1) {
        cycles.add(stack.slice(stack.indexOf(dep)).concat(dep).join(' -> '));
      } else if (!state.has(dep)) {
        visit(dep);
      }
    }
    stack.pop();
    state.set(node, 2);
  };
  for (const node of graph.keys()) if (!state.has(node)) visit(node);
  return [...cycles];
}

describe('agent lifecycle cluster — no static import cycles (#2837)', () => {
  const graph = buildStaticGraph();

  it('has no static import cycle touching the agent-lifecycle cluster', () => {
    const offending = findCycles(graph).filter(cycle => CLUSTER.some(m => cycle.includes(m)));
    expect(offending, `static import cycle(s) reintroduced:\n${offending.join('\n')}`).toEqual([]);
  });

  it('keeps the extracted leaves free of back-edges into the cluster orchestrators', () => {
    // These four exist ONLY to be depended on. If any of them grows an import of
    // an orchestrator, the cycle comes straight back — fail loudly and early
    // rather than waiting for the graph walk above to go red for a subtler reason.
    const orchestrators = ['agentLifecycle.js', 'agentCliSpawning.js', 'agentTuiSpawning.js', 'agentManagement.js', 'subAgentSpawner.js'];
    for (const leaf of ['agentFinalization.js', 'agentSummaryExtraction.js', 'agentRunnerSync.js', 'agentRunnerOutputBatchers.js']) {
      const back = (graph.get(leaf) || []).filter(dep => orchestrators.includes(dep));
      expect(back, `${leaf} must not import ${back.join(', ')}`).toEqual([]);
    }
  });

  it('keeps the agentOrchestrator facade outside the graph it fronts (#3450)', () => {
    // The facade only stays a facade while its edges point one way: it imports
    // the cluster, the cluster never imports it back.
    //
    // The forbidden set is derived, not listed. It is everything reachable FROM
    // the facade — an import back from any of those closes a loop, and the set
    // grows on its own as the cluster does, so it can't fall behind the way a
    // hand-maintained list of seven names would (that list omitted
    // agentCliSpawning/agentTuiSpawning, both reachable via agentLifecycle).
    // Modules outside the closure may import the facade freely: they close no
    // loop, and forbidding them would freeze the remaining call-site migrations.
    const reachable = new Set();
    const walk = (node) => {
      for (const dep of graph.get(node) || []) {
        if (reachable.has(dep)) continue;
        reachable.add(dep);
        walk(dep);
      }
    };
    walk('agentOrchestrator.js');
    expect(reachable.size, 'facade closure looks empty — did the module move?').toBeGreaterThan(3);

    // Dynamic imports are matched too, and WITHOUT requiring `await`: the static
    // graph deliberately ignores `import()` (correct for cycle detection), but
    // reaching across a blocked layer with a deferred import is exactly this
    // cluster's habit, so a `return import(...).then(...)` back-edge would
    // violate the layering with the cycle walk fully green. Any relative
    // specifier ending in `agentOrchestrator.js` counts, from any depth.
    const DYNAMIC_FACADE_IMPORT = /\bimport\(\s*['"][^'"]*\bagentOrchestrator\.js['"]\s*\)/;
    const offenders = [...reachable].filter(file =>
      (graph.get(file) || []).includes('agentOrchestrator.js') ||
      DYNAMIC_FACADE_IMPORT.test(readFileSync(join(SERVICES_DIR, file), 'utf-8'))
    ).sort();
    expect(offenders, `agentOrchestrator.js must not be imported by ${offenders.join(', ')}`).toEqual([]);
  });

  it('no longer needs the dynamic-import workaround for handleOrphanedTask', () => {
    // The cycle-dodge this issue was filed for: agentLifecycle reached
    // agentManagement via `await import()` because agentManagement imported it back.
    const src = readFileSync(join(SERVICES_DIR, 'agentLifecycle.js'), 'utf-8');
    expect(src).not.toMatch(/await import\(\s*['"]\.\/agentManagement\.js['"]\s*\)/);
    expect(src).toMatch(/import \{ handleOrphanedTask \} from '\.\/agentManagement\.js';/);
  });
});
