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
import { dirname, join } from 'path';

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
];

// Matches `import … from './x.js'`, `export … from './x.js'`, and bare
// `import './x.js'` at the start of a line. Deliberately does NOT match
// `await import('./x.js')` (dynamic) or the same string inside a comment,
// because a comment never starts with `import`/`export`.
const STATIC_FROM = /^\s*(?:import|export)\b[^;]*?from\s*['"]\.\/([\w.\-/]+\.js)['"]/gm;
const STATIC_BARE = /^\s*import\s*['"]\.\/([\w.\-/]+\.js)['"]/gm;

function buildStaticGraph() {
  const files = readdirSync(SERVICES_DIR).filter(f => f.endsWith('.js') && !f.includes('.test.'));
  const known = new Set(files);
  const graph = new Map();
  for (const file of files) {
    const src = readFileSync(join(SERVICES_DIR, file), 'utf-8');
    const deps = new Set();
    for (const re of [STATIC_FROM, STATIC_BARE]) {
      re.lastIndex = 0;
      let match;
      while ((match = re.exec(src)) !== null) {
        if (known.has(match[1])) deps.add(match[1]);
      }
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

  it('no longer needs the dynamic-import workaround for handleOrphanedTask', () => {
    // The cycle-dodge this issue was filed for: agentLifecycle reached
    // agentManagement via `await import()` because agentManagement imported it back.
    const src = readFileSync(join(SERVICES_DIR, 'agentLifecycle.js'), 'utf-8');
    expect(src).not.toMatch(/await import\(\s*['"]\.\/agentManagement\.js['"]\s*\)/);
    expect(src).toMatch(/import \{ handleOrphanedTask \} from '\.\/agentManagement\.js';/);
  });
});
